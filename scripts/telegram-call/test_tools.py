import asyncio
import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from google import genai
from google.genai import types

import bridge


def session(identity="agent-1", **changes):
    return {"id": identity, "project": "voice-sandbox", "agent": "codex",
            "status": "running", "state": "working", "runtimeAlive": True, **changes}


def transcript(entries):
    return {"entries": entries, "startIndex": 4, "totalEntries": 4 + len(entries),
            "state": "working", "messages": [], "durationMs": 0, "hasMore": True}


class DirectToolsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.runtime = SimpleNamespace(url="http://127.0.0.1:9999", generation="owned-generation",
                                       check=AsyncMock())
        self.call = bridge.Call(bridge.Peer(1, 2), 3, 0)
        self.call.task = asyncio.current_task()
        self.live = SimpleNamespace(send_tool_response=AsyncMock(), send_client_content=AsyncMock())
        self.requests = []
        self.projects = [{"id": "voice-sandbox", "name": "Sandbox", "configured": True},
                         {"id": "spur-shepherd", "name": "Shepherd", "configured": True}]
        self.responses = {
            ("GET", "/projects"): self.projects,
            ("GET", "/sessions?view=dashboard"): [session()],
            ("GET", "/sessions/agent-1"): session(),
            ("GET", "/sessions/agent-1/conversation"): transcript([]),
            ("POST", "/sessions/background"): session(status="spawning"),
            ("POST", "/sessions/agent-1/send"): session(),
        }
        self.respond = None
        self.http = httpx.AsyncClient(transport=httpx.MockTransport(self.transport))
        self.daemon = bridge.AgentDaemon(self.runtime, self.http)
        self.tools = bridge.Tools(self.call, self.daemon, self.live, types)
        self.addAsyncCleanup(self.http.aclose)
        self.addAsyncCleanup(self.tools.close)

    async def transport(self, request):
        self.requests.append(request)
        self.assertEqual((request.url.host, request.url.port), ("127.0.0.1", 9999))
        self.assertEqual(set(request.extensions["timeout"].values()), {5})
        if self.respond:
            result = await self.respond(request)
            if result is not None:
                return result
        path = request.url.raw_path.decode()
        self.assertIn((request.method, path), self.responses)
        return httpx.Response(200, json=self.responses[(request.method, path)],
                              headers={"x-spur-lifecycle-instance-id": self.runtime.generation})

    def function(self, name="list_agents", args=None, identity="request-1"):
        return types.FunctionCall(id=identity, name=name, args={} if args is None else args)

    def receipts(self):
        return [item.kwargs["function_responses"][0]
                for item in self.live.send_tool_response.await_args_list]

    async def invoke(self, name="list_agents", args=None, identity="request-1"):
        await self.tools.handle(self.function(name, args, identity))
        receipt = self.receipts()[-1]
        self.assertEqual((receipt.id, receipt.name), (identity, name))
        self.assertIsInstance(receipt, types.FunctionResponse)
        return receipt.response

    def paths(self):
        return [(request.method, request.url.raw_path.decode()) for request in self.requests]

    async def settle(self):
        await asyncio.gather(*list(self.tools.dispatch_tasks))
        await asyncio.sleep(0)

    async def test_four_sdk_declarations_and_invalid_arguments_never_reach_daemon(self):
        declared = types.Tool(function_declarations=bridge.TOOL_DECLARATIONS)
        self.assertEqual([item.name for item in declared.function_declarations],
                         ["list_agents", "read_agent", "start_agent", "send_to_agent"])
        invalid = [
            ("ask_shepherd", {"message": "start"}), ("list_agents", {"url": "external"}),
            ("read_agent", {}), ("read_agent", {"session_id": "../other"}),
            ("read_agent", {"session_id": 12}), ("read_agent", {"session_id": "agent-1", "from": 0}),
            ("read_agent", {"session_id": "a" * 129}),
            ("start_agent", {"project": "production", "prompt": "start"}),
            ("start_agent", {"project": "voice-sandbox", "prompt": "start", "agent": "unknown"}),
            ("start_agent", {"project": "voice-sandbox", "prompt": "start", "model": "custom"}),
            ("start_agent", {"project": "voice-sandbox", "prompt": "  "}),
            ("start_agent", {"project": "voice-sandbox", "prompt": "x" * 8001}),
            ("send_to_agent", {"session_id": "agent-1", "message": ""}),
            ("send_to_agent", {"session_id": "agent-1", "message": False}),
            ("send_to_agent", {"session_id": "agent-1", "message": "x" * 8001}),
            ("send_to_agent", {"session_id": "agent-1", "message": "hello", "config": "other"}),
        ]
        for index, (name, args) in enumerate(invalid):
            with self.subTest(name=name, args=list(args)):
                self.assertEqual(await self.invoke(name, args, str(index)), {"status": "invalid_request"})
        self.assertEqual(self.requests, [])
        self.runtime.check.assert_not_awaited()

    async def test_public_live_connection_serializes_supported_four_tool_wire_schema(self):
        socket = SimpleNamespace(send=AsyncMock(), recv=AsyncMock(return_value='{"setupComplete": {}}'))
        connection = AsyncMock()
        connection.__aenter__.return_value = socket
        client = genai.Client(api_key="offline-key")
        try:
            with patch("google.genai.live.ws_connect", return_value=connection):
                async with client.aio.live.connect(model="configured", config=bridge.live_config()) as session:
                    self.assertIsNotNone(session.setup_complete)
        finally:
            await client.aio.aclose()
            client.close()
        wire = json.loads(socket.send.await_args.args[0])
        self.assertNotIn("additional_properties", json.dumps(wire))
        self.assertNotIn("additionalProperties", json.dumps(wire))
        tools = wire["setup"]["tools"][0]["functionDeclarations"]
        self.assertEqual([tool["name"] for tool in tools], list(bridge.TOOL_ARGUMENTS))
        for tool in tools:
            properties, required = bridge.TOOL_ARGUMENTS[tool["name"]]
            self.assertEqual(set(tool["parameters"]), {"type", "properties", "required"})
            self.assertEqual(tool["parameters"]["type"], "OBJECT")
            self.assertEqual(tool["parameters"].get("required", []), list(required))
            self.assertEqual(set(tool["parameters"].get("properties", {})), set(properties))
            for name, schema in properties.items():
                expected = { {"minLength": "min_length", "maxLength": "max_length"}.get(key, key): value
                            for key, value in schema.items()}
                self.assertEqual(tool["parameters"]["properties"][name], expected)
        start = next(tool for tool in tools if tool["name"] == "start_agent")
        self.assertEqual(start["parameters"]["properties"]["project"]["enum"], list(bridge.PROJECTS))
        self.assertEqual(start["parameters"]["properties"]["agent"]["enum"], list(bridge.PROVIDERS))
        for name, (properties, _) in bridge.TOOL_ARGUMENTS.items():
            args = {key: "unused" for key in properties}
            with self.assertRaises(bridge.BridgeError):
                bridge.tool_arguments(name, {**args, "unknown": "blocked"})

    async def test_maximum_text_and_identity_bounds_are_accepted(self):
        maximum = "A_-" + "z" * 125
        self.responses[("GET", "/sessions/" + maximum)] = session(maximum)
        self.responses[("POST", "/sessions/" + maximum + "/send")] = session(maximum)
        result = await self.invoke("send_to_agent", {"session_id": maximum, "message": "x" * 8000})
        self.assertEqual(result["status"], "submitted")
        self.assertEqual(self.paths()[-1], ("POST", "/sessions/" + maximum + "/send"))
        self.assertEqual(json.loads(self.requests[-1].content)["message"], "x" * 8000)

    async def test_list_caps_sessions_and_projects_and_removes_private_fields(self):
        self.projects[0].update(name="S" * 101, path="private-path", environment="private-env")
        self.responses[("GET", "/sessions?view=dashboard")] = [
            session(f"agent-{index}", prompt="private-prompt", cwd="private-cwd") for index in range(51)]
        result = await self.invoke()
        self.assertEqual((result["status"], len(result["sessions"]), result["truncated"]),
                         ("observed", 50, True))
        self.assertEqual(result["projects"][0], {"id": "voice-sandbox", "name": "S" * 100})
        self.assertEqual(result["supported_providers"], ["claude", "codex", "cursor", "opencode"])
        self.assertEqual(result["provider_availability"], "unconfirmed")
        self.assertEqual(set(result["sessions"][0]),
                         {"id", "project", "agent", "status", "state", "runtime_alive"})
        self.assertNotIn("private-", json.dumps(result))
        self.assertEqual(self.paths(), [("GET", "/projects"), ("GET", "/sessions?view=dashboard")])
        self.assertEqual(self.runtime.check.await_count, 2)

    async def test_read_returns_only_assistant_tail_and_tool_presence(self):
        entries = [{"kind": "message", "role": "user", "text": "private-user"},
                   {"kind": "reasoning", "text": "private-reasoning"},
                   {"kind": "tool", "name": "exec", "inputSummary": "private-input", "output": "private-output"}]
        entries += [{"kind": "message", "role": "assistant", "text": f"{index}:" + "x" * 1001}
                    for index in range(10)]
        self.responses[("GET", "/sessions/agent-1/conversation")] = transcript(entries)
        result = await self.invoke("read_agent", {"session_id": "agent-1"})
        self.assertEqual(result["assistant_messages"], [entry["text"][:1000] for entry in entries[-8:]])
        self.assertEqual(sum(map(len, result["assistant_messages"])), 8000)
        self.assertEqual(result["latest_tool"], {"name": "exec", "output_present": True})
        self.assertEqual((result["start_index"], result["total_entries"]), (4, 17))
        self.assertEqual((result["completion"], result["conversation_state"]), ("unverified", "working"))
        self.assertTrue(result["truncated"])
        self.assertNotIn("private-", json.dumps(result))
        self.assertEqual(self.paths()[-1], ("GET", "/sessions/agent-1/conversation"))

    async def test_start_and_send_return_submissions_without_reading_completion(self):
        result = await self.invoke("start_agent", {"project": "voice-sandbox", "prompt": "  work  "})
        self.assertEqual((result["status"], result["session"]["status"]), ("submitted", "spawning"))
        body = json.loads(self.requests[-1].content)
        self.assertEqual(set(body), {"project", "prompt"})
        self.assertTrue(body["prompt"].endswith("Operator request: work"))
        self.assertIn('"$SPUR_SESSION_TOOL_DIR/spur"', body["prompt"])
        self.assertIn("Do not change shell profiles", body["prompt"])
        self.assertEqual(self.paths(), [("GET", "/projects"), ("POST", "/sessions/background")])
        result = await self.invoke("send_to_agent", {"session_id": "agent-1", "message": "  continue  "}, "send")
        self.assertEqual((result["status"], result["session"]["state"]), ("submitted", "working"))
        self.assertEqual(json.loads(self.requests[-1].content), {"message": "continue"})
        self.assertNotIn(("GET", "/sessions/agent-1/conversation"), self.paths())
        self.live.send_client_content.assert_not_awaited()
        self.responses[("POST", "/sessions/background")] = session(project="spur-shepherd", agent="claude")
        result = await self.invoke("start_agent", {"project": "spur-shepherd", "prompt": "coordinate", "agent": "claude"}, "shepherd")
        self.assertEqual(result["status"], "submitted")
        self.assertEqual(json.loads(self.requests[-1].content)["agent"], "claude")
        self.assertFalse(any("/shepherd/spawn" in path for _, path in self.paths()))

    async def test_unsafe_projects_sessions_headers_and_redirects_fail_before_mutation(self):
        cases = [
            ("projects", [{"id": "outside", "name": "Outside", "configured": True}]),
            ("projects", [{"id": "voice-sandbox", "name": "Sandbox", "configured": False}]),
            ("session", session(project="outside")), ("session", session("other")),
            ("session", session(agent="unsupported")), ("session", session(runtimeAlive="true")),
        ]
        for index, (kind, value) in enumerate(cases):
            with self.subTest(kind=kind, index=index):
                self.requests.clear()
                async def respond(request):
                    if kind == "projects" and request.url.path == "/projects":
                        return httpx.Response(200, json=value)
                    if kind == "session" and request.url.path == "/sessions/agent-1":
                        return httpx.Response(200, json=value)
                self.respond = respond
                result = await self.invoke("send_to_agent", {"session_id": "agent-1", "message": "continue"}, str(index))
                self.assertEqual(result["status"], "error")
                self.assertFalse(any(method == "POST" for method, _ in self.paths()))
        for index, headers in enumerate(({}, {"x-spur-lifecycle-instance-id": "other"})):
            async def changed(request):
                if request.url.path == "/sessions":
                    return httpx.Response(200, json=[session()], headers=headers)
            self.respond = changed
            result = await self.invoke(identity=f"header-{index}")
            self.assertEqual(result, {"status": "error", "reason": "unsafe_runtime"})
        async def redirect(request):
            return httpx.Response(307, headers={"location": "http://example.invalid/private"})
        self.respond = redirect
        self.assertEqual(await self.invoke(identity="redirect"), {"status": "error", "reason": "unsafe_runtime"})

    async def test_malformed_receipts_and_http_timeouts_are_unconfirmed_only_after_mutation(self):
        for index, failure in enumerate(("json", "shape", "timeout")):
            async def failed(request):
                if request.method == "POST":
                    if failure == "timeout":
                        raise httpx.ReadTimeout("offline", request=request)
                    return httpx.Response(200, content=b"{bad") if failure == "json" else httpx.Response(200, json={})
            self.respond = failed
            result = await self.invoke("start_agent", {"project": "voice-sandbox", "prompt": "work"}, str(index))
            self.assertEqual(result["status"], "unconfirmed")
        self.assertEqual(sum(request.method == "POST" for request in self.requests), 3)
        async def read_timeout(request):
            raise httpx.ReadTimeout("offline", request=request)
        self.respond = read_timeout
        self.assertEqual((await self.invoke(identity="read-timeout"))["status"], "error")

    async def test_invalid_read_json_cursor_entries_and_hidden_unsafe_list_row_fail_closed(self):
        for index, value in enumerate(({}, transcript([{"kind": "message", "role": "assistant", "text": 7}]),
                                       {**transcript([]), "totalEntries": 20},
                                       transcript([{"kind": "tool", "name": "../path", "output": "private"}]))):
            self.responses[("GET", "/sessions/agent-1/conversation")] = value
            result = await self.invoke("read_agent", {"session_id": "agent-1"}, f"read-{index}")
            self.assertEqual(result["status"], "error")
            self.assertNotIn("private", json.dumps(result))
        async def bad_json(request):
            return httpx.Response(200, content=b"{invalid-json")
        self.respond = bad_json
        self.assertEqual((await self.invoke(identity="bad-json"))["status"], "error")
        self.respond = None
        self.responses[("GET", "/sessions?view=dashboard")] = [session(f"agent-{index}") for index in range(50)] + [
            session("hidden", project="outside")]
        self.assertEqual(await self.invoke(identity="hidden-unsafe"), {"status": "error", "reason": "unsafe_runtime"})
        self.assertFalse(any(method == "POST" for method, _ in self.paths()))

    async def test_runtime_replacement_prevents_http_and_logs_no_operator_text(self):
        self.runtime.check.side_effect = bridge.BridgeError("runtime_replaced")
        with patch("bridge.event") as logs:
            result = await self.invoke("start_agent", {"project": "voice-sandbox", "prompt": "private-operator-text"})
        self.assertEqual(result, {"status": "error", "reason": "unsafe_runtime"})
        self.assertEqual(self.requests, [])
        self.assertNotIn("private-operator-text", repr(logs.call_args_list))
        self.assertTrue(any(item.args[0] == "tool_failed" for item in logs.call_args_list))

    async def test_busy_duplicate_limit_and_queued_withdrawal_do_not_redispatch(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def blocked(request):
            if request.method == "POST":
                entered.set()
                await release.wait()
        self.respond = blocked
        first = self.function("start_agent", {"project": "voice-sandbox", "prompt": "work"}, "first")
        self.tools.schedule(first)
        await asyncio.wait_for(entered.wait(), 1)
        self.assertEqual(await self.invoke(identity="busy"), {"status": "busy"})
        self.assertEqual(await self.invoke("start_agent", first.args, "first"), {"status": "duplicate_request"})
        release.set()
        await self.settle()
        self.assertEqual(sum(request.method == "POST" for request in self.requests), 1)
        for index in range(125):
            await self.invoke("invalid", {}, f"invalid-{index}")
        # first + busy +125 invalid IDs =127; admit one more, then refuse.
        self.assertEqual(await self.invoke("invalid", {}, "last"), {"status": "invalid_request"})
        self.assertEqual(await self.invoke(identity="over-limit"), {"status": "request_limit"})
        self.assertEqual(len(self.tools.seen), 128)

    async def test_queued_cancellation_prevents_any_http_request(self):
        self.tools.schedule(self.function("start_agent", {"project": "voice-sandbox", "prompt": "work"}))
        await self.tools.cancel(["request-1"])
        self.assertEqual(self.requests, [])
        self.assertEqual(self.receipts(), [])

    async def test_cancel_after_mutation_and_hangup_suppress_responses_without_rollback(self):
        for index, hangup in enumerate((False, True)):
            entered = asyncio.Event()
            async def blocked(request):
                if request.method == "POST":
                    entered.set()
                    await asyncio.Event().wait()
            self.respond = blocked
            identity = f"mutation-{index}"
            self.tools.schedule(self.function("start_agent", {"project": "voice-sandbox", "prompt": "work"}, identity))
            await asyncio.wait_for(entered.wait(), 1)
            if hangup:
                self.call.alive = False
                await self.tools.close()
            else:
                await self.tools.cancel([identity])
            self.assertIsNone(self.tools.pending)
            self.assertFalse(self.tools.dispatch_tasks)
            self.assertEqual(self.receipts(), [])
        self.assertEqual(sum(request.method == "POST" for request in self.requests), 2)
        self.assertFalse(any("kill" in path for _, path in self.paths()))

    async def test_whole_operation_timeout_includes_runtime_check_and_lost_post(self):
        original_timeout = asyncio.timeout
        deadlines = []
        def shortened(seconds):
            deadlines.append(seconds)
            return original_timeout(0.01)
        async def blocked_check():
            await asyncio.Event().wait()
        self.runtime.check.side_effect = blocked_check
        with patch("bridge.asyncio.timeout", side_effect=shortened):
            self.assertEqual(await self.invoke(), {"status": "error", "reason": "timeout"})
        self.assertEqual(self.requests, [])
        self.runtime.check.side_effect = None
        async def blocked_post(request):
            if request.method == "POST":
                await asyncio.Event().wait()
        self.respond = blocked_post
        with patch("bridge.asyncio.timeout", side_effect=shortened):
            result = await self.invoke("start_agent", {"project": "voice-sandbox", "prompt": "work"}, "lost-post")
        self.assertEqual(result, {"status": "unconfirmed", "reason": "timeout"})
        self.assertEqual(deadlines, [10, 10])
        self.assertEqual(sum(request.method == "POST" for request in self.requests), 1)


if __name__ == "__main__":
    unittest.main()
