"""Native incoming-call prototype. No production daemon or outgoing calls."""
import asyncio
import contextlib
import contextvars
import dataclasses
import fcntl
import importlib.metadata
import inspect
import json
import logging
import os
from pathlib import Path
import re
import signal
import sqlite3
import sys
import time
from urllib.parse import quote, urlsplit
import uuid
import wave


class BridgeError(Exception):
    pass


class StartupFailure(BridgeError):
    def __init__(self, notice):
        self.notice = notice
        super().__init__(notice)


def event(stage, **fields):
    print(json.dumps({"stage": stage, "monotonic": time.monotonic(), **fields}), flush=True)


class TelegramLogHandler(logging.Handler):
    def emit(self, record):
        args = record.args.values() if isinstance(record.args, dict) else record.args
        error = record.exc_info[1] if record.exc_info else next(
            (arg for arg in args if isinstance(arg, BaseException)), None)
        fields = {"level": record.levelname}
        if error is not None:
            fields["error"] = type(error).__name__
            constructor = getattr(error, "invalid_constructor_id", None)
            if type(constructor) is int and 0 <= constructor <= 0xffffffff:
                fields["constructor"] = f"0x{constructor:08x}"
        event("telegram_transport_log", **fields)


class TelegramLogger(logging.Logger):
    def getChild(self, suffix):
        return self


def telegram_logger():
    logger = TelegramLogger("telegram_call_transport", level=logging.WARNING)
    logger.propagate = False
    logger.addHandler(TelegramLogHandler())
    return logger


@dataclasses.dataclass(frozen=True)
class Peer:
    id: int
    access_hash: int


@dataclasses.dataclass
class Call:
    peer: Peer
    user: int
    received: float
    correlation: str = dataclasses.field(default_factory=lambda: uuid.uuid4().hex)
    alive: bool = True
    ready: bool = False
    gemini: bool = False
    accept_permission: bool = False
    accept_request: object | None = None
    accept_inflight: bool = False
    accepted: bool = False
    media_connected: bool = False
    active: bool = False
    session: str | None = None
    spawned: bool = False
    spawn_cleanup_done: bool = False
    task: asyncio.Task | None = None


operation = contextvars.ContextVar("telegram_call_operation", default=None)


def guarded_client_class():
    from telethon import TelegramClient
    from telethon.tl.functions.phone import (
        AcceptCallRequest, DiscardCallRequest, ReceivedCallRequest, RequestCallRequest,
    )

    class GuardedClient(TelegramClient):
        # PyTgCalls selects its adapter from the client's module namespace.
        __module__ = TelegramClient.__module__
        current_call = None
        voice_runtime = None

        async def _call(self, sender, request, *args, **kwargs):
            requests = request if isinstance(request, (list, tuple)) else [request]
            captured = operation.get()
            accepts = 0
            if any(isinstance(rpc, AcceptCallRequest) for rpc in requests):
                if self.voice_runtime is None:
                    raise BridgeError("missing_voice_runtime")
                await self.voice_runtime.check()
            for rpc in requests:
                if isinstance(rpc, RequestCallRequest):
                    raise BridgeError("outgoing_call_forbidden")
                if isinstance(rpc, (AcceptCallRequest, DiscardCallRequest, ReceivedCallRequest)):
                    if captured is None or Peer(rpc.peer.id, rpc.peer.access_hash) != captured.peer:
                        raise BridgeError("call_peer_changed")
                    if isinstance(rpc, AcceptCallRequest):
                        accepts += 1
                        if (captured is not self.current_call or not captured.alive
                                or captured.accepted or captured.accept_inflight
                                or (not captured.accept_permission and captured.accept_request is not rpc)):
                            raise BridgeError("call_not_ready")
            if accepts:
                if accepts != 1:
                    raise BridgeError("duplicate_call_accept")
                captured.accept_permission = False
                captured.accept_request = next(rpc for rpc in requests if isinstance(rpc, AcceptCallRequest))
                captured.accept_inflight = True
                event("accept", correlation=captured.correlation)
            try:
                result = await super()._call(sender, request, *args, **kwargs)
                if accepts:
                    captured.accepted = True
                return result
            finally:
                if accepts:
                    captured.accept_inflight = False

    return GuardedClient


@contextlib.contextmanager
def pinned(call):
    token = operation.set(call)
    try:
        yield
    finally:
        operation.reset(token)


