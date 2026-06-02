import { describe, expect, it } from "vitest";
import {
  formatNestedSidecarStartError,
  nextSidecarDepth,
  ROOT_SIDECAR_DEPTH,
  sidecarCallerContextFromEnv,
  sidecarCallerContextFromRequest,
  startSidecarRequestFromEnv,
} from "../../src/sidecar-runtime.js";

describe("sidecarCallerContextFromEnv", () => {
  it("returns depth 0 and no name when SPUR_SIDECAR_NAME is missing", () => {
    expect(sidecarCallerContextFromEnv({})).toEqual({ depth: 0 });
  });

  it("falls back to ROOT_SIDECAR_DEPTH when no depth env var is set", () => {
    expect(sidecarCallerContextFromEnv({ SPUR_SIDECAR_NAME: "first" })).toEqual({
      name: "first",
      depth: ROOT_SIDECAR_DEPTH,
    });
  });

  it("falls back to ROOT_SIDECAR_DEPTH for a non-numeric depth string", () => {
    expect(
      sidecarCallerContextFromEnv({ SPUR_SIDECAR_NAME: "first", SPUR_SIDECAR_DEPTH: "abc" }),
    ).toEqual({ name: "first", depth: ROOT_SIDECAR_DEPTH });
  });

  it("falls back to ROOT_SIDECAR_DEPTH for an empty depth string", () => {
    expect(
      sidecarCallerContextFromEnv({ SPUR_SIDECAR_NAME: "first", SPUR_SIDECAR_DEPTH: "" }),
    ).toEqual({ name: "first", depth: ROOT_SIDECAR_DEPTH });
  });

  it("falls back to ROOT_SIDECAR_DEPTH for a negative depth string", () => {
    expect(
      sidecarCallerContextFromEnv({ SPUR_SIDECAR_NAME: "first", SPUR_SIDECAR_DEPTH: "-1" }),
    ).toEqual({ name: "first", depth: ROOT_SIDECAR_DEPTH });
  });

  it("uses the provided integer depth when valid", () => {
    expect(
      sidecarCallerContextFromEnv({ SPUR_SIDECAR_NAME: "first", SPUR_SIDECAR_DEPTH: "2" }),
    ).toEqual({ name: "first", depth: 2 });
  });
});

describe("sidecarCallerContextFromRequest", () => {
  it("returns depth 0 when callerSidecarName is missing", () => {
    expect(sidecarCallerContextFromRequest({})).toEqual({ depth: 0 });
  });

  it("falls back to ROOT_SIDECAR_DEPTH when callerSidecarDepth is missing", () => {
    expect(sidecarCallerContextFromRequest({ callerSidecarName: "first" })).toEqual({
      name: "first",
      depth: ROOT_SIDECAR_DEPTH,
    });
  });

  it("uses the provided depth when valid", () => {
    expect(
      sidecarCallerContextFromRequest({ callerSidecarName: "first", callerSidecarDepth: 2 }),
    ).toEqual({ name: "first", depth: 2 });
  });
});

describe("nextSidecarDepth", () => {
  it("returns ROOT_SIDECAR_DEPTH for an unnamed caller", () => {
    expect(nextSidecarDepth({ depth: 0 })).toBe(ROOT_SIDECAR_DEPTH);
  });

  it("returns depth + 1 for a named caller", () => {
    expect(nextSidecarDepth({ name: "first", depth: 1 })).toBe(2);
  });
});

describe("startSidecarRequestFromEnv", () => {
  it("returns an empty request when no caller is set", () => {
    expect(startSidecarRequestFromEnv({})).toEqual({});
  });

  it("round-trips name and depth from a full env", () => {
    expect(
      startSidecarRequestFromEnv({ SPUR_SIDECAR_NAME: "first", SPUR_SIDECAR_DEPTH: "1" }),
    ).toEqual({ callerSidecarName: "first", callerSidecarDepth: 1 });
  });
});

describe("formatNestedSidecarStartError", () => {
  it("renders the exact one-level-deep refusal message", () => {
    expect(formatNestedSidecarStartError("worker", "first")).toBe(
      'Cannot start sidecar "worker" from nested sidecar "first". Sidecars can nest only one level deep, and nested sidecars must always be started manually.',
    );
  });
});

describe("ROOT_SIDECAR_DEPTH", () => {
  it("is 1", () => {
    expect(ROOT_SIDECAR_DEPTH).toBe(1);
  });
});
