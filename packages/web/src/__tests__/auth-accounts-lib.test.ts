import { describe, expect, it } from "vitest";
import { isTerminalLogin } from "@/lib/auth-accounts";

describe("isTerminalLogin", () => {
  const login = {
    id: "auth-login-a",
    tmuxSession: "auth-login-a",
    status: "running",
    command: "claude auth login",
  };

  it("accepts a login that carries the daemon command", () => {
    expect(isTerminalLogin(login)).toBe(true);
  });

  it.each([
    ["no command", { ...login, command: undefined }],
    ["a non-string command", { ...login, command: 7 }],
    ["no id", { ...login, id: undefined }],
    ["null", null],
  ])("rejects %s", (_name, value) => {
    expect(isTerminalLogin(value)).toBe(false);
  });
});
