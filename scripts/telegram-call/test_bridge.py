import asyncio
import contextlib
import datetime
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
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
        self.call = bridge.Call(bridge.Peer(11, 22), 33, 0, accept_permission=True)
        self.client.current_call = self.call

    def accept(self, peer=None):
        from telethon.tl.functions.phone import AcceptCallRequest
        from telethon.tl.types import InputPhoneCall, PhoneCallProtocol
        peer = peer or self.call.peer
        return AcceptCallRequest(InputPhoneCall(peer.id, peer.access_hash), b"key",
                                 PhoneCallProtocol(65, 92, ["native"], True, True))

    async def test_public_pytgcalls_constructor_binds_guarded_telethon_without_network(self):
        from telethon.sessions import StringSession
        from pytgcalls import PyTgCalls
        from pytgcalls.mtproto.telethon_client import TelethonClient
        client = bridge.guarded_client_class()(StringSession(), 1, "test")
        calls = PyTgCalls(client)
        self.addCleanup(calls.executor.shutdown, wait=False)
        self.assertIs(calls.mtproto_client, client)
        self.assertIsInstance(calls._app._bind_client, TelethonClient)
        self.assertIs(calls._app._bind_client._app, client)
        self.assertFalse(client.is_connected())
        self.network.assert_not_called()

    async def test_current_message_schema_and_sanitized_telethon_child_logs(self):
        from telethon import TelegramClient
        from telethon.errors import TypeNotFoundError
        from telethon.extensions import BinaryReader
        from telethon.tl.alltlobjects import tlobjects
        from telethon.tl.types import Message, PeerUser
        self.assertIs(tlobjects[0x7600b9d3], Message)
        message = Message(id=1, peer_id=PeerUser(1), message="offline fixture",
                          date=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc))
        encoded = bytes(message)
        self.assertEqual(int.from_bytes(encoded[:4], "little"), 0x7600b9d3)
        with BinaryReader(encoded) as reader:
            self.assertEqual(reader.tgread_object().message, "offline fixture")
        logger = bridge.telegram_logger()
        client = TelegramClient(None, 1, "test", base_logger=logger)
        transport_log = client._log["telethon.client.updates"]
        self.assertIs(transport_log, logger)
        error = TypeNotFoundError(0x7600b9d3, b"private-history-bytes")
        with patch("bridge.event") as output:
            transport_log.warning("private message %s", error)
            try:
                raise error
            except TypeNotFoundError:
                transport_log.exception("private traceback message")
            transport_log.warning("private text with no exception")
            transport_log.info("private low-level info")
        self.assertEqual(output.call_count, 3)
        for call in output.call_args_list[:2]:
            self.assertEqual(call.args, ("telegram_transport_log",))
            self.assertEqual(call.kwargs["error"], "TypeNotFoundError")
            self.assertEqual(call.kwargs["constructor"], "0x7600b9d3")
        self.assertNotIn("private", str(output.call_args_list))

    async def test_real_disconnect_monitor_propagates_update_failure_without_network(self):
        from telethon.errors import TypeNotFoundError
        self.client._updates_error = TypeNotFoundError(0x7600b9d3, b"private-history")
        with patch.object(type(self.client), "__call__", new=AsyncMock()) as handshake, \
                patch.object(self.client, "disconnect", new=AsyncMock()) as disconnect:
            with self.assertRaises(TypeNotFoundError):
                await self.client.run_until_disconnected()
        handshake.assert_awaited_once()
        disconnect.assert_awaited_once()
        self.network.assert_not_called()

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

    async def test_lifecycle_accepts_media_before_ready_and_cleans_exact_peer(self):
        from test_lifecycle import offline_calls, notices
        from telethon.tl.functions.phone import DiscardCallRequest
        ready = asyncio.Event()
        connected = asyncio.Event()
        call = self.call
        call.received = bridge.time.monotonic()
        call.accept_permission = False

        async def play(user, stream):
            await self.adapter._invoke(self.accept())

        async def record(user, stream):
            connected.set()

        class Context:
            closed = False

            async def __aenter__(self):
                await ready.wait()
                return SimpleNamespace()

            async def __aexit__(self, *args):
                self.closed = True

        context = Context()
        calls = offline_calls(self.client)
        self.addCleanup(calls.executor.shutdown, wait=False)
        calls.play, calls.record = play, record
        self.client.is_connected = lambda: True
        daemon = SimpleNamespace(perform=AsyncMock())
        gemini = SimpleNamespace(aio=SimpleNamespace(live=SimpleNamespace(connect=lambda **args: context)))
        listener = bridge.Listener({"GEMINI_LIVE_MODEL": "configured"},
                                  SimpleNamespace(check=AsyncMock()), self.client, calls, daemon,
                                  gemini, SimpleNamespace(), 60000, notices())
        listener.current = call
        call.task = asyncio.create_task(listener.run_call(call))
        await asyncio.sleep(.02)
        self.assertTrue(call.accepted)
        self.assertFalse(connected.is_set())
        daemon.perform.assert_not_awaited()
        ready.set()
        await asyncio.wait_for(connected.wait(), 1)
        self.assertTrue(call.accepted)
        call.task.cancel()
        await call.task
        self.assertTrue(any(isinstance(args.args[1], DiscardCallRequest) for args in self.network.await_args_list))
        self.assertTrue(context.closed)
        self.assertIsNone(listener.current)

    async def test_incoming_unauthorized_busy_duplicate_and_discard(self):
        from telethon.tl.types import PhoneCallRequested, PhoneCallProtocol, UpdatePhoneCall, PhoneCallDiscarded
        listener = bridge.Listener({"allowed": {33}}, None, self.client, None, None, None, None, 60000, {})
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
    def test_real_launchers_reject_missing_or_partial_inputs_before_runtime_state(self):
        values = {"TG_API_ID": "1", "TG_API_HASH": "hidden", "TG_SESSION": "dummy.session",
                  "GEMINI_API_KEY": "hidden", "GEMINI_LIVE_MODEL": "configured",
                  "TELEGRAM_ALLOWED_USERS": "1", "TELEGRAM_CALL_EXCLUSIVE_SESSION": "1"}
        for script in ("run-call.sh", "run-daemon.sh"):
            for missing in (None, "TG_SESSION", "GEMINI_API_KEY"):
                with self.subTest(script=script, missing=missing), tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    inputs = root / "private.env"
                    inputs.write_text("\n".join(key + "=" + value for key, value in values.items()
                                               if missing is not None and key != missing))
                    inputs.chmod(0o600)
                    env = {"HOME": os.environ["HOME"], "PATH": os.environ["PATH"],
                           "TELEGRAM_CALL_STATE_DIR": str(root / "state"),
                           "TELEGRAM_CALL_ENV_FILE": str(inputs), "TELEGRAM_CALL_PYTHON": sys.executable,
                           "SPUR_SESSION_TOOL_DIR": str(root / "tools"), "TMPDIR": str(root / "tmp"),
                           "TELEGRAM_CALL_ALLOWLIST_FILE": str(root / "absent.env"),
                           "PYTHONDONTWRITEBYTECODE": "1"}
                    result = subprocess.run(["/bin/bash", str(Path(__file__).with_name(script))],
                                            env=env, capture_output=True, text=True, timeout=5)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("missing_" + (missing or "TG_API_ID"), result.stdout)
                    self.assertNotIn("hidden", result.stdout + result.stderr)
                    self.assertFalse((root / "state").exists())
                    self.assertFalse((root / "tools").exists())
                    self.assertFalse((root / "tmp").exists())

    def test_launcher_discovers_private_inputs_and_preserves_overrides_and_guards(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = root / "cache/spur/telegram-call"
            state.mkdir(parents=True)
            credentials = state / "call.env"
            content = ("TG_API_ID=1\nTG_API_HASH=test\nTG_SESSION=test.session\n"
                       "GEMINI_API_KEY=test\nGEMINI_LIVE_MODEL=test\n"
                       "TELEGRAM_ALLOWED_USERS=1\nTELEGRAM_CALL_EXCLUSIVE_SESSION=1\n")
            credentials.write_text(content)
            credentials.chmod(0o600)
            probe = root / "python-probe"
            probe.write_text(f"#!{sys.executable}\n"
                             "import sys\nfrom pathlib import Path\n"
                             "sys.path.insert(0, str(Path(sys.argv[1]).parent))\n"
                             "import bridge\nprint(bridge.read_inputs()['TG_API_ID'])\n")
            probe.chmod(0o700)
            env = {"HOME": os.environ["HOME"], "XDG_CACHE_HOME": str(root / "cache"),
                   "PATH": os.environ["PATH"], "TELEGRAM_CALL_PYTHON": str(probe),
                   "TELEGRAM_CALL_ALLOWLIST_FILE": str(root / "missing-allowlist.env"),
                   "PYTHONDONTWRITEBYTECODE": "1"}
            launcher = Path(__file__).with_name("run-call.sh")

            def launch(**overrides):
                return subprocess.run(["/bin/bash", str(launcher), "--check-deps"],
                                      env={**env, **overrides}, capture_output=True, text=True)

            result = launch()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "1")
            self.assertEqual(state.stat().st_mode & 0o777, 0o700)
            override = root / "override.env"
            override.write_text(content.replace("TG_API_ID=1", "TG_API_ID=2"))
            override.chmod(0o600)
            result = launch(TELEGRAM_CALL_ENV_FILE=str(override))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "2")
            result = launch(TELEGRAM_CALL_ENV_FILE=str(root / "missing.env"))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("FileNotFoundError", result.stderr)
            credentials.chmod(0o644)
            result = launch()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("credential_file_permissions", result.stderr)
            credentials.chmod(0o600)
            artifacts = root / "artifacts"
            artifacts.mkdir()
            private = artifacts / "call.env"
            credentials.rename(private)
            credentials.symlink_to(private)
            result = launch(SPUR_SESSION_ARTIFACTS_DIR=str(artifacts))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("credentials_in_artifacts", result.stderr)
            credentials.unlink()
            result = launch()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("missing_TG_API_ID", result.stderr)

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
