import asyncio
import contextlib
import os
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import bridge


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / "project.yaml"
        self.config.write_text("projects:\n  voice-sandbox: {}\n")
        self.receipt = self.root / "runtime.env"
        self.receipt.write_text('SPUR_ISOLATED_DAEMON_URL="http://127.0.0.1:49001"\n'
                                + 'SPUR_ISOLATED_PROJECT_CONFIG="' + str(self.config) + '"\n')
        self.proc = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"generation-a\n", b"")),
                                    kill=Mock(), wait=AsyncMock())
        self.spawn = AsyncMock(return_value=self.proc)
        self.patch = patch("bridge.asyncio.create_subprocess_exec", self.spawn)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    async def test_runtime_pins_generation_rejects_registry_receipt_urls_and_reaps_helper(self):
        runtime = bridge.Runtime(self.receipt, "helper.js")
        await runtime.check()
        await runtime.check()
        self.assertEqual(self.spawn.await_args_list[0].args[:3], ("node", "helper.js", "--daemon-ready"))
        self.assertEqual(self.spawn.await_args_list[1].args[-1], "generation-a")
        self.proc.returncode = 1
        with self.assertRaisesRegex(bridge.BridgeError, "runtime_not_ready"):
            await runtime.check()
        self.proc.returncode = 0
        configs = ["projects: {other: {}}", "projects: {}"]
        for key in ("sources", "triggers", "sidecars"):
            configs += ["projects: {voice-sandbox: {}}\n" + key + ": {active: {}}",
                        "projects:\n  voice-sandbox:\n    " + key + ": {active: {}}"]
        for config in configs:
            with self.subTest(config=config):
                self.config.write_text(config)
                with self.assertRaisesRegex(bridge.BridgeError, "unsafe_project_registry"):
                    await runtime.check()
        self.proc.communicate.side_effect = asyncio.TimeoutError
        with self.assertRaises(asyncio.TimeoutError):
            await runtime.check()
        self.proc.kill.assert_called_once()
        self.proc.wait.assert_awaited_once()
        self.spawn.reset_mock()
        self.receipt.write_text(self.receipt.read_text() + 'SPUR_ISOLATED_DATA_DIR="replacement"\n')
        with self.assertRaisesRegex(bridge.BridgeError, "runtime_replaced"):
            await runtime.check()
        self.spawn.assert_not_awaited()
        for url in ("http://localhost:4310", "http://localhost", "https://localhost:49001",
                    "http://example.com:49001", "http://user@localhost:49001", "http://localhost:49001/path"):
            with self.subTest(url=url):
                self.receipt.write_text('SPUR_ISOLATED_DAEMON_URL="' + url + '"\n')
                with self.assertRaisesRegex(bridge.BridgeError, "unsafe_runtime_url"):
                    bridge.Runtime(self.receipt, "helper.js")
        self.receipt.write_text("export SPUR_ISOLATED_DAEMON_URL=unsafe\n")
        with self.assertRaisesRegex(bridge.BridgeError, "invalid_runtime_receipt"):
            bridge.Runtime(self.receipt, "helper.js")


class PrivateSessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "original.session"
        with sqlite3.connect(self.source) as db:
            db.execute("CREATE TABLE secret (value TEXT)")
            db.execute("INSERT INTO secret VALUES ('original')")
        self.env = patch.dict(os.environ, {"TELEGRAM_CALL_STATE_DIR": str(self.root / "state")}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.home = patch("bridge.Path.home", return_value=self.root)
        self.home.start()
        self.addCleanup(self.home.stop)

    def test_private_backup_permissions_lock_and_canonical_artifact_boundaries(self):
        original = self.source.read_bytes()
        lock, target = bridge.private_session({"TG_SESSION": str(self.source)})
        self.addCleanup(lock.close)
        with sqlite3.connect(target) as db:
            self.assertEqual(db.execute("SELECT value FROM secret").fetchone(), ("original",))
            db.execute("UPDATE secret SET value='copy'")
        self.assertEqual(self.source.read_bytes(), original)
        for path, mode in ((target, 0o600), (Path(lock.name), 0o600),
                           (target.parent, 0o700), (Path(lock.name).parent, 0o700)):
            self.assertEqual(path.stat().st_mode & 0o777, mode)
        alias = self.root / "alias.session"
        alias.symlink_to(self.source)
        with self.assertRaisesRegex(bridge.BridgeError, "account_listener_busy"):
            bridge.private_session({"TG_SESSION": str(alias)})
        lock.close()
        second, same_target = bridge.private_session({"TG_SESSION": str(alias)})
        second.close()
        self.assertEqual(same_target, target)
        missing = self.root / "missing.session"
        for attempt in range(2):
            with self.subTest(attempt=attempt), self.assertRaises(sqlite3.OperationalError):
                bridge.private_session({"TG_SESSION": str(missing)})
        self.assertFalse(missing.exists())
        artifacts = self.root / "artifacts"
        artifacts.mkdir()
        alias = self.root / "alias"
        alias.symlink_to(artifacts, target_is_directory=True)
        with patch.dict(os.environ, {"SPUR_SESSION_ARTIFACTS_DIR": str(artifacts),
                                   "TELEGRAM_CALL_STATE_DIR": str(alias / "state")}):
            with self.assertRaisesRegex(bridge.BridgeError, "private_state_in_artifacts"):
                bridge.private_session({"TG_SESSION": str(self.source)})
        with patch.dict(os.environ, {"SPUR_SESSION_ARTIFACTS_DIR": str(artifacts)}):
            with self.assertRaisesRegex(bridge.BridgeError, "telegram_session_in_artifacts"):
                bridge.private_session({"TG_SESSION": str(alias / "account.session")})
            with patch.dict(os.environ, {"TELEGRAM_CALL_ENV_FILE": str(alias / "private.env")}):
                with self.assertRaisesRegex(bridge.BridgeError, "credentials_in_artifacts"):
                    bridge.read_inputs()

    def test_session_name_appends_extension_like_telethon(self):
        for name, stored in (("acct.v2", "acct.v2.session"), ("plain", "plain.session"),
                             ("acct.session", "acct.session")):
            with self.subTest(name=name):
                path = self.root / stored
                with sqlite3.connect(path) as db:
                    db.execute("CREATE TABLE secret (value TEXT)")
                    db.execute("INSERT INTO secret VALUES (?)", (stored,))
                lock, target = bridge.private_session({"TG_SESSION": str(self.root / name)})
                lock.close()
                with sqlite3.connect(target) as db:
                    self.assertEqual(db.execute("SELECT value FROM secret").fetchone(), (stored,))


class StartupTests(unittest.IsolatedAsyncioTestCase):
    async def test_failure_stages_close_owned_clients_handlers_and_lock(self):
        for stage in ("constructor", "connect", "unauthorized", "start", "updates", "signal", "disconnect",
                      "update_error", "transport_closed", "disconnected_startup", "startup_update_error"):
            with self.subTest(stage=stage), contextlib.ExitStack() as stack:
                lock = Mock()
                client = SimpleNamespace(connect=AsyncMock(), disconnect=AsyncMock(),
                                         is_user_authorized=AsyncMock(return_value=stage != "unauthorized"),
                                         set_receive_updates=AsyncMock(),
                                         is_connected=Mock(return_value=stage != "disconnected_startup"),
                                         add_event_handler=Mock(), remove_event_handler=Mock())
                async def monitor():
                    if stage in ("update_error", "startup_update_error"):
                        raise RuntimeError("private payload must not reach logs")
                    if stage != "transport_closed":
                        await asyncio.Event().wait()
                client.run_until_disconnected = monitor
                client_call = AsyncMock(return_value=SimpleNamespace(call_ring_timeout_ms=60000))
                client_type = type("Client", (), {"__call__": client_call})
                fake_client = client_type()
                fake_client.__dict__.update(client.__dict__)
                constructor = Mock(return_value=fake_client)
                calls = SimpleNamespace(start=AsyncMock(), on_update=Mock(return_value=Mock()),
                                        remove_handler=Mock())
                gemini = SimpleNamespace(aio=SimpleNamespace(aclose=AsyncMock()))
                values = {"TG_API_ID": "1", "TG_API_HASH": "hash", "GEMINI_API_KEY": "key"}
                stack.enter_context(patch("bridge.check_dependencies", new=AsyncMock()))
                stack.enter_context(patch("bridge.read_inputs", return_value=values))
                stack.enter_context(patch("bridge.Runtime", return_value=SimpleNamespace(check=AsyncMock())))
                stack.enter_context(patch("bridge.private_session", return_value=(lock, Path("private.session"))))
                stack.enter_context(patch("bridge.guarded_client_class", return_value=constructor))
                stack.enter_context(patch("pytgcalls.PyTgCalls", return_value=calls))
                stack.enter_context(patch("google.genai.Client", return_value=gemini))
                stack.enter_context(patch("bridge.sys.argv", ["bridge.py"]))
                stack.enter_context(patch.dict(os.environ, {"TELEGRAM_CALL_RUNTIME_FILE": "receipt",
                                                          "TELEGRAM_CALL_ENDPOINT_HELPER": "helper"}))
                loop = asyncio.get_running_loop()
                signals = stack.enter_context(patch.object(loop, "add_signal_handler"))
                events = stack.enter_context(patch("bridge.event"))
                stack.enter_context(patch.object(loop, "remove_signal_handler"))
                if stage == "constructor":
                    constructor.side_effect = RuntimeError("constructor")
                elif stage in ("connect", "disconnect"):
                    getattr(fake_client, stage).side_effect = RuntimeError(stage)
                elif stage == "start":
                    calls.start.side_effect = RuntimeError("start")
                elif stage == "updates":
                    fake_client.set_receive_updates.side_effect = RuntimeError("updates")
                elif stage == "startup_update_error":
                    async def handshake(*args):
                        await asyncio.sleep(0)
                    fake_client.set_receive_updates.side_effect = handshake
                elif stage == "signal":
                    signals.side_effect = RuntimeError("signal")
                if stage == "disconnect":
                    signals.side_effect = lambda signum, callback: callback()
                with self.assertRaises((RuntimeError, bridge.BridgeError)):
                    await asyncio.wait_for(bridge.main(), 2)
                ready = any(call.args == ("listener_ready",) for call in events.call_args_list)
                self.assertEqual(ready, stage in ("disconnect", "update_error", "transport_closed"))
                lock.close.assert_called_once()
                if stage != "constructor":
                    fake_client.disconnect.assert_awaited_once()
                if stage in ("start", "updates", "signal", "disconnect", "update_error",
                             "transport_closed", "disconnected_startup", "startup_update_error"):
                    gemini.aio.aclose.assert_awaited_once()
                    fake_client.remove_event_handler.assert_called_once()
                    calls.remove_handler.assert_called_once()


if __name__ == "__main__":
    unittest.main()
