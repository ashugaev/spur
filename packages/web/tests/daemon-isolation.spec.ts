import { test, expect } from "./fixtures.js";

// Runs inside a worker process, which re-requires playwright.config.ts. Passing
// here proves the harness memo survived the fork: the worker's baseURL is the
// port webServer actually bound, not a second allocation.
//
// Skips only when an EXTERNAL target is indicated — the one case where the
// harness is legitimately out of play. Every other assertion demands a PRESENT
// value first: with the harness branch removed the env is empty, and a
// not-production check alone would pass on undefined.
test("the run targets the harness UI port and an unbound daemon", async ({ baseURL }) => {
  const externalTarget = Boolean(
    process.env["PLAYWRIGHT_BASE_URL"] ||
    (!process.env["CI"] && (process.env["SPUR_SESSION"] || process.env["SPUR_SESSION_TOOL_DIR"])),
  );
  test.skip(externalTarget, "external target, harness not in play");

  const daemonUrl = process.env["SPUR_DAEMON_URL"] ?? "";
  const configPath = process.env["SPUR_CONFIG"] ?? "";
  const uiPort = process.env["SPUR_WEB_TEST_UI_PORT"] ?? "";

  expect(uiPort).toMatch(/^\d+$/);
  expect(uiPort).not.toBe("5555");
  expect(baseURL).toBe(`http://127.0.0.1:${uiPort}`);
  expect(daemonUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(daemonUrl).not.toContain(":4310");
  expect(configPath).toMatch(/\/spur-web-test-[^/]+\/config\.yaml$/);
  expect(process.env["SPUR_TMUX_SOCKET_NAME"]).toBe(`spur-web-test-${new URL(daemonUrl).port}`);
});
