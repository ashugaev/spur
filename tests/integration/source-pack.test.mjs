import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { URL } from "node:url";

test("source packing has a private Go bootstrap that does not leak into npm installation", async () => {
  const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
  const onboarding = await readFile(new URL("./onboarding-test.sh", import.meta.url), "utf8");
  const bootstrap = dockerfile.match(/^COPY --from=go-bootstrap \/usr\/local\/go (.+)$/m)?.[1];
  assert.ok(bootstrap, "the source packaging fixture must supply its own Go bootstrap");
  assert.doesNotMatch(dockerfile, /^ENV PATH=.*spur-build-go/m);
  const pack = onboarding.split("\n").find((line) => line.includes("npm pack --json ./v2"));
  assert.ok(pack);
  const directory = await mkdtemp(join(tmpdir(), "spur-onboarding-pack-"));
  try {
    const bin = join(directory, "bin");
    const go = join(directory, "go");
    await mkdir(bin);
    await mkdir(join(go, "bin"), { recursive: true });
    await writeFile(
      join(bin, "npm"),
      '#!/bin/bash\nif [[ "$1" == pack ]]; then command -v go >/dev/null || exit 10; go; else command -v go >/dev/null && exit 11; printf "install-without-go\\n"; fi\n',
      { mode: 0o755 },
    );
    await writeFile(join(go, "bin", "go"), '#!/bin/bash\nprintf "source-bootstrap\\n"\n', {
      mode: 0o755,
    });
    const command = pack.slice(0, pack.indexOf(' > "$PACK_LOG"')).replace(bootstrap, go);
    const output = execFileSync(
      "/bin/bash",
      ["-e", "-c", `${command}\nnpm install -g fixture.tgz`],
      {
        env: { PATH: bin },
        encoding: "utf8",
      },
    );
    assert.equal(output, "source-bootstrap\ninstall-without-go\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
