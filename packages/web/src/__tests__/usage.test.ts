import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuotaErrorKind, QuotaSourceResult } from "@/lib/types";
import {
  errorKindLabel,
  errorKindTone,
  fetchUsage,
  formatResetIn,
  meterTone,
  quotaLevel,
} from "@/lib/usage";

const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const base = { provider: "claude", source: "s", label: "L", fetchedAt: at(0) } as const;
const ok: QuotaSourceResult = { ...base, status: "ok", plan: null, windows: [] };
const failed: QuotaSourceResult = {
  ...base,
  status: "error",
  error: "expired",
  message: "m",
  httpStatus: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("meterTone", () => {
  it.each([
    [0, "normal"],
    [74.9, "normal"],
    [75, "attention"],
    [89.9, "attention"],
    [90, "error"],
    [100, "error"],
  ] as const)("%s -> %s", (percent, tone) => {
    expect(meterTone(percent)).toBe(tone);
  });
});

describe("formatResetIn", () => {
  it("renders null and unparsable as no reset time", () => {
    expect(formatResetIn(null, NOW)).toBe("no reset time");
    expect(formatResetIn("garbage", NOW)).toBe("no reset time");
  });

  it("renders <1m, minutes, hours and days", () => {
    expect(formatResetIn(at(59_000), NOW)).toBe("<1m");
    expect(formatResetIn(at(-5_000), NOW)).toBe("<1m");
    expect(formatResetIn(at(7 * 60_000), NOW)).toBe("7m");
    expect(formatResetIn(at((3 * 60 + 5) * 60_000), NOW)).toBe("3h 5m");
    expect(formatResetIn(at((2 * 24 * 60 + 4 * 60) * 60_000), NOW)).toBe("2d 4h");
  });
});

describe("error kinds", () => {
  const kinds: [QuotaErrorKind, string, "warn" | "error"][] = [
    ["no_credentials", "no credentials", "error"],
    ["expired", "expired", "error"],
    ["unauthorized", "unauthorized", "error"],
    ["rate_limited", "rate limited", "warn"],
    ["http_error", "http error", "error"],
    ["network_error", "network error", "warn"],
    ["unparsable", "unparsable", "error"],
  ];

  it.each(kinds)("%s -> %s (%s)", (kind, label, tone) => {
    expect(errorKindLabel(kind)).toBe(label);
    expect(errorKindTone(kind)).toBe(tone);
  });
});

describe("quotaLevel", () => {
  it("is ready when all ok, attention when mixed, error when all failed", () => {
    expect(quotaLevel([ok, ok])).toBe("ready");
    expect(quotaLevel([ok, failed])).toBe("attention");
    expect(quotaLevel([failed, failed])).toBe("error");
  });
});

describe("fetchUsage", () => {
  it("returns the report and requests /api/usage uncached", async () => {
    const report = { generatedAt: at(0), quotas: [], tokens: [] };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => report });
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await expect(fetchUsage(signal)).resolves.toEqual(report);
    expect(fetchMock).toHaveBeenCalledWith("/api/usage", { cache: "no-store", signal });
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    await expect(fetchUsage(new AbortController().signal)).rejects.toThrow("502");
  });
});
