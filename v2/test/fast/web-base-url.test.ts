import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWebBaseUrl } from "../../src/ports.js";
import { createTempDir } from "../helpers/common.js";

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
