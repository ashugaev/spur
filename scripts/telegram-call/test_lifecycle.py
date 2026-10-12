import asyncio
import re
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from google.genai import types
from ntgcalls import Protocol
from pytgcalls.mtproto.telethon_client import TelethonClient
from pytgcalls.types import Device, Direction, StreamFrames
from telethon import TelegramClient
from telethon.tl.functions.phone import AcceptCallRequest
from telethon.tl.types import InputPhoneCall

import bridge


class Live:
    def __init__(self):
        self.events = asyncio.Queue()
        self.input = AsyncMock()
        self.send_realtime_input = self.input
        self.send_tool_response = AsyncMock()
        self.send_client_content = AsyncMock()
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        self.closed = True

    async def receive(self):
        while True:
            event = await self.events.get()
            if event is None:
                return
            yield event


def audio(*chunks, interrupted=False, complete=False, tool=None, mime="audio/pcm;rate=24000"):
    return types.LiveServerMessage(
        server_content=types.LiveServerContent(
            interrupted=interrupted, turn_complete=complete,
            model_turn=types.Content(parts=[types.Part(inline_data=types.Blob(data=c, mime_type=mime))
                                           for c in chunks]) if chunks else None),
        tool_call=types.LiveServerToolCall(function_calls=[tool]) if tool else None)


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = bridge.guarded_client_class()(None, 1, "private")
        self.runtime = SimpleNamespace(check=AsyncMock())
        self.client.voice_runtime = self.runtime
        self.adapter = TelethonClient(60, self.client)
        self.adapter._cache.set_cache(33, InputPhoneCall(11, 22))
        self.protocol = Protocol(65, 92, True, True, ["native"])
        self.network = AsyncMock(return_value="ok")
        self.forward = patch.object(TelegramClient, "_call", self.network)
        self.forward.start()
        self.addCleanup(self.forward.stop)

    def fixture(self, spawned=True):
        call = bridge.Call(bridge.Peer(11, 22), 33, time.monotonic())
        self.client.current_call = call
        live = Live()
        shepherd = bridge.Shepherd(self.runtime, None)
        shepherd.request = AsyncMock(return_value={})

        async def prepare(target):
            target.session, target.spawned, target.ready = "owned", spawned, True

        shepherd.prepare = prepare
        connected = asyncio.Event()

        async def play(user, stream):
            await self.adapter.accept_call(user, b"key", self.protocol)

        async def record(user, stream):
            connected.set()

        calls = SimpleNamespace(play=play, record=AsyncMock(side_effect=record),
                                leave_call=AsyncMock(), send_frame=AsyncMock())
        gemini = SimpleNamespace(aio=SimpleNamespace(live=SimpleNamespace(connect=lambda **kwargs: live)))
        listener = bridge.Listener({"GEMINI_LIVE_MODEL": "configured"}, self.runtime,
                                  self.client, calls, shepherd, gemini, types, 60000)
        listener.current = call
        return SimpleNamespace(call=call, live=live, shepherd=shepherd, connected=connected,
                               calls=calls, listener=listener)

    async def test_accept_failures_cleanup_and_actual_sdk_cache_races(self):
        for mode in ("new_rejected", "reused_rejected", "generation", "expired", "setup", "setup_timeout"):
            with self.subTest(mode=mode):
                f = self.fixture(spawned=mode != "reused_rejected")
                self.runtime.check.reset_mock(side_effect=True)
                self.network.reset_mock(side_effect=True)
                if mode.endswith("rejected"):
                    async def reject(sender, rpc, *args, **kwargs):
                        if isinstance(rpc, AcceptCallRequest):
                            raise RuntimeError("provider rejected")
                    self.network.side_effect = reject
                elif mode == "generation":
                    self.runtime.check.side_effect = [None, None, bridge.BridgeError("runtime_replaced"), None]
                elif mode == "expired":
                    f.call.received -= 60
                elif mode in ("setup", "setup_timeout"):
                    if mode == "setup_timeout":
                        f.listener.ring_ms = 5100
                        f.live.__class__.__aenter__ = AsyncMock(side_effect=asyncio.Event().wait)
                    else:
                        f.live.__class__.__aenter__ = AsyncMock(side_effect=RuntimeError("setup failed"))
                try:
                    with patch("bridge.event") as events:
                        await asyncio.wait_for(f.listener.run_call(f.call), 1)
                    self.assertFalse(f.call.accepted)
                    self.assertFalse(f.calls.record.called)
                    self.assertFalse(f.calls.leave_call.called)
                    killed = [a.args[1] for a in f.shepherd.request.await_args_list]
                    self.assertEqual(killed, [] if mode in ("reused_rejected", "expired") else ["/sessions/owned/kill"])
                    ended = [a for a in events.call_args_list if a.args == ("call_ended",)]
                    self.assertFalse(ended[0].kwargs["sandbox_jobs_retained"])
                finally:
                    if mode in ("setup", "setup_timeout"):
                        del f.live.__class__.__aenter__
                        f.live.__class__.__aenter__ = live_enter

        self.runtime.check.reset_mock(side_effect=True)
        self.network.reset_mock(side_effect=True)
        call = bridge.Call(bridge.Peer(11, 22), 33, 0, ready=True, gemini=True, accept_permission=True)
        self.client.current_call = call
        # Await the SDK's real peer lookup, replace its same-user cache, then resume.
        lookup = self.adapter._cache.get_input_call
        for method in ("accept", "discard"):
            entered, release = asyncio.Event(), asyncio.Event()
            self.adapter._cache.set_cache(33, InputPhoneCall(11, 22))
            async def delayed(user):
                entered.set()
                await release.wait()
                return await lookup(user)
            async def invoke():
                with bridge.pinned(call):
                    if method == "accept":
                        return await self.adapter.accept_call(33, b"key", self.protocol)
                    return await self.adapter.discard_call(33, False)
            with patch.object(self.adapter._cache, "get_input_call", delayed):
                task = asyncio.create_task(invoke())
                await entered.wait()
                self.adapter._cache.set_cache(33, InputPhoneCall(55, 66))
                release.set()
                with self.assertRaisesRegex(bridge.BridgeError, "call_peer_changed"):
                    await task
        self.assertFalse(self.network.called)
        # A remote discard during the guard's awaited generation check also forbids acceptance.
        async def discarded():
            call.alive = False
        self.runtime.check.side_effect = discarded
        self.adapter._cache.set_cache(33, InputPhoneCall(11, 22))
        with bridge.pinned(call), self.assertRaisesRegex(bridge.BridgeError, "call_not_ready"):
            await self.adapter.accept_call(33, b"key", self.protocol)
        self.assertFalse(self.network.called)

    async def test_duplex_multipart_tools_interruption_and_shutdown(self):
        f = self.fixture()
        blocked, cancelled, played = asyncio.Event(), asyncio.Event(), asyncio.Event()
        sends = []
        async def send(user, device, frame):
            if frame.startswith(b"A"):
                blocked.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.set()
            sends.append((time.monotonic(), frame))
            if len(sends) == 2:
                played.set()
        f.calls.send_frame.side_effect = send
        nonce = None
        completed = asyncio.Event()
        async def request(method, path, body):
            nonlocal nonce
            nonce = re.search(r"VOICE_RESULT:([a-f0-9]+)", body["message"])[1]
            return {"id": "owned"}
        async def transcript(session, cursor=0):
            text = "VOICE_RESULT:" + nonce + "\nWorker dispatched.\nVOICE_END:" + nonce if nonce else ""
            return {"startIndex": 0, "totalEntries": int(bool(nonce)),
                    "entries": [{"kind": "message", "role": "assistant", "text": text}] if nonce else [],
                    "state": "waiting" if completed.is_set() else "working"}
        f.shepherd.request.side_effect = request
        f.shepherd.transcript = transcript
        f.call.task = asyncio.create_task(f.listener.run_call(f.call))
        await asyncio.wait_for(f.connected.wait(), 1)
        fn = types.FunctionCall(id="operator1", name="ask_shepherd", args={"message": "launch worker"})
        await f.live.events.put(audio(b"A" * 481, b"A" * 961, tool=fn))
        await asyncio.wait_for(blocked.wait(), 1)
        await f.listener.frames(None, StreamFrames(33, Direction.INCOMING, Device.MICROPHONE,
                                                 [SimpleNamespace(frame=b"I" * 320)]))
        await f.live.events.put(audio(interrupted=True))
        await asyncio.wait_for(cancelled.wait(), 1)
        await f.live.events.put(audio(b"N" * 960, complete=True))
        await asyncio.wait_for(played.wait(), 1)
        self.assertEqual([frame for _, frame in sends], [b"N" * 480] * 2)
        self.assertGreaterEqual(sends[1][0] - sends[0][0], .007)
        self.assertEqual(f.live.input.await_args.kwargs["audio"].data, b"I" * 320)
        self.assertEqual(f.live.input.await_args.kwargs["audio"].mime_type, "audio/pcm;rate=16000")
        receipt = f.live.send_tool_response.await_args.kwargs["function_responses"][0]
        self.assertEqual((receipt.id, receipt.name, receipt.response["status"]),
                         ("operator1", "ask_shepherd", "dispatched"))
        self.assertFalse(f.live.send_client_content.called)
        completed.set()
        for _ in range(60):
            if f.live.send_client_content.called:
                break
            await asyncio.sleep(.01)
        self.assertEqual(f.live.send_client_content.await_args.kwargs["turns"].parts[0].text,
                         "Shepherd result: Worker dispatched.")
        f.call.task.cancel()
        await asyncio.wait_for(f.call.task, 1)
        self.assertTrue(f.live.closed)
        self.assertIsNone(f.listener.current)
        f.calls.leave_call.assert_awaited_once()
        self.assertEqual(len(sends), 2)
        for response in (audio(b"bad", mime="audio/wav"),
                         types.LiveServerMessage(go_away=types.LiveServerGoAway()), None):
            with self.subTest(response=response):
                f = self.fixture()
                f.call.task = asyncio.create_task(f.listener.run_call(f.call))
                await asyncio.wait_for(f.connected.wait(), 1)
                await f.live.events.put(response)
                await asyncio.wait_for(f.call.task, 1)
                self.assertTrue(f.live.closed)
                self.assertIsNone(f.listener.current)


live_enter = Live.__aenter__

if __name__ == "__main__":
    unittest.main()
