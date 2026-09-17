import { test, expect } from "./fixtures.js";

// Runs inside a worker process, which re-requires playwright.config.ts. Passing
// here proves the harness memo survived the fork: the worker's baseURL is the
// port webServer actually bound, not a second allocation.
test("the run targets the harness UI port and an unbound daemon", async ({ baseURL }) => {
  test.skip(!process.env["SPUR_WEB_TEST_ISOLATION"], "external target, harness not in play");

  expect(baseURL).toBe(`http://127.0.0.1:${process.env["SPUR_WEB_TEST_UI_PORT"]}`);
  expect(baseURL).not.toContain(":5555");
  expect(process.env["SPUR_DAEMON_URL"]).not.toContain(":4310");
  expect(process.env["SPUR_CONFIG"]).not.toContain("/.spur/config.yaml");
  expect(process.env["SPUR_TMUX_SOCKET_NAME"]).toBe(
    `spur-web-test-${new URL(process.env["SPUR_DAEMON_URL"] ?? "http://x").port}`,
  );
});