class Runtime:
    def __init__(self, receipt, helper):
        self.receipt = Path(receipt)
        self.helper = helper
        self.snapshot = self.receipt.read_text()
        self.values = {}
        for line in self.snapshot.splitlines():
            match = re.fullmatch(r'(SPUR_ISOLATED_[A-Z_]+)="([^"\n]*)"', line)
            if not match:
                raise BridgeError("invalid_runtime_receipt")
            self.values[match[1]] = match[2]
        self.url = self.values.get("SPUR_ISOLATED_DAEMON_URL", "")
        address = urlsplit(self.url)
        if (address.scheme != "http" or address.hostname not in ("127.0.0.1", "localhost", "::1")
                or address.port in (None, 4310) or address.username or address.path):
            raise BridgeError("unsafe_runtime_url")
        self.generation = None

    async def check(self):
        if self.receipt.read_text() != self.snapshot:
            raise BridgeError("runtime_replaced")
        keys = ("CONFIG", "UI_ENDPOINT_FILE", "DATA_DIR", "DAEMON_URL", "TMUX_SOCKET_NAME",
                "DAEMON_PID", "DAEMON_STARTTIME")
        args = [self.values.get("SPUR_ISOLATED_" + key, "") for key in keys]
        if self.generation:
            args.append(self.generation)
        proc = await asyncio.create_subprocess_exec(
            "node", self.helper, "--daemon-ready", *args,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), 5)
        except BaseException:
            proc.kill()
            await proc.wait()
            raise
        if proc.returncode or not stdout.strip():
            raise BridgeError("runtime_not_ready")
        self.generation = stdout.decode().strip()
        import yaml
        with Path(self.values["SPUR_ISOLATED_PROJECT_CONFIG"]).open() as config_file:
            config = yaml.safe_load(config_file)
        projects = config.get("projects") if isinstance(config, dict) else None
        if (not isinstance(projects, dict) or set(projects) != {"voice-sandbox"}
                or config.get("sources") or config.get("triggers") or config.get("sidecars")
                or any(project.get("sources") or project.get("triggers") or project.get("sidecars")
                       for project in projects.values())):
            raise BridgeError("unsafe_project_registry")


TERMINAL = {"stopped", "killed", "error", "rate_limited", "needs_input"}


def conversation(value):
    if (not isinstance(value, dict) or not isinstance(value.get("entries"), list)
            or type(value.get("startIndex")) is not int
            or type(value.get("totalEntries")) is not int
            or not isinstance(value.get("state"), str)):
        raise BridgeError("invalid_conversation")
    if (value["startIndex"] < 0 or value["totalEntries"] < value["startIndex"]
            or len(value["entries"]) != value["totalEntries"] - value["startIndex"]):
        raise BridgeError("invalid_conversation_cursor")
    return value


def assistant_text(entry):
    if (isinstance(entry, dict) and entry.get("kind") == "message"
            and entry.get("role") == "assistant" and isinstance(entry.get("text"), str)):
        return entry["text"]
    return None


def result_body(text, nonce):
    if text is None:
        return None
    lines = text.strip().splitlines()
    if (len(lines) >= 3 and lines[0] == "VOICE_RESULT:" + nonce
            and lines[-1] == "VOICE_END:" + nonce):
        body = "\n".join(lines[1:-1]).strip()
        return body or None
    return None


class Shepherd:
    def __init__(self, runtime, http):
        self.runtime = runtime
        self.http = http

    async def request(self, method, path, body=None):
        await self.runtime.check()
        response = await self.http.request(method, self.runtime.url + path, json=body, timeout=5)
        response.raise_for_status()
        try:
            return response.json()
        except (ValueError, TypeError) as exc:
            raise BridgeError("invalid_daemon_json") from exc

    async def transcript(self, session, cursor=0):
        return conversation(await self.request("GET", "/sessions/" + quote(session, safe="")
                                               + "/conversation?from=" + str(cursor)))

    async def prepare(self, call):
        nonce = uuid.uuid4().hex
        event("spawn_request", correlation=call.correlation)
        spawning = asyncio.create_task(self.request("POST", "/sessions/background", {
            "project": "spur-shepherd", "agent": "claude",
            "prompt": "Operate only voice-sandbox on this isolated daemon. Inspect initial session state. "
                      "Reply in one assistant message with exactly VOICE_READY:" + nonce,
        }))
        try:
            value = await asyncio.shield(spawning)
        except asyncio.CancelledError:
            # HTTP may already have created the agent. Retrieve its receipt before cleanup.
            try:
                value = await spawning
                if isinstance(value, dict) and isinstance(value.get("id"), str) and value["id"]:
                    call.session, call.spawned = value["id"], True
                    await self.stop_spawned(call)
            except Exception:
                event("spawn_receipt_unavailable", correlation=call.correlation)
            raise
        if not isinstance(value, dict) or not isinstance(value.get("id"), str) or not value["id"]:
            raise BridgeError("invalid_spawn_receipt")
        call.session, call.spawned = value["id"], True
        event("spawn_receipt", correlation=call.correlation)
        try:
            while call.alive:
                view = await self.transcript(call.session)
                if view["state"] in TERMINAL:
                    raise BridgeError("shepherd_not_ready")
                if any((assistant_text(entry) or "").strip() == "VOICE_READY:" + nonce for entry in view["entries"]):
                    call.ready = True
                    event("shepherd_ready", correlation=call.correlation)
                    return
                await asyncio.sleep(.5)
            raise BridgeError("call_discarded")
        finally:
            if not call.ready and call.spawned:
                await self.stop_spawned(call)

    async def stop_spawned(self, call):
        if call.spawned and call.session and not call.spawn_cleanup_done:
            call.spawn_cleanup_done = True
            try:
                await self.request("POST", "/sessions/" + quote(call.session, safe="") + "/kill", {})
            except Exception:
                event("spawn_cleanup_failed", correlation=call.correlation)

    async def dispatch(self, call, message, nonce):
        if not call.alive or not call.session:
            raise BridgeError("call_discarded")
        initial = await self.transcript(call.session)
        cursor = initial["totalEntries"]
        prompt = ("Operate only voice-sandbox on this isolated daemon. Operator request: " + message
                  + "\nAfter handling this request, put your final operator answer in one assistant message "
                  "with standalone first line VOICE_RESULT:" + nonce
                  + " and standalone last line VOICE_END:" + nonce
                  + ". Put interim commentary outside that envelope. Report worker dispatch as dispatch; "
                  "claim completion only after checking worker result. Finish this turn after the envelope.")
        await self.request("POST", "/sessions/" + quote(call.session, safe="") + "/send", {"message": prompt})
        return cursor

    async def answer(self, call, cursor, nonce):
        high = cursor
        while call.alive:
            # Re-read mutable tail; never advance past an unfinished assistant entry.
            view = await self.transcript(call.session, cursor)
            if view["totalEntries"] < high or view["startIndex"] > cursor:
                raise BridgeError("transcript_reset")
            high = view["totalEntries"]
            if view["state"] in TERMINAL:
                raise BridgeError("shepherd_unavailable")
            if view["state"] == "waiting":
                for entry in view["entries"]:
                    body = result_body(assistant_text(entry), nonce)
                    if body:
                        return body
            await asyncio.sleep(.5)
        raise BridgeError("call_discarded")


