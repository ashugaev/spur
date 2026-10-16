import asyncio
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
import wave
from unittest.mock import AsyncMock, patch

from ntgcalls import ConnectionInfo, ConnectionKind, ConnectionState
from telethon.tl.functions.phone import DiscardCallRequest, SendSignalingDataRequest
from telethon.tl.types import InputPhoneCall, PhoneCallDiscarded, UpdatePhoneCall

import bridge
import test_lifecycle as lifecycle


class AssetsTests(unittest.TestCase):
    def test_six_committed_pcm_assets_and_invalid_assets_fail_closed(self):
        source = Path(__file__).with_name("audio")
        assets = bridge.load_notices(source)
        self.assertEqual(set(assets), set(bridge.NOTICE_NAMES))
        self.assertTrue(all(48000 < len(data) <= 8 * 48000 and any(data) for data in assets.values()))
        with tempfile.TemporaryDirectory() as temp:
            copied = Path(temp) / "audio"
            shutil.copytree(source, copied)
            for data in (b"not a wave", b""):
                (copied / "starting.wav").write_bytes(data)
                with self.assertRaisesRegex(bridge.BridgeError, "invalid_notice_starting"):
                    bridge.load_notices(copied)
            (copied / "starting.wav").unlink()
            with self.assertRaisesRegex(bridge.BridgeError, "invalid_notice_starting"):
                bridge.load_notices(copied)
            for rate, channels, width, frames in ((16000, 1, 2, b"\1\0" * 10),
                                                   (24000, 2, 2, b"\1\0" * 10),
                                                   (24000, 1, 1, b"\1" * 10),
                                                   (24000, 1, 2, bytes(20))):
                with wave.open(str(copied / "starting.wav"), "wb") as audio:
                    audio.setparams((channels, width, rate, 0, "NONE", "NONE"))
                    audio.writeframes(frames)
                with self.assertRaisesRegex(bridge.BridgeError, "invalid_notice_starting"):
                    bridge.load_notices(copied)


class Binding:
    def __init__(self):
        self.callbacks = {}
        self.stop = AsyncMock()

    def on_stream_end(self, callback):
        self.callbacks["end"] = callback

    def on_upgrade(self, callback):
        self.callbacks["upgrade"] = callback

    def on_connection_change(self, callback):
        self.callbacks["connection"] = callback

    def on_update_emojis(self, callback):
        self.callbacks["emojis"] = callback

    def on_signaling_data(self, callback):
        self.callbacks["signaling"] = callback

    def on_frames(self, callback):
        self.callbacks["frames"] = callback


class StatusTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = lifecycle.LifecycleTests.asyncSetUp
    fixture = lifecycle.LifecycleTests.fixture

    async def test_input_preflight_bypasses_native_dependencies_and_network(self):
        with patch("bridge.sys.argv", ["bridge.py", "--check-inputs"]), \
                patch("bridge.read_inputs", return_value={}) as inputs, \
                patch("bridge.check_dependencies", new=AsyncMock()) as native, \
                patch("bridge.private_session") as session, \
                patch("bridge.event") as output:
            await bridge.main()
        inputs.assert_called_once()
        native.assert_not_awaited()
        session.assert_not_called()
        output.assert_called_once_with("inputs_ready")

    async def test_preparation_waits_at_15_and_30_seconds_without_extending_timeout(self):
        f = self.fixture()
        clock = 0
        heard = []
        async def pending(*args):
            await asyncio.Event().wait()
        async def wait(tasks, timeout, **kwargs):
            nonlocal clock
            clock += timeout
            if clock >= 45:
                raise TimeoutError()
            return set(), set(tasks)
        async def notice(name):
            nonlocal clock
            heard.append((name, clock))
            clock += 2
        f.shepherd.prepare = pending
        with patch("bridge.time", SimpleNamespace(monotonic=lambda: clock)), \
                patch("bridge.asyncio.wait", side_effect=wait):
            with self.assertRaises(TimeoutError):
                await f.listener.prepare_services(f.call, SimpleNamespace(notice=notice), pending)
        self.assertEqual(heard, [("waiting", 15), ("waiting", 30)])
        self.assertEqual(clock, 45)
        f.shepherd.prepare = AsyncMock()
        writer = SimpleNamespace(notice=AsyncMock())
        await f.listener.prepare_services(f.call, writer, AsyncMock())
        writer.notice.assert_not_awaited()

    async def test_media_starting_readiness_record_order_and_no_early_microphone(self):
        f = self.fixture()
        release, preparing = asyncio.Event(), asyncio.Event()
        original = f.shepherd.prepare
        async def prepare(call):
            preparing.set()
            await release.wait()
            await original(call)
        f.shepherd.prepare = prepare
        with patch("bridge.event") as events:
            f.call.task = asyncio.create_task(f.listener.run_call(f.call))
            await asyncio.wait_for(preparing.wait(), 1)
            self.assertTrue(f.call.accepted)
            self.assertFalse(f.call.ready)
            self.assertFalse(f.call.active)
            self.assertIsNone(f.listener.input)
            self.assertFalse(f.calls.record.called)
            from pytgcalls.types import StreamFrames, Direction, Device
            await f.listener.frames(None, StreamFrames(33, Direction.INCOMING, Device.MICROPHONE,
                                                       [SimpleNamespace(frame=b"X" * 320)]))
            f.live.input.assert_not_awaited()
            release.set()
            await asyncio.wait_for(f.connected.wait(), 1)
            f.call.task.cancel()
            await f.call.task
        trace = [(call.args[0], call.kwargs.get("status")) for call in events.call_args_list]
        self.assertLess(trace.index(("media_connected", None)), trace.index(("status_started", "starting")))
        self.assertLess(trace.index(("status_finished", "starting")), trace.index(("gemini_ready", None)))
        self.assertLess(trace.index(("status_finished", "ready")), trace.index(("conversation_started", None)))

    async def test_specific_failure_finishes_before_pinned_hangup_and_kills_owned_shepherd(self):
        for mode in ("shepherd-failed", "voice-failed", "timeout"):
            with self.subTest(mode=mode):
                f = self.fixture()
                original = f.shepherd.prepare
                async def prepare(call):
                    await original(call)
                    if mode == "shepherd-failed":
                        raise RuntimeError("setup")
                    if mode == "timeout":
                        await asyncio.Event().wait()
                f.shepherd.prepare = prepare
                if mode == "voice-failed":
                    class FailedLive:
                        async def __aenter__(self):
                            raise RuntimeError("provider")
                    f.listener.gemini.aio.live.connect = lambda **kwargs: FailedLive()
                trace = []
                async def rpc(sender, request, *args, **kwargs):
                    if isinstance(request, DiscardCallRequest):
                        trace.append("discard")
                self.network.side_effect = rpc
                def event(stage, **fields):
                    if stage == "status_finished":
                        trace.append(fields["status"])
                timeout = asyncio.timeout
                with patch("bridge.event", side_effect=event), patch("bridge.asyncio.timeout", side_effect=lambda seconds:
                        timeout(.02 if seconds == 45 else seconds)):
                    await asyncio.wait_for(f.listener.run_call(f.call), 2)
                self.assertEqual(trace, ["starting", mode, "discard"])
                self.assertTrue(f.call.accepted)
                f.calls.record.assert_not_awaited()
                f.shepherd.request.assert_any_await("POST", "/sessions/owned/kill", {})
                self.assertIsNone(f.listener.current)

    async def test_native_terminal_cancels_starting_and_error_notice_without_sdk_discard(self):
        for failing in (False, True):
            with self.subTest(error_notice=failing):
                f = self.fixture()
                binding = Binding()
                blocked = asyncio.Event()
                count = 0
                marker = f.listener.notices["voice-failed"] if failing else f.listener.notices["starting"]
                async def send(user, device, frame):
                    nonlocal count
                    count += 1
                    if frame == marker:
                        blocked.set()
                        await asyncio.Event().wait()
                f.calls.send_frame.side_effect = send
                async def stop(user):
                    self.assertTrue(f.listener.native.retired)
                    binding.callbacks["connection"](user, ConnectionInfo(ConnectionState.CLOSED, ConnectionKind.NORMAL))
                    await asyncio.sleep(0)
                binding.stop.side_effect = stop
                if failing:
                    class FailedLive:
                        async def __aenter__(self):
                            raise RuntimeError("provider")
                    f.listener.gemini.aio.live.connect = lambda **kwargs: FailedLive()
                sdk_discard = patch.object(f.calls._app, "discard_call", new=AsyncMock())
                with patch("ntgcalls.NTgCalls", return_value=binding), sdk_discard as discard:
                    f.call.task = asyncio.create_task(f.listener.run_call(f.call))
                    await asyncio.wait_for(blocked.wait(), 1)
                    before = count
                    binding.callbacks["connection"](33, ConnectionInfo(ConnectionState.FAILED, ConnectionKind.NORMAL))
                    await asyncio.wait_for(asyncio.gather(f.call.task, return_exceptions=True), 1)
                self.assertFalse(f.call.alive)
                self.assertFalse(f.call.media_connected)
                self.assertEqual(count, before)
                discard.assert_not_awaited()
                self.assertIsNone(f.listener.current)
                binding.stop.assert_awaited_once_with(33)
                self.assertEqual(f.call.task.cancelling(), 1)
                if failing:
                    f.shepherd.request.assert_any_await("POST", "/sessions/owned/kill", {})

    async def test_native_epoch_rejects_late_same_user_callbacks_and_stop_closed(self):
        f = self.fixture()
        f.call.media_connected = True
        writer = bridge.Playback(f.listener, f.call)
        old = Binding()
        with patch("ntgcalls.NTgCalls", return_value=old):
            native = bridge.NativeCall(f.listener, f.call, writer)
        self.assertEqual(len(old.callbacks), 6)
        waiter = asyncio.get_running_loop().create_future()
        f.calls._wait_connect[33] = waiter
        f.call.task = asyncio.create_task(asyncio.Event().wait())
        old.callbacks["connection"](33, ConnectionInfo(ConnectionState.TIMEOUT, ConnectionKind.NORMAL))
        await asyncio.sleep(0)
        self.assertFalse(f.call.media_connected)
        self.assertFalse(f.call.alive)
        with self.assertRaises(bridge.BridgeError):
            await waiter
        await asyncio.gather(f.call.task, return_exceptions=True)
        native.retire()
        async def stop(user):
            self.assertTrue(native.retired)
            old.callbacks["connection"](user, ConnectionInfo(ConnectionState.CLOSED, ConnectionKind.NORMAL))
        old.stop.side_effect = stop
        await native.close()
        self.assertIsNone(f.listener.native)
        new_call = bridge.Call(bridge.Peer(55, 66), 33, 0, media_connected=True)
        f.listener.current = new_call
        self.client.current_call = new_call
        new_writer = bridge.Playback(f.listener, new_call)
        fresh = Binding()
        with patch("ntgcalls.NTgCalls", return_value=fresh):
            current = bridge.NativeCall(f.listener, new_call, new_writer)
        new_waiter = asyncio.get_running_loop().create_future()
        f.calls._wait_connect[33] = new_waiter
        self.adapter._cache.set_cache(33, InputPhoneCall(55, 66))
        before = self.network.await_count
        for state in (ConnectionState.FAILED, ConnectionState.CONNECTED):
            old.callbacks["connection"](33, ConnectionInfo(state, ConnectionKind.NORMAL))
        await asyncio.sleep(0)
        self.assertTrue(new_call.alive)
        self.assertTrue(new_call.media_connected)
        self.assertFalse(new_waiter.done())
        self.assertIs(f.calls._binding, fresh)
        self.assertEqual(self.network.await_count, before)
        fresh.callbacks["connection"](33, ConnectionInfo(ConnectionState.CONNECTED, ConnectionKind.NORMAL))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertIsNone(await asyncio.wait_for(new_waiter, 1))
        current.retire()
        await current.close()

    async def test_registered_native_signaling_checks_exact_peer_after_real_adapter_lookup(self):
        for replaced in (False, True):
            with self.subTest(replaced=replaced):
                f = self.fixture()
                self.network.reset_mock()
                adapter = f.calls._app._bind_client
                peer = InputPhoneCall(55, 66) if replaced else InputPhoneCall(11, 22)
                adapter._cache.set_cache(33, peer)
                binding = Binding()
                with patch("ntgcalls.NTgCalls", return_value=binding):
                    native = bridge.NativeCall(f.listener, f.call, bridge.Playback(f.listener, f.call))
                f.call.task = asyncio.create_task(asyncio.Event().wait())
                binding.callbacks["signaling"](33, b"offline signaling")
                await asyncio.sleep(0)
                await asyncio.sleep(0)
                await asyncio.gather(*native.tasks, return_exceptions=True)
                await asyncio.sleep(0)
                if replaced:
                    self.network.assert_not_awaited()
                    self.assertFalse(f.call.alive)
                else:
                    self.network.assert_awaited_once()
                    request = self.network.await_args.args[1]
                    self.assertIsInstance(request, SendSignalingDataRequest)
                    self.assertEqual((request.peer.id, request.peer.access_hash), (11, 22))
                    self.assertTrue(f.call.alive)
                native.retire()
                f.call.task.cancel()
                await asyncio.gather(f.call.task, return_exceptions=True)
                await native.close()

        f = self.fixture()
        self.network.reset_mock()
        valid = SendSignalingDataRequest(InputPhoneCall(11, 22), b"current")
        stale = SendSignalingDataRequest(InputPhoneCall(55, 66), b"replaced")
        with bridge.pinned(f.call):
            with self.assertRaisesRegex(bridge.BridgeError, "call_peer_changed"):
                await f.calls._app._bind_client._invoke([valid, stale])
        self.network.assert_not_awaited()

    async def test_status_completion_waits_for_last_frame_drain_and_one_sender(self):
        f = self.fixture()
        f.call.media_connected = True
        f.listener.notices["starting"] = b"S" * 960
        binding = Binding()
        writer = bridge.Playback(f.listener, f.call)
        with patch("ntgcalls.NTgCalls", return_value=binding):
            native = bridge.NativeCall(f.listener, f.call, writer)
        blocked, release = asyncio.Event(), asyncio.Event()
        sent, concurrency, peak = [], 0, 0
        async def send(*args):
            nonlocal concurrency, peak
            concurrency += 1
            peak = max(peak, concurrency)
            sent.append(bridge.time.monotonic())
            if len(sent) == 2:
                blocked.set()
                await release.wait()
            await asyncio.sleep(.001)
            concurrency -= 1
        f.calls.send_frame.side_effect = send
        with patch("bridge.event") as events:
            playing = asyncio.create_task(writer.notice("starting"))
            await asyncio.wait_for(blocked.wait(), 1)
            self.assertFalse(any(call.args == ("status_finished",) for call in events.call_args_list))
            release.set()
            await asyncio.wait_for(playing, 1)
        self.assertGreaterEqual(sent[1] - sent[0], .008)
        self.assertGreaterEqual(bridge.time.monotonic() - sent[-1], .05)
        self.assertEqual(peak, 1)
        native.retire()
        await native.close()

    async def test_remote_discard_and_frame_failure_stop_status_without_recursive_notice(self):
        for remote in (True, False):
            with self.subTest(remote_discard=remote):
                f = self.fixture()
                blocked = asyncio.Event()
                async def send(*args):
                    blocked.set()
                    if remote:
                        await asyncio.Event().wait()
                    raise RuntimeError("native send failure")
                f.calls.send_frame.side_effect = send
                with patch("bridge.event") as events:
                    f.call.task = asyncio.create_task(f.listener.run_call(f.call))
                    await asyncio.wait_for(blocked.wait(), 1)
                    if remote:
                        await f.listener.raw(UpdatePhoneCall(PhoneCallDiscarded(id=11)))
                    await asyncio.wait_for(f.call.task, 1)
                f.calls.send_frame.assert_awaited_once()
                self.assertFalse(f.call.media_connected)
                self.assertIsNone(f.listener.current)
                statuses = [call.kwargs["status"] for call in events.call_args_list
                            if call.args == ("status_started",)]
                self.assertEqual(statuses, ["starting"])
    async def test_native_cleanup_timeouts_are_independent_and_release_slot(self):
        f = self.fixture()
        binding = Binding()
        async def forever(*args):
            await asyncio.Event().wait()
        binding.stop.side_effect = forever
        f.listener.discard = AsyncMock(side_effect=forever)
        class FailedLive:
            async def __aenter__(self):
                raise RuntimeError("provider")
        f.listener.gemini.aio.live.connect = lambda **kwargs: FailedLive()
        timeout = asyncio.wait_for
        bounds = []
        async def bounded(awaitable, seconds):
            bounds.append(seconds)
            return await timeout(awaitable, .01)
        with patch("ntgcalls.NTgCalls", return_value=binding), \
                patch("bridge.asyncio.wait_for", side_effect=bounded):
            await f.listener.run_call(f.call)
        self.assertEqual(bounds, [5, 5])
        self.assertIsNone(f.listener.native)
        self.assertIsNone(f.listener.current)
        f.shepherd.request.assert_any_await("POST", "/sessions/owned/kill", {})
