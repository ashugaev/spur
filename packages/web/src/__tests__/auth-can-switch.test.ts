import { describe, expect, it } from "vitest";
import { canSwitchAuth, type DashboardSession } from "@/lib/types";

const READY = [{ provider: "claude", authenticated: true }] as const;

function session(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id: "s-1",
    agent: "claude",
    status: "running",
    runtimeAlive: true,
    workspaceExists: true,
    ...overrides,
  } as DashboardSession;
}

describe("canSwitchAuth", () => {
  it("keeps a bound session switchable without account data", () => {
    const auth = { provider: "claude" } as DashboardSession["auth"];
    expect(canSwitchAuth(session({ auth }))).toBe(true);
  });

  it("offers a running unbound session whose provider has a ready account", () => {
    expect(canSwitchAuth(session(), READY)).toBe(true);
  });

  it("offers a restorable unbound session", () => {
    expect(canSwitchAuth(session({ status: "stopped", runtimeAlive: false }), READY)).toBe(true);
  });

  it("hides it without a ready account for the provider", () => {
    expect(canSwitchAuth(session())).toBe(false);
    expect(canSwitchAuth(session(), [{ provider: "claude", authenticated: false }])).toBe(false);
    expect(canSwitchAuth(session(), [{ provider: "codex", authenticated: true }])).toBe(false);
  });

  it("hides it for ended sessions and other agents", () => {
    expect(canSwitchAuth(session({ status: "completed", runtimeAlive: false }), READY)).toBe(false);
    expect(canSwitchAuth(session({ agent: "cursor" }), READY)).toBe(false);
  });
});