class PCM:
    # NTgCalls v3.0.3 audio_sink.cpp: PCM16, frame_time=10ms, rate*2/100 bytes.
    def __init__(self, limit, frame_size):
        self.limit = limit
        self.frame_size = frame_size
        self.data = bytearray()
        self.generation = 0
        self.available = asyncio.Event()

    def put(self, data):
        if not isinstance(data, bytes):
            raise BridgeError("invalid_pcm")
        if len(self.data) + len(data) > self.limit:
            raise BridgeError("audio_overflow")
        self.data.extend(data)
        self.available.set()

    def clear(self):
        self.generation += 1
        self.data.clear()
        self.available.clear()

    def finish(self):
        if len(self.data) % 2:
            raise BridgeError("incomplete_pcm_sample")
        if self.data and len(self.data) % self.frame_size:
            self.data.extend(bytes(self.frame_size - len(self.data) % self.frame_size))
        self.available.set()

    async def take(self):
        while len(self.data) < self.frame_size:
            self.available.clear()
            await self.available.wait()
        frame = bytes(self.data[:self.frame_size])
        del self.data[:self.frame_size]
        return self.generation, frame


NOTICE_NAMES = ("starting", "waiting", "ready", "shepherd-failed", "voice-failed", "timeout")


def load_notices(directory):
    notices = {}
    for name in NOTICE_NAMES:
        try:
            with wave.open(str(Path(directory) / (name + ".wav")), "rb") as audio:
                if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, 24000, "NONE"):
                    raise ValueError("format")
                count = audio.getnframes()
                if not 0 < count <= 8 * 24000:
                    raise ValueError("duration")
                data = audio.readframes(count)
                if len(data) != count * 2 or not any(data):
                    raise ValueError("content")
                notices[name] = data
        except (OSError, EOFError, wave.Error, ValueError) as error:
            raise BridgeError("invalid_notice_" + name) from error
    return notices


class Playback:
    def __init__(self, listener, call):
        self.listener, self.call = listener, call
        self.output = PCM(240000, 480)
        self.native = None
        self.lock = asyncio.Lock()
        self.inflight = None
        self.due = time.monotonic()

    def invalidate(self):
        self.output.clear()
        if self.inflight:
            self.inflight.cancel()

    def check(self):
        if (not self.call.alive or not self.call.media_connected
                or self.native is None or not self.native.owns()):
            raise BridgeError("media_unavailable")

    async def frame(self, frame, generation):
        from pytgcalls.types import Device
        async with self.lock:
            if generation != self.output.generation:
                return
            await asyncio.sleep(max(0, self.due - time.monotonic()))
            self.check()
            if generation != self.output.generation:
                return
            self.inflight = asyncio.create_task(self.listener.calls.send_frame(
                self.call.user, Device.MICROPHONE, frame))
            try:
                await self.inflight
            except asyncio.CancelledError:
                if asyncio.current_task().cancelling():
                    raise
            except Exception:
                self.call.media_connected = False
                raise
            finally:
                self.inflight = None
            self.due = time.monotonic() + .01

    async def notice(self, name):
        try:
            await self._notice(name)
        except Exception:
            self.call.media_connected = False
            raise

    async def _notice(self, name):
        data = self.listener.notices[name]
        async with asyncio.timeout(len(data) / 48000 + 2):
            self.check()
            generation = self.output.generation
            event("status_started", correlation=self.call.correlation, status=name)
            for offset in range(0, len(data), 480):
                await self.frame(data[offset:offset + 480].ljust(480, b"\0"), generation)
            await asyncio.sleep(max(0, self.due - time.monotonic()) + .05)
            self.check()
            if generation != self.output.generation:
                raise BridgeError("status_interrupted")
            event("status_finished", correlation=self.call.correlation, status=name)

    async def live(self):
        while True:
            generation, frame = await self.output.take()
            await self.frame(frame, generation)


