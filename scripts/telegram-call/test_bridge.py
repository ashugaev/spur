import asyncio
import contextlib
import datetime
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import bridge


def view(entries=(), state="waiting", start=0, total=None):
    return {"entries": list(entries), "state": state, "startIndex": start,
            "totalEntries": len(entries) + start if total is None else total}


def assistant(text):
    return {"kind": "message", "role": "assistant", "text": text}


class CoreTests(unittest.IsolatedAsyncioTestCase):
    async def test_result_requires_complete_exact_assistant_envelope_and_waiting(self):
        nonce = "fresh"
        final = assistant("VOICE_RESULT:fresh\nWorker dispatched.\nVOICE_END:fresh")
        replies = [view([assistant("VOICE_RESULT:fresh\nWorking")], "working", 2),
                   view([final], "working", 2),
                   view([{"kind": "tool", "text": final["text"]}], "waiting", 2),
                   view([final], "waiting", 2)]
        shepherd = bridge.Shepherd(None, None)
        shepherd.transcript = AsyncMock(side_effect=replies)
        call = bridge.Call(bridge.Peer(1, 2), 3, 0, session="owned")
        with patch("bridge.asyncio.sleep", new=AsyncMock()):
            self.assertEqual(await shepherd.answer(call, 2, nonce), "Worker dispatched.")
        self.assertEqual(shepherd.transcript.await_count, 4)
        self.assertEqual([args.args[1] for args in shepherd.transcript.await_args_list], [2] * 4)

    async def test_stale_nonce_partial_envelope_empty_and_tool_echo_fail(self):
        self.assertIsNone(bridge.result_body("VOICE_RESULT:old\nanswer\nVOICE_END:old", "new"))
        self.assertIsNone(bridge.result_body("VOICE_RESULT:new\nanswer", "new"))
        self.assertIsNone(bridge.result_body("VOICE_RESULT:new\n\nVOICE_END:new", "new"))
        self.assertIsNone(bridge.assistant_text({"kind": "reasoning", "text": "VOICE_READY:new"}))
        self.assertIsNone(bridge.assistant_text({"kind": "message", "role": "user", "text": "VOICE_READY:new"}))

    async def test_transcript_reset_and_terminal_state_fail(self):
        call = bridge.Call(bridge.Peer(1, 2), 3, 0, session="owned")
        for reply in (view([], start=0, total=0), view([], "rate_limited", start=2),
                      view([], "needs_input", start=2)):
            shepherd = bridge.Shepherd(None, None)
            shepherd.transcript = AsyncMock(return_value=reply)
            with self.assertRaises(bridge.BridgeError):
                await shepherd.answer(call, 2, "nonce")

    async def test_dispatch_prompt_has_exact_end_contract_and_pinned_session(self):
        shepherd = bridge.Shepherd(None, None)
        shepherd.transcript = AsyncMock(return_value=view([assistant("old")]))
        shepherd.request = AsyncMock(return_value={"id": "owned"})
        call = bridge.Call(bridge.Peer(1, 2), 3, 0, session="owned")
        cursor = await shepherd.dispatch(call, "launch one worker", "nonce")
        self.assertEqual(cursor, 1)
        args = shepherd.request.await_args.args
        self.assertEqual(args[:2], ("POST", "/sessions/owned/send"))
        prompt = args[2]["message"]
        self.assertIn("VOICE_RESULT:nonce", prompt)
        self.assertIn("VOICE_END:nonce", prompt)
        self.assertIn("claim completion only after checking worker result", prompt)

    async def test_readiness_ignores_echo_and_cancellation_kills_late_spawn(self):
        call = bridge.Call(bridge.Peer(1, 2), 3, 0)
        shepherd = bridge.Shepherd(None, None)
        started = asyncio.Event()
        released = asyncio.Event()

        async def request(method, path, body):
            if path == "/shepherd/spawn":
                started.set()
                await released.wait()
                return {"disposition": "spawned", "session": {"id": "late"}}
            return {}

        shepherd.request = AsyncMock(side_effect=request)
        task = asyncio.create_task(shepherd.prepare(call))
        await started.wait()
        task.cancel()
        released.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(shepherd.request.await_args_list[-1].args[:2], ("POST", "/sessions/late/kill"))

    async def test_readiness_only_fresh_assistant_token(self):
        shepherd = bridge.Shepherd(None, None)
        nonce = None

        async def request(method, path, body):
            nonlocal nonce
            nonce = body["prompt"].split("VOICE_READY:")[1]
            return {"disposition": "reused", "session": {"id": "owned"}}

        reads = 0

        async def transcript(session):
            nonlocal reads
            reads += 1
            return view([assistant("VOICE_READY:stale"),
                         {"kind": "message", "role": "user", "text": "VOICE_READY:" + nonce}]
                        + ([assistant("VOICE_READY:" + nonce)] if reads == 2 else []))

        shepherd.request = AsyncMock(side_effect=request)
        shepherd.transcript = AsyncMock(side_effect=transcript)
        call = bridge.Call(bridge.Peer(1, 2), 3, 0)
        with patch("bridge.asyncio.sleep", new=AsyncMock()):
            await shepherd.prepare(call)
        self.assertTrue(call.ready)
        self.assertFalse(call.spawned)
        self.assertEqual(reads, 2)

    async def test_pcm_rechunk_bounds_partial_samples_and_interruption(self):
        queue = bridge.PCM(960, 480)
        queue.put(bytes(477))
        queue.put(bytes(3))
        generation, frame = await queue.take()
        self.assertEqual(len(frame), 480)
        queue.put(bytes(12))
        queue.clear()
        self.assertNotEqual(generation, queue.generation)
        self.assertFalse(queue.data)
        with self.assertRaisesRegex(bridge.BridgeError, "audio_overflow"):
            queue.put(bytes(961))
        queue.put(b"x")
        with self.assertRaisesRegex(bridge.BridgeError, "incomplete_pcm_sample"):
            queue.finish()
        queue.put(b"y")
        queue.finish()
        self.assertEqual((await queue.take())[1], b"xy" + bytes(478))

    async def test_blocked_audio_take_cancels(self):
        queue = bridge.PCM(960, 480)
        task = asyncio.create_task(queue.take())
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_tool_receipt_is_dispatch_only_busy_and_late_result(self):
        delivered = asyncio.Event()
        shepherd = SimpleNamespace(dispatch=AsyncMock(return_value=4))

        async def answer(*args):
            await delivered.wait()
            return "One worker dispatched; completion unconfirmed."

        shepherd.answer = AsyncMock(side_effect=answer)
        live = SimpleNamespace(send_tool_response=AsyncMock(), send_client_content=AsyncMock())
        types = SimpleNamespace(FunctionResponse=lambda **args: args, Content=lambda **args: args,
                                Part=lambda **args: args)
        call = bridge.Call(bridge.Peer(1, 2), 3, 0, session="owned")
        tools = bridge.Tools(call, shepherd, live, types)
        fn = SimpleNamespace(id="fn1", name="ask_shepherd", args={"message": "launch"})
        await tools.handle(fn)
        receipt = live.send_tool_response.await_args.kwargs["function_responses"][0]
        self.assertEqual(receipt, {"id": "fn1", "name": "ask_shepherd",
                                  "response": {"status": "dispatched", "request_id": "fn1"}})
        self.assertFalse(live.send_client_content.called)
        await tools.handle(fn)
        self.assertEqual(live.send_tool_response.await_args.kwargs["function_responses"][0]["response"],
                         {"status": "busy"})
        task = tools.pending
        delivered.set()
        await task
        self.assertIn("Shepherd result:", live.send_client_content.await_args.kwargs["turns"]["parts"][0]["text"])
        self.assertTrue(live.send_client_content.await_args.kwargs["turn_complete"])

    async def test_tool_invalid_or_cancelled_never_speaks_result(self):
        live = SimpleNamespace(send_tool_response=AsyncMock(), send_client_content=AsyncMock())
        types = SimpleNamespace(FunctionResponse=lambda **args: args, Content=lambda **args: args,
                                Part=lambda **args: args)
        call = bridge.Call(bridge.Peer(1, 2), 3, 0, session="owned")
        async def blocked(*args):
            await asyncio.sleep(60)
        shepherd = SimpleNamespace(dispatch=AsyncMock(return_value=0), answer=AsyncMock(side_effect=blocked))
        tools = bridge.Tools(call, shepherd, live, types)
        await tools.handle(SimpleNamespace(id="a", name="shell", args={"message": "x"}))
        self.assertFalse(shepherd.dispatch.called)
        await tools.handle(SimpleNamespace(id="a", name="ask_shepherd", args={"message": "x"}))
        call.alive = False
        await tools.close()
        self.assertFalse(live.send_client_content.called)

    async def test_invalid_external_json_and_cursor_rejected(self):
        for value in ([], {}, view([], total=-1), view([assistant("x")], total=0)):
            with self.assertRaises(bridge.BridgeError):
                bridge.conversation(value)


