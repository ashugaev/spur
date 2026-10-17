import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import process from "node:process";

test("recovery requires enabled units and changed PID after kill", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spur-recovery-test-"));
  try {
    const bin = join(dir, "bin");
    const lock = join(dir, "lock");
    await mkdir(bin);
    await mkdir(lock);
    await writeFile(join(lock, "owner"), "test\n");
    await writeFile(join(dir, "pid"), "111\n");
    const commands = {
      systemctl: `#!/usr/bin/env bash
[[ "$1" = --user ]] && shift
case "$1" in
is-enabled) [[ "\${FAKE_DISABLED:-}" != 1 ]] ;;
is-active) exit 0 ;;
show) cat "$FAKE_STATE" ;;
kill|restart) [[ "\${FAKE_NO_PID_CHANGE:-}" = 1 ]] || echo 222 > "$FAKE_STATE" ;;
*) exit 2 ;;
esac
`,
      loginctl: "#!/bin/sh\necho yes\n",
      node: '#!/bin/sh\nif [ "$1" = --input-type=module ] && [ "$3" = "$ITEST_MCP_PACKAGE_ROOT" ]; then echo "http://127.0.0.1:4317/mcp http://127.0.0.1:4316"; else echo \'{"initialized":true}\'; fi\n',
      sleep: "#!/bin/sh\nexit 0\n",
    };
    for (const [name, text] of Object.entries(commands))
      await writeFile(join(bin, name), text, { mode: 0o700 });
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_STATE: join(dir, "pid"),
      ITEST_VM_LOCK_DIR: lock,
      ITEST_MCP_SCOPE: "user",
      ITEST_MCP_PACKAGE_ROOT: join(dir, "package"),
      ITEST_MCP_BUILD_ID: "b".repeat(64),
      ITEST_MCP_EVIDENCE_DIR: join(dir, "evidence"),
    };
    const run = (mode, extra = {}) =>
      execFileSync("bash", [resolve("tests/itest/mcp-recovery.sh"), mode], {
        env: { ...env, ...extra },
        stdio: "pipe",
      });
    run("check");
    assert.equal(
      JSON.parse(await readFile(join(dir, "evidence/probe.json"), "utf8")).initialized,
      true,
    );
    run("mcp-kill");
    assert.match(
      await readFile(join(dir, "evidence/mcp-kill.before"), "utf8"),
      /spur-mcp.service 111/,
    );
    assert.match(
      await readFile(join(dir, "evidence/mcp-kill.after"), "utf8"),
      /spur-mcp.service 222/,
    );
    assert.throws(() => run("mcp-kill", { FAKE_NO_PID_CHANGE: "1" }));
    assert.throws(() => run("check", { FAKE_DISABLED: "1" }));
    assert.throws(() => run("check", { ITEST_VM_LOCK_DIR: join(dir, "absent") }));
    assert.throws(() => run("check", { ITEST_MCP_URL: "http://127.0.0.1:4311/mcp" }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