class NativeCall:
    def __init__(self, listener, call, writer):
        from ntgcalls import NTgCalls
        self.listener, self.call, self.writer = listener, call, writer
        self.binding = NTgCalls()
        self.retired = False
        self.tasks = set()
        self.loop = asyncio.get_running_loop()
        self.register()
        listener.native = self
        listener.calls._binding = self.binding
        writer.native = self

    def owns(self):
        return (not self.retired and self.listener.current is self.call
                and self.listener.native is self and self.listener.calls._binding is self.binding)

    def register(self):
        calls = self.listener.calls
        routes = (("on_stream_end", calls._handle_stream_ended, 3),
                  ("on_upgrade", calls._update_status, 2),
                  ("on_connection_change", None, 2),
                  ("on_update_emojis", calls._handle_emojis_update, 2),
                  ("on_signaling_data", calls._app.send_signaling, 2),
                  ("on_frames", calls._handle_stream_frame, 4))
        for setter, handler, count in routes:
            try:
                inspect.signature(handler or calls._handle_connection_changed).bind(*([None] * count))
            except (ValueError, TypeError) as error:
                raise BridgeError("unsupported_native_callback_" + setter) from error
            def callback(*args, handler=handler):
                if not self.retired:
                    self.loop.call_soon_threadsafe(self.deliver, handler, args)
            getattr(self.binding, setter)(callback)

    def deliver(self, handler, args):
        from ntgcalls import ConnectionState
        if not self.owns() or args[0] != self.call.user:
            return
        if handler is None:
            state = args[1].state
            if state == ConnectionState.CONNECTING:
                return
            if state != ConnectionState.CONNECTED:
                self.call.media_connected = False
                self.call.alive = False
                self.writer.invalidate()
                waiter = self.listener.calls._wait_connect.get(self.call.user)
                if waiter is not None and not waiter.done():
                    waiter.set_exception(BridgeError("native_connection_lost"))
                    waiter.exception()
                if self.call.task:
                    self.call.task.cancel()
                return
            handler = self.listener.calls._handle_connection_changed

        async def forward():
            if self.owns() and self.call.alive:
                with pinned(self.call):
                    await handler(*args)
        task = asyncio.create_task(forward())
        self.tasks.add(task)
        def completed(finished):
            self.tasks.discard(finished)
            if not finished.cancelled() and finished.exception() and self.owns():
                self.call.media_connected = False
                self.call.alive = False
                self.writer.invalidate()
                if self.call.task:
                    self.call.task.cancel()
                event("native_callback_failed", correlation=self.call.correlation)
        task.add_done_callback(completed)

    def retire(self):
        self.retired = True
        self.call.media_connected = False
        self.writer.invalidate()

    async def close(self):
        from ntgcalls import ConnectionNotFound
        tasks = [task for task in self.tasks if task is not asyncio.current_task()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        try:
            try:
                await asyncio.wait_for(self.binding.stop(self.call.user), 5)
            except ConnectionNotFound:
                pass
            except Exception:
                event("native_cleanup_failed", correlation=self.call.correlation)
        finally:
            try:
                await asyncio.wait_for(self.listener.discard(self.call), 5)
            except Exception:
                event("media_cleanup_failed", correlation=self.call.correlation)
            finally:
                try:
                    self.listener.calls._clear_cache(self.call.user)
                finally:
                    if self.listener.native is self:
                        self.listener.native = None


class Tools:
    def __init__(self, call, shepherd, live, types):
        self.call, self.shepherd, self.live, self.types = call, shepherd, live, types
        self.pending = None
        self.pending_id = None
        self.dispatch_tasks = {}

    def schedule(self, function):
        task = asyncio.create_task(self.handle(function))
        self.dispatch_tasks[task] = function.id
        def completed(finished):
            self.dispatch_tasks.pop(finished, None)
            if not finished.cancelled() and finished.exception():
                event("tool_response_failed", correlation=self.call.correlation)
                self.call.task.cancel()
        task.add_done_callback(completed)

    async def receipt(self, function, response):
        await self.live.send_tool_response(function_responses=[self.types.FunctionResponse(
            id=function.id, name=function.name, response=response,
        )])

    async def handle(self, function):
        args = function.args
        if (function.name != "ask_shepherd" or not isinstance(args, dict)
                or set(args) != {"message"} or not isinstance(args["message"], str)
                or not 0 < len(args["message"].strip()) <= 8000):
            await self.receipt(function, {"status": "invalid_request"})
            return
        if self.pending is not None:
            await self.receipt(function, {"status": "busy"})
            return
        nonce = uuid.uuid4().hex
        deadline = time.monotonic() + 90
        # Reserve before await; simultaneous server functions cannot both dispatch.
        self.pending = asyncio.current_task()
        self.pending_id = function.id
        try:
            cursor = await self.shepherd.dispatch(self.call, args["message"], nonce)
            await self.receipt(function, {"status": "dispatched", "request_id": function.id})
            self.pending = asyncio.create_task(self.wait_answer(cursor, nonce, deadline))
        except Exception:
            self.pending = None
            self.pending_id = None
            await self.receipt(function, {"status": "dispatch_failed"})

    async def wait_answer(self, cursor, nonce, deadline):
        try:
            try:
                answer = await asyncio.wait_for(self.shepherd.answer(self.call, cursor, nonce),
                                                max(0, deadline - time.monotonic()))
                text = "Shepherd result: " + answer
            except Exception:
                text = "Shepherd request failed or timed out. Completion is unconfirmed."
            if self.call.alive:
                await self.live.send_client_content(turns=self.types.Content(
                    role="user", parts=[self.types.Part(text=text)]), turn_complete=True)
        finally:
            self.pending = None
            self.pending_id = None

    async def cancel(self, ids):
        # Gemini withdrew its function request; delegated jobs remain owned by Shepherd.
        tasks = [task for task, function_id in self.dispatch_tasks.items() if function_id in ids]
        if self.pending is not None and self.pending_id in ids:
            if self.pending not in tasks:
                tasks.append(self.pending)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if self.pending in tasks:
            self.pending = None
            self.pending_id = None

    async def close(self):
        for task in list(self.dispatch_tasks):
            task.cancel()
        await asyncio.gather(*self.dispatch_tasks, return_exceptions=True)
        if self.pending is not None and self.pending is not asyncio.current_task():
            self.pending.cancel()
            await asyncio.gather(self.pending, return_exceptions=True)


def read_inputs():
    try:
        from dotenv import dotenv_values
    except ModuleNotFoundError as error:
        raise BridgeError("input_dependencies_missing_run_check_deps") from error
    required = ("TG_API_ID", "TG_API_HASH", "TG_SESSION", "GEMINI_API_KEY",
                "GEMINI_LIVE_MODEL", "TELEGRAM_ALLOWED_USERS", "TELEGRAM_CALL_EXCLUSIVE_SESSION")
    values = {}
    filename = os.environ.get("TELEGRAM_CALL_ENV_FILE")
    if filename:
        path = Path(filename)
        artifacts = os.environ.get("SPUR_SESSION_ARTIFACTS_DIR")
        if artifacts and path.resolve().is_relative_to(Path(artifacts).resolve()):
            raise BridgeError("credentials_in_artifacts")
        if path.stat().st_mode & 0o077:
            raise BridgeError("credential_file_permissions")
        values.update({key: value for key, value in dotenv_values(path).items() if key in required})
    allowlist = os.environ.get("TELEGRAM_CALL_ALLOWLIST_FILE")
    if allowlist and Path(allowlist).is_file():
        values.setdefault("TELEGRAM_ALLOWED_USERS", dotenv_values(allowlist).get("TELEGRAM_ALLOWED_USERS"))
    for key in required:
        if os.environ.get(key):
            values[key] = os.environ[key]
        if not values.get(key):
            raise BridgeError("missing_" + key)
    if not str(values["TG_API_ID"]).isdigit() or int(values["TG_API_ID"]) <= 0:
        raise BridgeError("invalid_TG_API_ID")
    ids = re.split(r"[,\s]+", values["TELEGRAM_ALLOWED_USERS"].strip())
    if not ids or any(not item.isdigit() or int(item) <= 0 for item in ids):
        raise BridgeError("invalid_TELEGRAM_ALLOWED_USERS")
    if values["TELEGRAM_CALL_EXCLUSIVE_SESSION"] != "1":
        raise BridgeError("account_exclusivity_unconfirmed")
    values["allowed"] = {int(item) for item in ids}
    return values


def private_session(values):
    state = Path(os.environ.get("TELEGRAM_CALL_STATE_DIR", "~/.cache/spur/telegram-call")).expanduser()
    artifacts = os.environ.get("SPUR_SESSION_ARTIFACTS_DIR")
    if artifacts and state.resolve().is_relative_to(Path(artifacts).resolve()):
        raise BridgeError("private_state_in_artifacts")
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    state.chmod(0o700)
    source = Path(values["TG_SESSION"]).expanduser().resolve()
    if source.suffix != ".session":
        source = source.with_suffix(".session")
    if artifacts and source.is_relative_to(Path(artifacts).resolve()):
        raise BridgeError("telegram_session_in_artifacts")
    lock_dir = Path.home() / ".cache/spur/telegram-call-locks"
    lock_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_dir.chmod(0o700)
    lock = (lock_dir / (str(uuid.uuid5(uuid.NAMESPACE_URL, str(source))) + ".lock")).open("a")
    os.chmod(lock.name, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        lock.close()
        raise BridgeError("account_listener_busy") from exc
    target = state / (str(uuid.uuid5(uuid.NAMESPACE_URL, str(source))) + ".session")
    try:
        with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as original:
            with sqlite3.connect(target) as copy:
                original.backup(copy)
    except BaseException:
        lock.close()
        raise
    target.chmod(0o600)
    return lock, target


async def check_dependencies():
    notices = load_notices(Path(__file__).with_name("audio"))
    for package, version in (("py-tgcalls", "3.0.0"), ("ntgcalls", "3.0.3"), ("Telethon", "1.44.0")):
        if importlib.metadata.version(package) != version:
            raise BridgeError("unsupported_dependency_" + package)
    from telethon import TelegramClient
    from pytgcalls.mtproto.telethon_client import TelethonClient
    from pytgcalls import PyTgCalls
    from pytgcalls.types import ExternalMedia, MediaStream, RecordStream
    from pytgcalls.types.raw.audio_parameters import AudioParameters
    from ntgcalls import StreamMode, StreamDevice, FrameData, ConnectionInfo, ConnectionKind, ConnectionState
    from pytgcalls.methods.utilities.stream_params import StreamParams
    import google.genai
    if "flood_sleep_threshold" not in inspect.signature(TelegramClient._call).parameters:
        raise BridgeError("unsupported_telegram_rpc_hook")
    if "self._app._call(" not in inspect.getsource(TelethonClient._invoke):
        raise BridgeError("unsupported_pytgcalls_rpc_route")
    if ConnectionInfo(ConnectionState.CONNECTED, ConnectionKind.NORMAL).state != ConnectionState.CONNECTED:
        raise BridgeError("unsupported_native_connection_state")
    outgoing = MediaStream(ExternalMedia.AUDIO, audio_parameters=AudioParameters(24000, 1))
    incoming = RecordStream(audio=True, audio_parameters=AudioParameters(16000, 1))
    client = guarded_client_class()(None, 1, "offline-probe")
    calls = PyTgCalls(client)
    listener = Listener({}, None, client, calls, None, None, None, 60000, notices)
    call = Call(Peer(1, 1), 1, 0)
    listener.current = call
    native = NativeCall(listener, call, Playback(listener, call))
    engine = native.binding
    try:
        await engine.create_p2p_call(1)
        await engine.set_stream_sources(1, StreamMode.CAPTURE, await StreamParams.get_stream_params(outgoing))
        await engine.set_stream_sources(1, StreamMode.PLAYBACK, await StreamParams.get_record_params(incoming))
        await engine.send_external_frame(1, StreamDevice.MICROPHONE, bytes(480), FrameData())
    finally:
        native.retire()
        try:
            await engine.stop(1)
        finally:
            calls.executor.shutdown(wait=False)
    event("dependencies_ready", input_rate=16000, output_rate=24000, channels=1,
          frame_ms=10, frame_bytes=480, network=False)
    return notices


class Listener:
    def __init__(self, values, runtime, client, calls, shepherd, gemini, types, ring_ms, notices):
        self.values, self.runtime, self.client, self.calls = values, runtime, client, calls
        self.shepherd, self.gemini, self.types, self.ring_ms = shepherd, gemini, types, ring_ms
        self.current = None
        self.seen = set()
        self.tasks = set()
        self.input = None
        self.native = None
        self.notices = notices

    def schedule(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        def completed(finished):
            self.tasks.discard(finished)
            if not finished.cancelled() and finished.exception():
                event("listener_task_failed")
        task.add_done_callback(completed)
        return task

    async def discard(self, call):
        from telethon.tl.functions.phone import DiscardCallRequest
        from telethon.tl.types import InputPhoneCall, PhoneCallDiscardReasonHangup
        with pinned(call):
            await self.client(DiscardCallRequest(
                peer=InputPhoneCall(call.peer.id, call.peer.access_hash), duration=0,
                reason=PhoneCallDiscardReasonHangup(), connection_id=0,
            ))

    async def raw(self, update):
        from telethon.tl.types import UpdatePhoneCall, PhoneCallRequested, PhoneCallDiscarded
        if not isinstance(update, UpdatePhoneCall):
            return
        phone = update.phone_call
        if isinstance(phone, PhoneCallDiscarded):
            if self.current and self.current.peer.id == phone.id:
                self.current.media_connected = False
                self.current.alive = False
                if self.current.task:
                    self.current.task.cancel()
            return
        if not isinstance(phone, PhoneCallRequested) or phone.id in self.seen:
            return
        self.seen.add(phone.id)
        if len(self.seen) > 1024:
            # Session duration is bounded; prevent unbounded duplicate metadata retention.
            self.seen = {phone.id}
        call = Call(Peer(phone.id, phone.access_hash), phone.admin_id, time.monotonic())
        if self.current is not None or call.user not in self.values["allowed"]:
            if self.current and self.current.user == call.user:
                self.current.media_connected = False
                self.current.alive = False
                self.current.task.cancel()
            self.schedule(self.reject(call))
            return
        self.current = call
        self.client.current_call = call
        event("ring", correlation=call.correlation)
        # Return to update delivery so the library can populate its incoming-call cache.
        call.task = self.schedule(self.run_call(call))

    async def reject(self, call):
        try:
            await self.discard(call)
        except Exception:
            event("reject_failed", correlation=call.correlation)

    async def frames(self, _, update):
        from pytgcalls.types import StreamFrames, Direction, Device
        if (isinstance(update, StreamFrames) and self.current and self.current.active
                and update.chat_id == self.current.user and update.direction == Direction.INCOMING
                and update.device == Device.MICROPHONE and self.input):
            try:
                for frame in update.frames:
                    self.input.put(frame.frame)
            except BridgeError:
                self.current.task.cancel()
                event("input_audio_overflow", correlation=self.current.correlation)

    async def run_call(self, call):
        from telethon.tl.functions.phone import ReceivedCallRequest
        from telethon.tl.types import InputPhoneCall
        from pytgcalls.types import ExternalMedia, MediaStream, RecordStream
        from pytgcalls.types.raw.audio_parameters import AudioParameters
        deadline = call.received + min(45, self.ring_ms / 1000 - 5)
        live_context = None
        live = None
        tasks = []
        tools = None
        writer = Playback(self, call)
        native = None
        output = writer.output
        failure_notice = None
        try:
            if deadline <= time.monotonic():
                raise BridgeError("ring_budget_expired")
            async with asyncio.timeout_at(deadline):
                await self.runtime.check()
                with pinned(call):
                    await self.client(ReceivedCallRequest(InputPhoneCall(call.peer.id, call.peer.access_hash)))
                await self.runtime.check()
                if not call.alive or self.current is not call:
                    raise BridgeError("call_discarded")
                native = NativeCall(self, call, writer)
                call.accept_permission = True
                with pinned(call):
                    await self.calls.play(call.user, MediaStream(
                        ExternalMedia.AUDIO, audio_parameters=AudioParameters(24000, 1)))
            if not call.alive:
                raise BridgeError("call_discarded")
            call.media_connected = True
            duration_deadline = time.monotonic() + 480
            event("media_connected", correlation=call.correlation)
            await writer.notice("starting")
            failure_notice = "voice-failed"
            live_context = self.gemini.aio.live.connect(model=self.values["GEMINI_LIVE_MODEL"], config={
                "response_modalities": ["AUDIO"],
                "system_instruction": "Speak with the operator. Use ask_shepherd for every orchestration "
                    "request. A dispatched receipt confirms submission only. Relay labelled Shepherd "
                    "results faithfully; claim worker completion only when confirmed. Sandbox only.",
                "tools": [{"function_declarations": [{"name": "ask_shepherd",
                    "description": "Dispatch a request to this call's sandbox Shepherd.",
                    "parameters": {"type": "OBJECT", "properties": {"message": {"type": "STRING"}},
                                   "required": ["message"]}}]}],
            })

            async def setup():
                nonlocal live
                live = await live_context.__aenter__()
                call.gemini = True
                event("gemini_ready", correlation=call.correlation)

            await self.prepare_services(call, writer, setup)
            await self.runtime.check()
            await writer.notice("ready")
            self.input = PCM(64000, 320)
            with pinned(call):
                await self.calls.record(call.user, RecordStream(
                    audio=True, audio_parameters=AudioParameters(16000, 1)))
            call.active = True
            event("conversation_started", correlation=call.correlation)
            tools = Tools(call, self.shepherd, live, self.types)

            async def input_pump():
                while True:
                    _, frame = await self.input.take()
                    await live.send_realtime_input(audio=self.types.Blob(data=frame, mime_type="audio/pcm;rate=16000"))

            async def receive():
                while True:
                    received = False
                    async for response in live.receive():
                        received = True
                        if response.go_away:
                            raise BridgeError("gemini_go_away")
                        content = response.server_content
                        if content:
                            if content.interrupted:
                                writer.invalidate()
                            if content.model_turn:
                                for part in content.model_turn.parts or []:
                                    if part.inline_data and part.inline_data.data:
                                        if part.inline_data.mime_type != "audio/pcm;rate=24000":
                                            raise BridgeError("unexpected_audio_format")
                                        output.put(part.inline_data.data)
                            if content.turn_complete:
                                output.finish()
                        if response.tool_call:
                            for function in response.tool_call.function_calls or []:
                                tools.schedule(function)
                        if response.tool_call_cancellation:
                            await tools.cancel(response.tool_call_cancellation.ids or [])
                    if not received:
                        raise BridgeError("gemini_closed")

            tasks = [asyncio.create_task(fn()) for fn in (writer.live, input_pump, receive)]
            async with asyncio.timeout_at(duration_deadline):
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
        except asyncio.CancelledError:
            event("call_cancelled", correlation=call.correlation)
        except Exception as error:
            reason = str(error) if isinstance(error, BridgeError) else type(error).__name__
            event("call_failed", correlation=call.correlation, reason=reason)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            tasks.clear()
            if tools:
                await tools.close()
                tools = None
            writer.invalidate()
            notice = error.notice if isinstance(error, StartupFailure) else failure_notice
            if isinstance(error, TimeoutError):
                notice = None if call.active else "timeout"
            if notice and call.alive and call.media_connected and self.client.is_connected():
                try:
                    await writer.notice(notice)
                except Exception:
                    event("status_failed", correlation=call.correlation, status=notice)
            else:
                event("status_skipped", correlation=call.correlation, reason="media_unavailable")
        finally:
            call.alive = False
            call.active = False
            if native:
                native.retire()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if tools:
                await tools.close()
            writer.invalidate()
            if self.input:
                self.input.clear()
            if live_context and live:
                try:
                    await asyncio.wait_for(live_context.__aexit__(None, None, None), 5)
                except Exception:
                    event("live_cleanup_failed", correlation=call.correlation)
            try:
                if native:
                    await native.close()
                else:
                    try:
                        await asyncio.wait_for(self.discard(call), 5)
                    except Exception:
                        event("media_cleanup_failed", correlation=call.correlation)
            finally:
                try:
                    await self.shepherd.stop_spawned(call)
                finally:
                    if self.current is call:
                        self.current = None
                        self.client.current_call = None
                        self.input = None
                    event("call_ended", correlation=call.correlation, sandbox_jobs_retained=True)

    async def prepare_services(self, call, writer, setup):
        owners = {asyncio.create_task(self.shepherd.prepare(call)): "shepherd-failed",
                  asyncio.create_task(setup()): "voice-failed"}
        pending = set(owners)
        started = time.monotonic()
        notice_index = 0
        try:
            async with asyncio.timeout(45):
                while pending:
                    due = started + (15, 30, 45)[notice_index]
                    done, pending = await asyncio.wait(pending, timeout=max(0, due - time.monotonic()),
                                                       return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        try:
                            task.result()
                        except Exception as error:
                            raise StartupFailure(owners[task]) from error
                    if pending and not done and notice_index < 2:
                        if all(task.done() for task in pending):
                            continue
                        await writer.notice("waiting")
                        notice_index += 1
        finally:
            for task in owners:
                task.cancel()
            await asyncio.gather(*owners, return_exceptions=True)

    async def close(self):
        if self.current:
            self.current.media_connected = False
            self.current.alive = False
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def main():
    if sys.argv[1:] == ["--check-inputs"]:
        read_inputs()
        event("inputs_ready")
        return
    notices = await check_dependencies()
    if sys.argv[1:] == ["--check-deps"]:
        return
    if sys.argv[1:]:
        raise BridgeError("unknown_argument")
    values = read_inputs()
    runtime = Runtime(os.environ["TELEGRAM_CALL_RUNTIME_FILE"], os.environ["TELEGRAM_CALL_ENDPOINT_HELPER"])
    await runtime.check()
    lock, session = private_session(values)
    from telethon import events
    from telethon.tl.functions.help import GetConfigRequest
    from pytgcalls import PyTgCalls
    from google import genai
    from google.genai import types
    import httpx
    client = None
    calls = None
    gemini = None
    listener = None
    lifecycle_tasks = []
    try:
        client = guarded_client_class()(str(session), int(values["TG_API_ID"]), values["TG_API_HASH"],
                                        base_logger=telegram_logger())
        client.voice_runtime = runtime
        await client.connect()
        if not await client.is_user_authorized():
            raise BridgeError("telegram_session_unauthorized")
        config = await client(GetConfigRequest())
        if type(config.call_ring_timeout_ms) is not int or config.call_ring_timeout_ms <= 5000:
            raise BridgeError("invalid_ring_budget")
        calls = PyTgCalls(client)
        async with httpx.AsyncClient() as http:
            try:
                gemini = genai.Client(api_key=values["GEMINI_API_KEY"])
                listener = Listener(values, runtime, client, calls, Shepherd(runtime, http), gemini, types,
                                    config.call_ring_timeout_ms, notices)
                client.add_event_handler(listener.raw, events.Raw())
                calls.on_update()(listener.frames)
                await calls.start()
                disconnected = asyncio.create_task(client.run_until_disconnected())
                lifecycle_tasks.append(disconnected)
                await client.set_receive_updates(True)
                if disconnected.done():
                    await disconnected
                    raise BridgeError("telegram_disconnected")
                if not client.is_connected():
                    raise BridgeError("telegram_disconnected")
                stop = asyncio.Event()
                for signum in (signal.SIGTERM, signal.SIGINT):
                    asyncio.get_running_loop().add_signal_handler(signum, stop.set)
                stopped = asyncio.create_task(stop.wait())
                lifecycle_tasks.append(stopped)
                event("listener_ready")
                done, _ = await asyncio.wait(lifecycle_tasks, return_when=asyncio.FIRST_COMPLETED)
                if disconnected in done:
                    await disconnected
                    raise BridgeError("telegram_disconnected")
            finally:
                try:
                    if listener:
                        await listener.close()
                finally:
                    for task in lifecycle_tasks:
                        task.cancel()
                    await asyncio.gather(*lifecycle_tasks, return_exceptions=True)
    finally:
        try:
            if listener:
                try:
                    client.remove_event_handler(listener.raw)
                finally:
                    if calls:
                        calls.remove_handler(listener.frames)
        finally:
            try:
                if gemini:
                    await gemini.aio.aclose()
            finally:
                try:
                    if client:
                        await client.disconnect()
                finally:
                    lock.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except BridgeError as error:
        event("startup_failed", reason=str(error))
        sys.exit(1)
    except Exception:
        event("startup_failed", reason="dependency_or_runtime_failure")
        sys.exit(1)
