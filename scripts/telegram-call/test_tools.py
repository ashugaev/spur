import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from google.genai import types

import bridge


def conversation(text, start=4, total=5, state="waiting"):
    entries = [] if text is None else [{"kind": "message", "role": "assistant", "text": text}]
    return {"entries": entries, "startIndex": start, "totalEntries": total, "state": state}


class ShepherdBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.runtime = SimpleNamespace(url="http://127.0.0.1:9999", check=AsyncMock())
        self.call = bridge.Call(bridge.Peer(1, 2), 3, 0, session="owned/session")

    async def test_http_tail_mutation_truncation_malformed_json_and_timeout(self):
        await self.same_tail_mutation()
        await self.cursor_truncation()
        self.runtime.check.reset_mock()
        await self.malformed_json()
        self.runtime.check.reset_mock()
        await self.http_timeout()

    async def same_tail_mutation(self):
        tail = conversation("VOICE_RESULT:n\nPartial", state="working")
        paths = []

        def respond(request):
            paths.append(request.url.path + "?" + request.url.query.decode())
            return httpx.Response(200, json=tail)

        async def mutate(_):
            tail["entries"][0]["text"] = "VOICE_RESULT:n\nWorker dispatched.\nVOICE_END:n"
            tail["state"] = "waiting"

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
            shepherd = bridge.Shepherd(self.runtime, http)
            with patch("bridge.asyncio.sleep", side_effect=mutate):
                self.assertEqual(await shepherd.answer(self.call, 4, "n"), "Worker dispatched.")
        self.assertEqual(paths, ["/sessions/owned/session/conversation?from=4"] * 2)
        self.assertEqual(self.runtime.check.await_count, 2)

    async def cursor_truncation(self):
        for replies in ([conversation(None, 5, 5)],
                        [conversation("partial"), conversation(None, 4, 4)]):
            with self.subTest(replies=replies):
                pending = iter(replies)
                transport = httpx.MockTransport(lambda _: httpx.Response(200, json=next(pending)))
                async with httpx.AsyncClient(transport=transport) as http:
                    with patch("bridge.asyncio.sleep", new=AsyncMock()):
                        with self.assertRaisesRegex(bridge.BridgeError, "transcript_reset"):
                            await bridge.Shepherd(self.runtime, http).answer(self.call, 4, "n")

    async def malformed_json(self):
        transport = httpx.MockTransport(lambda _: httpx.Response(200, content=b"{bad"))
        async with httpx.AsyncClient(transport=transport) as http:
            with self.assertRaisesRegex(bridge.BridgeError, "invalid_daemon_json"):
                await bridge.Shepherd(self.runtime, http).request("GET", "/status")
        self.runtime.check.assert_awaited_once()

    async def http_timeout(self):
        def timeout(request):
            self.assertEqual(set(request.extensions["timeout"].values()), {5})
            raise httpx.ReadTimeout("offline timeout", request=request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(timeout)) as http:
            with self.assertRaises(httpx.ReadTimeout):
                await bridge.Shepherd(self.runtime, http).request("POST", "/send", {})
        self.runtime.check.assert_awaited_once()


class ToolBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.call = bridge.Call(bridge.Peer(1, 2), 3, 0, session="pinned-session")
        self.shepherd = SimpleNamespace(dispatch=AsyncMock(return_value=4), answer=AsyncMock())
        self.live = SimpleNamespace(send_tool_response=AsyncMock(), send_client_content=AsyncMock())
        self.tools = bridge.Tools(self.call, self.shepherd, self.live, types)
        self.addAsyncCleanup(self.tools.close)

    def function(self, identity):
        return types.FunctionCall(id=identity, name="ask_shepherd", args={"message": "launch worker"})

    def receipts(self):
        return [item.kwargs["function_responses"][0]
                for item in self.live.send_tool_response.await_args_list]

    async def test_simultaneous_dispatch_receipts_and_honest_failures(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def dispatch(call, message, nonce):
            self.assertIs(call, self.call)
            self.assertEqual(call.session, "pinned-session")
            entered.set()
            await release.wait()
            return 4

        self.shepherd.dispatch.side_effect = dispatch
        self.shepherd.answer.side_effect = asyncio.CancelledError
        self.tools.schedule(self.function("first"))
        await asyncio.wait_for(entered.wait(), 1)
        self.tools.schedule(self.function("second"))
        await asyncio.gather(*[task for task in self.tools.dispatch_tasks if task is not self.tools.pending])
        self.assertEqual([(r.id, r.name, r.response) for r in self.receipts()],
                         [("second", "ask_shepherd", {"status": "busy"})])
        release.set()
        await asyncio.gather(*self.tools.dispatch_tasks)
        self.shepherd.dispatch.assert_awaited_once()
        receipt = self.receipts()[-1]
        self.assertEqual((receipt.id, receipt.name, receipt.response),
                         ("first", "ask_shepherd", {"status": "dispatched", "request_id": "first"}))
        self.live.send_client_content.assert_not_awaited()
        await self.tools.close()
        self.tools = bridge.Tools(self.call, self.shepherd, self.live, types)
        self.live.send_tool_response.reset_mock()
        self.shepherd.answer.reset_mock()
        await self.dispatch_failure()
        await self.answer_failure()

    async def dispatch_failure(self):
        self.shepherd.dispatch.side_effect = httpx.ReadTimeout("offline timeout")
        await self.tools.handle(self.function("failed"))
        receipt = self.receipts()[0]
        self.assertEqual((receipt.id, receipt.name, receipt.response),
                         ("failed", "ask_shepherd", {"status": "dispatch_failed"}))
        self.shepherd.answer.assert_not_awaited()
        self.live.send_client_content.assert_not_awaited()
        self.assertIsNone(self.tools.pending)

    async def answer_failure(self):
        for error in (bridge.BridgeError("transcript_reset"), None):
            with self.subTest(error=error):
                self.live.send_client_content.reset_mock()
                self.shepherd.answer.side_effect = error
                await self.tools.wait_answer(4, "n", bridge.time.monotonic() - 1 if error is None
                                             else bridge.time.monotonic() + 1)
                self.live.send_client_content.assert_awaited_once()
                kwargs = self.live.send_client_content.await_args.kwargs
                self.assertEqual(kwargs["turns"].parts[0].text,
                                 "Shepherd request failed or timed out. Completion is unconfirmed.")
                self.assertTrue(kwargs["turn_complete"])
                self.assertIsNone(self.tools.pending)

    async def test_cancel_close_and_hangup_suppress_late_delivery(self):
        for phase in ("dispatch", "answer", "gemini_cancel", "gemini_cancel_dispatch"):
            with self.subTest(phase=phase):
                entered = asyncio.Event()

                async def blocked(*_):
                    entered.set()
                    await asyncio.Event().wait()

                self.shepherd.dispatch.side_effect = blocked if phase.endswith("dispatch") else None
                self.shepherd.answer.side_effect = blocked
                self.tools.schedule(self.function(phase))
                await asyncio.wait_for(entered.wait(), 1)
                pending = self.tools.pending
                if phase.startswith("gemini_cancel"):
                    await self.tools.cancel(["unrelated"])
                    self.assertFalse(pending.done())
                    await self.tools.cancel([phase])
                    self.assertTrue(pending.cancelled())
                self.call.alive = False
                await asyncio.wait_for(self.tools.close(), 1)
                self.assertTrue(pending.cancelled())
                self.assertFalse(self.tools.dispatch_tasks)
                self.live.send_client_content.assert_not_awaited()
                self.tools = bridge.Tools(self.call, self.shepherd, self.live, types)
                self.call.alive = True
        await self.hangup_after_answer()

    async def hangup_after_answer(self):
        async def answer(*_):
            self.call.alive = False
            return "Worker completed."

        self.shepherd.answer.side_effect = answer
        await self.tools.wait_answer(4, "n", bridge.time.monotonic() + 1)
        self.assertEqual(self.shepherd.answer.await_args.args, (self.call, 4, "n"))
        self.live.send_client_content.assert_not_awaited()
        self.assertIsNone(self.tools.pending)
