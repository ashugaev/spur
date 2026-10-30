import asyncio
import contextlib
import os
from pathlib import Path
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from google.genai import types
import httpx
from ntgcalls import Protocol
from pytgcalls.mtproto.telethon_client import TelethonClient
from pytgcalls.types import Device, Direction, StreamFrames
from telethon import TelegramClient
from telethon.tl.functions.phone import AcceptCallRequest
from telethon.tl.types import InputPhoneCall, PhoneCallProtocol, PhoneCallRequested, UpdatePhoneCall

import bridge


def notices():
    return {name: bytes([index + 1]) * 480 for index, name in enumerate(bridge.NOTICE_NAMES)}


def offline_calls(client):
    from pytgcalls import PyTgCalls
    calls = PyTgCalls(client)
    calls.send_frame = AsyncMock()
    return calls


class Live:
    def __init__(self):
        self.events = asyncio.Queue()
        self.input = AsyncMock()
        self.send_realtime_input = self.input
        self.send_tool_response = AsyncMock()
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
        self.runtime = SimpleNamespace(url="http://127.0.0.1:49001", generation="generation", check=AsyncMock())
        self.client.voice_runtime = self.runtime
        self.client.is_connected = Mock(return_value=True)
        self.adapter = TelethonClient(60, self.client)
        self.adapter._cache.set_cache(33, InputPhoneCall(11, 22))
        self.protocol = Protocol(65, 92, True, True, ["native"])
        self.network = AsyncMock(return_value="ok")
        self.forward = patch.object(TelegramClient, "_call", self.network)
        self.forward.start()
        self.addCleanup(self.forward.stop)

    def fixture(self):
        call = bridge.Call(bridge.Peer(11, 22), 33, time.monotonic())
        self.client.current_call = call
        live = Live()
        requests = []
        def transport(request):
            requests.append((request.method, request.url.path))
            if request.url.path == "/projects":
                return httpx.Response(200, json=[{"id": project, "name": project, "configured": True}
                                                for project in bridge.PROJECTS])
            if request.url.path == "/sessions" and request.method == "GET":
                return httpx.Response(200, json=[], headers={"x-spur-lifecycle-instance-id": "generation"})
            return httpx.Response(200, json={"id": "owned", "project": "voice-sandbox", "agent": "codex",
                                           "status": "spawning", "state": "working", "runtimeAlive": False})
        http = httpx.AsyncClient(transport=httpx.MockTransport(transport))
        self.addAsyncCleanup(http.aclose)
        daemon = bridge.AgentDaemon(self.runtime, http)
        daemon.perform = AsyncMock(wraps=daemon.perform)
        connected = asyncio.Event()

        async def play(user, stream):
            await self.adapter.accept_call(user, b"key", self.protocol)

        async def record(user, stream):
            connected.set()

        calls = offline_calls(self.client)
        self.addCleanup(calls.executor.shutdown, wait=False)
        calls.play, calls.record = play, AsyncMock(side_effect=record)
        gemini = SimpleNamespace(aio=SimpleNamespace(live=SimpleNamespace(connect=lambda **kwargs: live)))
        listener = bridge.Listener({"GEMINI_LIVE_MODEL": "configured"}, self.runtime,
                                  self.client, calls, daemon, gemini, types, 60000, notices())
        listener.current = call
        return SimpleNamespace(call=call, live=live, daemon=daemon, connected=connected,
                               calls=calls, listener=listener, requests=requests)

    async def test_accept_failures_cleanup_and_actual_sdk_cache_races(self):
        for mode in ("rejected", "generation", "expired", "setup", "setup_timeout"):
            with self.subTest(mode=mode):
                f = self.fixture()
                self.runtime.check.reset_mock(side_effect=True)
                self.network.reset_mock(side_effect=True)
                if mode == "rejected":
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
                        original_timeout = asyncio.timeout
                        with patch("bridge.asyncio.timeout", side_effect=lambda seconds:
                                   original_timeout(.03 if seconds == 180 else seconds)):
                            await asyncio.wait_for(f.listener.run_call(f.call), 1)
                    self.assertEqual(f.call.accepted, mode in ("setup", "setup_timeout"))
                    self.assertFalse(f.calls.record.called)
                    self.assertEqual(f.requests, [])
                    ended = [a for a in events.call_args_list if a.args == ("call_ended",)]
                    self.assertTrue(ended[0].kwargs["sandbox_jobs_retained"])
                finally:
                    if mode in ("setup", "setup_timeout"):
                        del f.live.__class__.__aenter__
                        f.live.__class__.__aenter__ = live_enter

        self.runtime.check.reset_mock(side_effect=True)
        self.network.reset_mock(side_effect=True)
        call = bridge.Call(bridge.Peer(11, 22), 33, 0, accept_permission=True)
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
        requested, release, receipt_ready = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def perform(*args):
            requested.set()
            await release.wait()
            return {"status": "submitted", "session": {"id": "owned", "state": "working"}}
        f.daemon.perform.side_effect = perform
        f.live.send_tool_response.side_effect = lambda **kwargs: receipt_ready.set()
        f.call.task = asyncio.create_task(f.listener.run_call(f.call))
        await asyncio.wait_for(f.connected.wait(), 1)
        f.calls.send_frame.reset_mock()
        sends.clear()
        played.clear()
        fn = types.FunctionCall(id="operator1", name="start_agent", args={"project": "voice-sandbox", "prompt": "work"})
        await f.live.events.put(audio(b"A" * 481, b"A" * 961, tool=fn))
        await asyncio.wait_for(blocked.wait(), 1)
        await asyncio.wait_for(requested.wait(), 1)
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
        f.live.send_tool_response.assert_not_awaited()
        release.set()
        await asyncio.wait_for(receipt_ready.wait(), 1)
        receipt = f.live.send_tool_response.await_args.kwargs["function_responses"][0]
        self.assertEqual((receipt.id, receipt.name, receipt.response["status"]),
                         ("operator1", "start_agent", "submitted"))
        f.call.task.cancel()
        await asyncio.wait_for(f.call.task, 1)
        self.assertTrue(f.live.closed)
        self.assertIsNone(f.listener.current)
        self.assertFalse(any(path.endswith("/kill") for _, path in f.requests))
        self.assertEqual(len(sends), 2)
        for response in (audio(b"bad", mime="audio/wav"),
                         types.LiveServerMessage(go_away=types.LiveServerGoAway()), None):
            with self.subTest(response=response):
                f = self.fixture()
                f.call.task = asyncio.create_task(f.listener.run_call(f.call))
                await asyncio.wait_for(f.connected.wait(), 1)
                f.calls.send_frame.reset_mock()
                await f.live.events.put(response)
                await asyncio.wait_for(f.call.task, 1)
                self.assertTrue(f.live.closed)
                self.assertIsNone(f.listener.current)

    async def test_buffered_receive_cancellation_prevents_queued_dispatch(self):
        for same_event in (False, True):
            with self.subTest(same_event=same_event):
                f = self.fixture()
                f.call.task = asyncio.create_task(f.listener.run_call(f.call))
                await asyncio.wait_for(f.connected.wait(), 1)
                f.calls.send_frame.reset_mock()
                sent = asyncio.Event()
                f.calls.send_frame.side_effect = lambda *args: sent.set()
                fn = types.FunctionCall(id="withdrawn", name="start_agent", args={"project": "voice-sandbox", "prompt": "work"})
                cancel = types.LiveServerToolCallCancellation(ids=["withdrawn"])
                message = types.LiveServerMessage(tool_call=types.LiveServerToolCall(function_calls=[fn]))
                if same_event:
                    message.tool_call_cancellation = cancel
                f.live.events.put_nowait(message)
                if not same_event:
                    f.live.events.put_nowait(types.LiveServerMessage(tool_call_cancellation=cancel))
                # Observe later input to prove receive consumed both buffered events.
                f.live.events.put_nowait(audio(b"N" * 480, complete=True))
                await asyncio.wait_for(sent.wait(), 1)
                f.calls.send_frame.assert_awaited_once()
                f.daemon.perform.assert_not_awaited()
                f.live.send_tool_response.assert_not_awaited()
                f.call.task.cancel()
                await asyncio.wait_for(f.call.task, 1)
        f = self.fixture()
        entered, release = asyncio.Event(), asyncio.Event()
        async def blocked_request(*args):
            entered.set()
            await release.wait()
            return {"status": "observed"}
        f.daemon.perform.side_effect = blocked_request
        f.call.task = asyncio.create_task(f.listener.run_call(f.call))
        await asyncio.wait_for(f.connected.wait(), 1)
        functions = [types.FunctionCall(id=name, name="list_agents", args={})
                     for name in ("first", "second")]
        f.live.events.put_nowait(types.LiveServerMessage(tool_call=types.LiveServerToolCall(function_calls=functions)))
        await asyncio.wait_for(entered.wait(), 1)
        await asyncio.sleep(0)
        self.assertEqual(f.daemon.perform.await_count, 1)
        release.set()
        for _ in range(100):
            if f.live.send_tool_response.await_count == 2:
                break
            await asyncio.sleep(.001)
        replies = [a.kwargs["function_responses"][0] for a in f.live.send_tool_response.await_args_list]
        self.assertEqual([(r.id, r.response["status"]) for r in replies],
                         [("second", "busy"), ("first", "observed")])
        f.call.task.cancel()
        await asyncio.wait_for(f.call.task, 1)

    async def test_main_voice_startup_shutdown_closes_http_without_agent_operations(self):
        order, connecting = [], asyncio.Event()
        runtime = SimpleNamespace(url="http://127.0.0.1:49001", check=AsyncMock())
        async def transport(request):
            order.append("unexpected_agent_request")
            return httpx.Response(200, json={})
        class HTTP(httpx.AsyncClient):
            async def __aexit__(self, *args):
                order.append("http_close")
                await super().__aexit__(*args)
        http = HTTP(transport=httpx.MockTransport(transport))
        class Client:
            connect, disconnect = AsyncMock(), AsyncMock()
            is_user_authorized = AsyncMock(return_value=True)
            set_receive_updates = AsyncMock()
            is_connected = Mock(return_value=True)
            async def run_until_disconnected(self):
                await asyncio.Event().wait()
            add_event_handler, remove_event_handler = Mock(), Mock()
            async def __call__(self, request):
                return SimpleNamespace(call_ring_timeout_ms=60000)
        client, lock = Client(), Mock()
        owner = None
        original_listener = bridge.Listener
        def listener_factory(*args):
            nonlocal owner
            owner = original_listener(*args)
            return owner
        async def start():
            phone = PhoneCallRequested(11, 22, None, 33, 44, b"key", PhoneCallProtocol(65, 92, []))
            await owner.raw(UpdatePhoneCall(phone))
            await asyncio.wait_for(connecting.wait(), 1)
        calls = offline_calls(self.client)
        self.addCleanup(calls.executor.shutdown, wait=False)
        calls.start, calls.play, calls.record = start, AsyncMock(), AsyncMock()
        calls.remove_handler = Mock(wraps=calls.remove_handler)
        class PendingLive:
            async def __aenter__(self):
                connecting.set()
                await asyncio.Event().wait()
        gemini = SimpleNamespace(aio=SimpleNamespace(aclose=AsyncMock(),
                    live=SimpleNamespace(connect=lambda **args: PendingLive())))
        with contextlib.ExitStack() as stack:
            for target, value in (
                ("bridge.check_dependencies", AsyncMock(return_value=notices())),
                ("bridge.read_inputs", Mock(return_value={"TG_API_ID": "1", "TG_API_HASH": "private",
                    "GEMINI_API_KEY": "private", "GEMINI_LIVE_MODEL": "configured", "allowed": {33}})),
                ("bridge.Runtime", Mock(return_value=runtime)),
                ("bridge.private_session", Mock(return_value=(lock, Path("private.session")))),
                ("bridge.guarded_client_class", Mock(return_value=lambda *args, **kwargs: client)),
                ("bridge.Listener", listener_factory), ("pytgcalls.PyTgCalls", Mock(return_value=calls)),
                ("google.genai.Client", Mock(return_value=gemini)), ("httpx.AsyncClient", Mock(return_value=http))):
                stack.enter_context(patch(target, value))
            stack.enter_context(patch("bridge.sys.argv", ["bridge.py"]))
            stack.enter_context(patch.dict(os.environ, {"TELEGRAM_CALL_RUNTIME_FILE": "offline",
                                "TELEGRAM_CALL_ENDPOINT_HELPER": "offline"}))
            stack.enter_context(patch.object(asyncio.get_running_loop(), "add_signal_handler",
                                side_effect=lambda signum, callback: callback()))
            await asyncio.wait_for(bridge.main(), 2)
        self.assertEqual(order, ["http_close"])
        self.assertIsNone(owner.current)
        client.disconnect.assert_awaited_once()
        client.remove_event_handler.assert_called_once()
        calls.remove_handler.assert_called_once()
        gemini.aio.aclose.assert_awaited_once()
        lock.close.assert_called_once()
        calls.play.assert_awaited_once()


live_enter = Live.__aenter__

if __name__ == "__main__":
    unittest.main()