@unittest.skipUnless(importlib.util.find_spec("telethon"), "install prototype requirements for native tests")
class NativeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from telethon import TelegramClient
        from pytgcalls.mtproto.telethon_client import TelethonClient
        self.client = bridge.guarded_client_class()(None, 1, "hash")
        self.client.voice_runtime = SimpleNamespace(check=AsyncMock())
        self.adapter = TelethonClient(60, self.client)
        self.network = AsyncMock(return_value="forwarded")
        self.network_patch = patch.object(TelegramClient, "_call", self.network)
        self.network_patch.start()
        self.addCleanup(self.network_patch.stop)
        self.call = bridge.Call(bridge.Peer(11, 22), 33, 0, ready=True, gemini=True, accept_permission=True)
        self.client.current_call = self.call

    def accept(self, peer=None):
        from telethon.tl.functions.phone import AcceptCallRequest
        from telethon.tl.types import InputPhoneCall, PhoneCallProtocol
        peer = peer or self.call.peer
        return AcceptCallRequest(InputPhoneCall(peer.id, peer.access_hash), b"key",
                                 PhoneCallProtocol(65, 92, ["native"], True, True))

    async def test_actual_pytgcalls_adapter_accepts_exact_once(self):
        with bridge.pinned(self.call):
            self.assertEqual(await self.adapter._invoke(self.accept()), "forwarded")
            with self.assertRaisesRegex(bridge.BridgeError, "call_not_ready"):
                await self.adapter._invoke(self.accept())
        self.assertEqual(self.network.await_count, 1)

    async def test_mutable_cache_replacement_discard_and_outbound_rpc_fail_closed(self):
        from telethon.tl.functions.phone import DiscardCallRequest, RequestCallRequest
        from telethon.tl.types import InputPhoneCall, InputUser, PhoneCallProtocol, PhoneCallDiscardReasonHangup
        replacement = bridge.Peer(55, 66)
        with bridge.pinned(self.call):
            for request in (self.accept(replacement),
                            DiscardCallRequest(InputPhoneCall(55, 66), 0, PhoneCallDiscardReasonHangup(), 0),
                            RequestCallRequest(InputUser(33, 44), b"key", PhoneCallProtocol(65, 92, []))):
                with self.assertRaises(bridge.BridgeError):
                    await self.adapter._invoke(request)
            self.call.alive = False
            with self.assertRaises(bridge.BridgeError):
                await self.adapter._invoke(self.accept())
        self.assertEqual(self.network.await_count, 0)

    async def test_batch_cannot_bypass_outgoing_guard(self):
        from telethon.tl.functions.phone import RequestCallRequest
        from telethon.tl.types import InputUser, PhoneCallProtocol
        with bridge.pinned(self.call):
            with self.assertRaises(bridge.BridgeError):
                await self.adapter._invoke([self.accept(), RequestCallRequest(
                    InputUser(33, 44), b"x", PhoneCallProtocol(65, 92, []))])
        self.assertFalse(self.network.called)
        self.assertFalse(self.call.accepted)

    async def test_lifecycle_waits_for_ready_then_accepts_and_cleans_media(self):
        from telethon.tl.functions.phone import DiscardCallRequest
        from telethon.tl.types import InputPhoneCall, PhoneCallDiscardReasonHangup
        ready = asyncio.Event()
        connected = asyncio.Event()
        wait = asyncio.Event()
        call = self.call
        call.received = bridge.time.monotonic()
        call.ready = False
        call.gemini = False
        call.accept_permission = False

        async def prepare(call):
            await ready.wait()
            call.ready = True

        async def play(user, stream):
            await self.adapter._invoke(self.accept())

        async def record(user, stream):
            connected.set()

        async def leave(user):
            await self.adapter._invoke(DiscardCallRequest(InputPhoneCall(11, 22), 0,
                                      PhoneCallDiscardReasonHangup(), 0))

        class Context:
            closed = False

            async def __aenter__(self):
                return SimpleNamespace()

            async def __aexit__(self, *args):
                self.closed = True

        context = Context()
        calls = SimpleNamespace(play=play, record=record, leave_call=AsyncMock(side_effect=leave),
                                send_frame=AsyncMock())
        shepherd = SimpleNamespace(prepare=prepare, stop_spawned=AsyncMock())
        gemini = SimpleNamespace(aio=SimpleNamespace(live=SimpleNamespace(connect=lambda **args: context)))
        listener = bridge.Listener({"GEMINI_LIVE_MODEL": "configured"},
                                  SimpleNamespace(check=AsyncMock()), self.client, calls, shepherd,
                                  gemini, SimpleNamespace(), 60000)
        listener.current = call
        call.task = asyncio.create_task(listener.run_call(call))
        await asyncio.sleep(.02)
        self.assertFalse(call.accepted)
        ready.set()
        await asyncio.wait_for(connected.wait(), 1)
        self.assertTrue(call.accepted)
        call.task.cancel()
        await call.task
        calls.leave_call.assert_awaited_once_with(33)
        self.assertTrue(context.closed)
        self.assertIsNone(listener.current)

    async def test_incoming_unauthorized_busy_duplicate_and_discard(self):
        from telethon.tl.types import PhoneCallRequested, PhoneCallProtocol, UpdatePhoneCall, PhoneCallDiscarded
        listener = bridge.Listener({"allowed": {33}}, None, self.client, None, None, None, None, 60000)
        wait = asyncio.Event()
        async def run_call(call):
            await wait.wait()
        listener.run_call = AsyncMock(side_effect=run_call)
        listener.discard = AsyncMock()
        def incoming(call_id, user):
            return UpdatePhoneCall(PhoneCallRequested(call_id, 22, datetime.datetime.now(), user,
                                   99, b"key", PhoneCallProtocol(65, 92, [])))
        await listener.raw(incoming(1, 34))
        await asyncio.sleep(0)
        self.assertEqual(listener.discard.await_count, 1)
        self.assertFalse(listener.run_call.called)
        await listener.raw(incoming(2, 33))
        await listener.raw(incoming(2, 33))
        await asyncio.sleep(0)
        self.assertEqual(listener.run_call.await_count, 1)
        await listener.raw(incoming(3, 35))
        await asyncio.sleep(0)
        self.assertEqual(listener.discard.await_count, 2)
        await listener.raw(UpdatePhoneCall(PhoneCallDiscarded(2)))
        self.assertFalse(listener.current.alive)
        await listener.close()

    async def test_dependency_engine_formats_and_frame_send(self):
        self.network_patch.stop()
        await bridge.check_dependencies()


