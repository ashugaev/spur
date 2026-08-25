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
  it("round-trips both line kinds into their own sets", async () => {
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
    expect([...ledger.blocked]).toEqual(["0.67.2", "0.68.1"]);
    expect([...ledger.disarmed]).toEqual(["0.67.2"]);
  });

  it("reads a missing file as two empty sets", async () => {
    const ledger = readUpdateLedger(await newLedgerPath());
    expect(ledger.blocked.size).toBe(0);
    expect(ledger.disarmed.size).toBe(0);
  });

  it("appends without rewriting what a previous process wrote", async () => {
    const path = await newLedgerPath();
    await appendFile(path, '{"kind":"blocked","version":"0.67.2","failureKind":"rolled_back"}\n');
    appendUpdateLedgerLine(path, {
      kind: "disarmed",
      version: "0.67.2",
      at: "2026-08-24T15:22:00Z",
    });

    const ledger = readUpdateLedger(path);
    expect([...ledger.blocked]).toEqual(["0.67.2"]);
    expect([...ledger.disarmed]).toEqual(["0.67.2"]);
  });

  it("skips every line the guard rejects instead of admitting it to a set", async () => {
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
        '{"kind":"blocked","version":"0.67.2","failureKind":"rolled_back","at":"2026-08-24T15:17:02Z"}',
      ].join("\n"),
    );

    const ledger = readUpdateLedger(path);
    expect([...ledger.blocked]).toEqual(["0.67.2"]);
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

    expect([...readUpdateLedger(path).blocked]).toEqual(["0.67.2"]);
  });
});
