import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostDuplicatesManaged, readHostIdentity } from "../../src/host-identity.js";

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), "spur-host-identity-"));
}

describe("readHostIdentity", () => {
  it("reads the Claude oauthAccount identity fields only", async () => {
    const dir = await home();
    await writeFile(
      join(dir, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "a@x.com", organizationUuid: "org-1", accessToken: "secret" },
      }),
    );
    const identity = await readHostIdentity("claude", dir);
    expect(identity).toEqual({ email: "a@x.com", organizationId: "org-1" });
    expect(JSON.stringify(identity)).not.toContain("secret");
  });

  it("reads the Codex id_token claims and never returns a token", async () => {
    const dir = await home();
    await mkdir(join(dir, ".codex"));
    const claims = Buffer.from(
      JSON.stringify({
        email: "c@x.com",
        "https://api.openai.com/auth": { chatgpt_account_id: "acct" },
      }),
    ).toString("base64url");
    await writeFile(
      join(dir, ".codex", "auth.json"),
      JSON.stringify({ tokens: { access_token: "secret", id_token: `h.${claims}.s` } }),
    );
    const identity = await readHostIdentity("codex", dir);
    expect(identity).toEqual({ email: "c@x.com", organizationId: "acct" });
    expect(JSON.stringify(identity)).not.toContain("secret");
  });

  it("returns null for missing, malformed or email-less files", async () => {
    const dir = await home();
    expect(await readHostIdentity("claude", dir)).toBeNull();
    expect(await readHostIdentity("codex", dir)).toBeNull();
    await writeFile(join(dir, ".claude.json"), "{");
    expect(await readHostIdentity("claude", dir)).toBeNull();
    await writeFile(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: {} }));
    expect(await readHostIdentity("claude", dir)).toBeNull();
  });
});

describe("hostDuplicatesManaged", () => {
  const host = { email: "A@x.com", organizationId: "org-1" };
  const managed = (
    email: string,
    organizationId?: string,
    provider: "claude" | "codex" = "claude",
  ) => ({
    provider,
    identity: { email, ...(organizationId ? { organizationId } : {}) },
  });

  it("matches the email case-insensitively and the organization when both sides have one", () => {
    expect(hostDuplicatesManaged(host, "claude", [managed("a@x.com", "org-1")])).toBe(true);
    expect(hostDuplicatesManaged(host, "claude", [managed("a@x.com", "org-2")])).toBe(false);
    expect(hostDuplicatesManaged(host, "claude", [managed("b@x.com", "org-1")])).toBe(false);
  });

  it("matches on email alone when either side lacks an organization", () => {
    expect(hostDuplicatesManaged(host, "claude", [managed("a@x.com")])).toBe(true);
    expect(
      hostDuplicatesManaged({ email: "a@x.com" }, "claude", [managed("a@x.com", "org-9")]),
    ).toBe(true);
  });

  it("ignores other providers, accounts without identity and an unknown host", () => {
    expect(hostDuplicatesManaged(host, "claude", [managed("a@x.com", "org-1", "codex")])).toBe(
      false,
    );
    expect(hostDuplicatesManaged(host, "claude", [{ provider: "claude" }])).toBe(false);
    expect(hostDuplicatesManaged(null, "claude", [managed("a@x.com")])).toBe(false);
  });
});
