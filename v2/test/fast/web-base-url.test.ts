import { access, writeFile } from "node:fs/promises";
import type * as childProcessModule from "node:child_process";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveWebBaseUrl } from "../../src/ports.js";
import { createTempDir } from "../helpers/common.js";
import { publishIsolatedWebEndpoint } from "../../src/isolated-web-endpoint.js";

// portLine is written between literal single quotes in the fixture script,
// so it must contain none itself.
async function makeFakeSpurSidecar(jsonBody: string | null): Promise<string> {
  const dir = await createTempDir("spur-sidecar-fixture-");
  const body =
    jsonBody === null
      ? "#!/usr/bin/env bash\nexit 1\n"
      : `#!/usr/bin/env bash\nprintf '%s' '${jsonBody}'\n`;
  await writeFile(join(dir, "spur-sidecar"), body, { mode: 0o755 });
  return dir;
}

describe("resolveWebBaseUrl", () => {
  it("never invokes unresolved parent helper when receipt contract is selected", async () => {
    const dir = await makeFakeSpurSidecar("[]");
    const configPath = join(dir, "config.yaml");
    const filePath = join(dir, "ui-endpoint.json");
    await writeFile(configPath, "server: {port: 4321}\n");
    await publishIsolatedWebEndpoint({ configPath, filePath, port: 5642, pid: process.pid });
    const unresolved = vi.fn();
    vi.doMock("node:child_process", async () => ({
      ...(await vi.importActual<typeof childProcessModule>("node:child_process")),
      execFile: unresolved,
    }));
    vi.resetModules();
    try {
      const fresh = await import("../../src/ports.js");
      const env = {
        SPUR_SESSION_TOOL_DIR: dir,
        SPUR_ISOLATED_CONFIG: configPath,
        SPUR_ISOLATED_UI_ENDPOINT_FILE: filePath,
      };
      expect(await fresh.resolveWebBaseUrl(5555, env)).toBe("http://127.0.0.1:5642");
      expect(
        await fresh.resolveWebBaseUrl(5555, {
          ...env,
          SPUR_ISOLATED_CONFIG: join(dir, "wrong.yaml"),
        }),
      ).toBeNull();
      expect(unresolved).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
  it("uses own receipt immediately and never invokes parent helper or falls through on stopped receipt", async () => {
    const dir = await createTempDir("spur-ui-endpoint-resolver-");
    const config = join(dir, "config.yaml");
    const file = join(dir, "ui-endpoint.json");
    const marker = join(dir, "helper-called");
    await writeFile(config, "server: {port: 4321}\n");
    await writeFile(join(dir, "spur-sidecar"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, {
      mode: 0o755,
    });
    const env = {
      SPUR_SESSION_TOOL_DIR: dir,
      SPUR_ISOLATED_CONFIG: config,
      SPUR_ISOLATED_UI_ENDPOINT_FILE: file,
    };
    expect(await resolveWebBaseUrl(5555, env)).toBeNull();
    await publishIsolatedWebEndpoint({
      configPath: config,
      filePath: file,
      port: 5642,
      pid: process.pid,
    });
    expect(await resolveWebBaseUrl(5555, env)).toBe("http://127.0.0.1:5642");
    await writeFile(file, "{}", { mode: 0o600 });
    expect(await resolveWebBaseUrl(5555, env)).toBeNull();
    await expect(access(marker)).rejects.toThrow();
  });
  it("trusts config.ui.port directly when this process has no SPUR_SESSION_TOOL_DIR (a normally-started daemon)", async () => {
    const url = await resolveWebBaseUrl(5555, {});
    expect(url).toBe("http://127.0.0.1:5555");
  });

  // SPUR_SESSION_TOOL_DIR set means this process is itself an isolated
  // daemon: past that point config.ui.port (5555 here, indistinguishable
  // from the host's real production port) must never come back out of this
  // function again, on any path — missing or unusable registry tooling is
  // exactly as "unknown" as every other failure below.
  it("fails closed (never config.ui.port) when SPUR_SESSION_TOOL_DIR is set but has no spur-sidecar tool", async () => {
    const toolDir = await createTempDir("spur-tool-dir-empty-");
    const url = await resolveWebBaseUrl(5555, { SPUR_SESSION_TOOL_DIR: toolDir });
    expect(url).toBeNull();
  });

  it("fails closed (never config.ui.port) when spur-sidecar exists but is not executable", async () => {
    const toolDir = await createTempDir("spur-tool-dir-not-exec-");
    await writeFile(join(toolDir, "spur-sidecar"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o644,
    });
    const url = await resolveWebBaseUrl(5555, { SPUR_SESSION_TOOL_DIR: toolDir });
    expect(url).toBeNull();
  });

  it("reads the exact port the outer session's sidecar registry reports for isolated-ui — the SAME port isolated-ui actually binds", async () => {
    const toolDir = await makeFakeSpurSidecar(
      JSON.stringify([
        { sidecar: "isolated-ui", id: "ui", env: "SPUR_RESERVED_PORT_UI", port: 5642, alive: true },
      ]),
    );
    const url = await resolveWebBaseUrl(5555, { SPUR_SESSION_TOOL_DIR: toolDir });
    expect(url).toBe("http://127.0.0.1:5642");
  });

  // The outer CLI + daemon round trip measured 4-12s on a loaded host; a 5s
  // budget answered "disabled" with the UI alive.
  it("waits past 5s for a slow sidecar registry call", { timeout: 15_000 }, async () => {
    const dir = await createTempDir("spur-sidecar-slow-");
    const row = JSON.stringify([{ sidecar: "isolated-ui", port: 5642, alive: true }]);
    await writeFile(
      join(dir, "spur-sidecar"),
      `#!/usr/bin/env bash\nsleep 6\nprintf '%s' '${row}'\n`,
      { mode: 0o755 },
    );
    const url = await resolveWebBaseUrl(5555, { SPUR_SESSION_TOOL_DIR: dir });
    expect(url).toBe("http://127.0.0.1:5642");
  });

  it("resolves to null when the isolated-ui reservation is not alive (sidecar stopped)", async () => {
    const toolDir = await makeFakeSpurSidecar(
      JSON.stringify([
        {
          sidecar: "isolated-ui",
          id: "ui",
          env: "SPUR_RESERVED_PORT_UI",
          port: 5607,
          alive: false,
        },
      ]),
    );
    const url = await resolveWebBaseUrl(5555, { SPUR_SESSION_TOOL_DIR: toolDir });
    expect(url).toBeNull();
  });

  it("resolves to null (fail closed), never config.ui.port's 5555, when isolated-ui has no reservation yet", async () => {
    const toolDir = await makeFakeSpurSidecar("[]");
    const url = await resolveWebBaseUrl(5555, { SPUR_SESSION_TOOL_DIR: toolDir });
    expect(url).toBeNull();
  });

  it("resolves to null when the sidecar registry call itself fails", async () => {
    const toolDir = await makeFakeSpurSidecar(null);
    const url = await resolveWebBaseUrl(5555, { SPUR_SESSION_TOOL_DIR: toolDir });
    expect(url).toBeNull();
  });

  it("resolves to null on malformed JSON rather than throwing or guessing", async () => {
    const toolDir = await makeFakeSpurSidecar("not json");
    const url = await resolveWebBaseUrl(5555, { SPUR_SESSION_TOOL_DIR: toolDir });
    expect(url).toBeNull();
  });
});
