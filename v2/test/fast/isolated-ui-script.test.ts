import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  join(import.meta.dirname, "../../../scripts/spur-isolated-ui.sh"),
  "utf8",
);

describe("spur-isolated-ui.sh", () => {
  it("binds the sidecar web server to loopback only", () => {
    expect(script).toContain('WEB_HOST="127.0.0.1"');
    expect(script).not.toContain("0.0.0.0");
  });
});