@unittest.skipUnless(importlib.util.find_spec("dotenv"), "install prototype requirements for input tests")
class InputTests(unittest.TestCase):
    def test_required_inputs_fail_before_account_connection(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(bridge.BridgeError, "missing_TG_API_ID"):
                bridge.read_inputs()

    def test_private_file_allowlist_and_exclusivity_validation(self):
        values = {"TG_API_ID": "1", "TG_API_HASH": "private", "TG_SESSION": "session",
                  "GEMINI_API_KEY": "private", "GEMINI_LIVE_MODEL": "configured",
                  "TELEGRAM_ALLOWED_USERS": "1, 2", "TELEGRAM_CALL_EXCLUSIVE_SESSION": "1"}
        with patch.dict(os.environ, values, clear=True):
            self.assertEqual(bridge.read_inputs()["allowed"], {1, 2})
            with patch.dict(os.environ, {"TELEGRAM_ALLOWED_USERS": "*"}):
                with self.assertRaisesRegex(bridge.BridgeError, "invalid_TELEGRAM_ALLOWED_USERS"):
                    bridge.read_inputs()
            with patch.dict(os.environ, {"TELEGRAM_CALL_EXCLUSIVE_SESSION": "0"}):
                with self.assertRaisesRegex(bridge.BridgeError, "account_exclusivity_unconfirmed"):
                    bridge.read_inputs()
        with tempfile.TemporaryDirectory() as temp:
            credentials = Path(temp) / "private.env"
            credentials.write_text("\n".join(key + "=" + value for key, value in values.items()))
            credentials.chmod(0o600)
            with patch.dict(os.environ, {"TELEGRAM_CALL_ENV_FILE": str(credentials)}, clear=True):
                self.assertEqual(bridge.read_inputs()["allowed"], {1, 2})
                credentials.chmod(0o644)
                with self.assertRaisesRegex(bridge.BridgeError, "credential_file_permissions"):
                    bridge.read_inputs()


if __name__ == "__main__":
    unittest.main()
