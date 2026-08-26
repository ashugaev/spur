import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendUpdateLedgerLine,
  readUpdateLedger,
  updateLedgerPath,
} from "../../src/update-ledger.js";

async function newLedgerPath(): Promise<string> {
  return updateLedgerPath(await mkdtemp(join(tmpdir(), "spur-update-ledger-")));
}

describe("update ledger", () => {
  it("round-trips both line kinds into their own maps, fields and all", async () => {
    const path = await newLedgerPath();
    appendUpdateLedgerLine(path, {
      kind: "blocked",
      version: "0.67.2",
      failureKind: "rolled_back",
      at: "2026-08-24T15:17:02Z",
    });
    appendUpdateLedgerLine(path, {
      kind: "blocked",
      version: "0.68.1",
      failureKind: "install_unhealthy",
      at: "2026-08-25T09:00:00Z",
    });
    appendUpdateLedgerLine(path, {
      kind: "disarmed",
      version: "0.67.2",
      at: "2026-08-24T15:22:00Z",
    });

    const ledger = readUpdateLedger(path);
    expect([...ledger.blocked.keys()]).toEqual(["0.67.2", "0.68.1"]);
    expect([...ledger.disarmed.keys()]).toEqual(["0.67.2"]);
    // `failureKind` and `at` reach the read side instead of being write-only.
    expect(ledger.blocked.get("0.67.2")).toEqual({
      kind: "blocked",
      version: "0.67.2",
      failureKind: "rolled_back",
      at: "2026-08-24T15:17:02Z",
    });
    expect(ledger.blocked.get("0.68.1")?.failureKind).toBe("install_unhealthy");
    expect(ledger.disarmed.get("0.67.2")?.at).toBe("2026-08-24T15:22:00Z");
  });

  it("keeps the first line for a version when a later one repeats it", async () => {
    const path = await newLedgerPath();
    appendUpdateLedgerLine(path, {
      kind: "blocked",
      version: "0.67.2",
      failureKind: "rolled_back",
      at: "2026-08-24T15:17:02Z",
    });
    appendUpdateLedgerLine(path, {
      kind: "blocked",
      version: "0.67.2",
      failureKind: "install_unhealthy",
      at: "2026-08-26T11:00:00Z",
    });

    const blocked = readUpdateLedger(path).blocked;
    expect(blocked.size).toBe(1);
    expect(blocked.get("0.67.2")?.at).toBe("2026-08-24T15:17:02Z");
    expect(blocked.get("0.67.2")?.failureKind).toBe("rolled_back");
  });

  it("reads a missing file as two empty maps", async () => {
    const ledger = readUpdateLedger(await newLedgerPath());
    expect(ledger.blocked.size).toBe(0);
    expect(ledger.disarmed.size).toBe(0);
  });

  it("appends without rewriting what a previous process wrote", async () => {
    const path = await newLedgerPath();
    await appendFile(
      path,
      '{"kind":"blocked","version":"0.67.2","failureKind":"rolled_back","at":"2026-08-24T15:17:02Z"}\n',
    );
    appendUpdateLedgerLine(path, {
      kind: "disarmed",
      version: "0.67.2",
      at: "2026-08-24T15:22:00Z",
    });

    const ledger = readUpdateLedger(path);
    expect([...ledger.blocked.keys()]).toEqual(["0.67.2"]);
    expect([...ledger.disarmed.keys()]).toEqual(["0.67.2"]);
  });

  it("skips every line the guard rejects instead of admitting it to a map", async () => {
    const path = await newLedgerPath();
    await appendFile(
      path,
      [
        "",
        "   ",
        "{not json",
        '{"kind":"blocked","version":42}',
        '{"kind":"blocked","version":""}',
        '{"kind":"blocked"}',
        '{"kind":"unblocked","version":"9.9.9"}',
        '{"version":"9.9.9"}',
        '["blocked","9.9.9"]',
        "null",
        '{"kind":"disarmed","version":7}',
        // Empty version, every other field valid.
        '{"kind":"blocked","version":"","failureKind":"rolled_back","at":"2026-08-24T15:17:02Z"}',
        // A kind this module does not know, every other field valid.
        '{"kind":"unblocked","version":"9.9.9","failureKind":"rolled_back","at":"2026-08-24T15:17:02Z"}',
        // `blocked` lines: no failureKind, a retryable one, and garbage.
        '{"kind":"blocked","version":"9.9.9","at":"2026-08-24T15:17:02Z"}',
        '{"kind":"blocked","version":"9.9.9","failureKind":"install_failed","at":"2026-08-24T15:17:02Z"}',
        '{"kind":"blocked","version":"9.9.9","failureKind":"nonsense","at":"2026-08-24T15:17:02Z"}',
        // `at` missing, unparseable, empty, and not a string.
        '{"kind":"disarmed","version":"9.9.9"}',
        '{"kind":"disarmed","version":"9.9.9","at":"not-a-date"}',
        '{"kind":"disarmed","version":"9.9.9","at":""}',
        '{"kind":"disarmed","version":"9.9.9","at":42}',
        '{"kind":"blocked","version":"0.67.2","failureKind":"rolled_back","at":"2026-08-24T15:17:02Z"}',
      ].join("\n"),
    );

    const ledger = readUpdateLedger(path);
    expect([...ledger.blocked.keys()]).toEqual(["0.67.2"]);
    expect(ledger.disarmed.size).toBe(0);
  });

  it("tolerates a truncated last line with no trailing newline", async () => {
    const path = await newLedgerPath();
    appendUpdateLedgerLine(path, {
      kind: "blocked",
      version: "0.67.2",
      failureKind: "rolled_back",
      at: "2026-08-24T15:17:02Z",
    });
    await appendFile(path, '{"kind":"blocked","version":"0.6');

    expect([...readUpdateLedger(path).blocked.keys()]).toEqual(["0.67.2"]);
  });
});
