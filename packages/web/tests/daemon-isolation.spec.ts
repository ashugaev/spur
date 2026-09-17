import { test, expect } from "./fixtures.js";

// Runs inside a worker process, which re-requires playwright.config.ts. Passing
// here proves the harness memo survived the fork: the worker's baseURL is the
// port webServer actually bound, not a second allocation.
//
// Skips only when an EXTERNAL target is indicated — the one case where the
// harness is legitimately out of play. Never on SPUR_WEB_TEST_ISOLATION itself:
// that is the condition under test, and skipping on it would let a config with
// no harness branch report green while the run silently retargets the
// production UI. Asserts on resolved env only, never a navigation.
test("the run targets the harness UI port and an unbound daemon", async ({ baseURL }) => {
  const externalTarget = Boolean(
    process.env["PLAYWRIGHT_BASE_URL"] ||
    (!process.env["CI"] && (process.env["SPUR_SESSION"] || process.env["SPUR_SESSION_TOOL_DIR"])),
  );
  test.skip(externalTarget, "external target, harness not in play");

  expect(process.env["SPUR_WEB_TEST_ISOLATION"]).toBe("1");
  expect(baseURL).toBe(`http://127.0.0.1:${process.env["SPUR_WEB_TEST_UI_PORT"]}`);
  expect(baseURL).not.toContain(":5555");
  expect(process.env["SPUR_DAEMON_URL"]).not.toContain(":4310");
  expect(process.env["SPUR_CONFIG"]).not.toContain("/.spur/config.yaml");
  expect(process.env["SPUR_TMUX_SOCKET_NAME"]).toBe(
    `spur-web-test-${new URL(process.env["SPUR_DAEMON_URL"] ?? "http://x").port}`,
  );
});
