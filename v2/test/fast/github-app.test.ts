import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { GitHubApp } from "../../src/github-app.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
export async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "spur-app-"));
  dirs.push(dir);
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPath = join(dir, "key.pem");
  await writeFile(keyPath, key.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  return { dir, key, keyPath };
}
test("signs bounded JWT, scopes token and validates measured identity", async () => {
  const { key, keyPath } = await fixture();
  const requests: string[] = [];
  const transport: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    if (path === "/app") {
      const jwt = String((options?.headers as Record<string, string>).Authorization).slice(7);
      const [header, payload, signature] = jwt.split(".");
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${payload}`),
          key.publicKey,
          Buffer.from(String(signature), "base64url"),
        ),
      ).toBe(true);
      const claims = JSON.parse(Buffer.from(String(payload), "base64url").toString()) as {
        iss: number;
        iat: number;
        exp: number;
      };
      expect(claims.iss).toBe(1);
      expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
      return Response.json({ id: 1, slug: "code" });
    }
    if (path.endsWith("/installation"))
      return Response.json({ id: 2, app_id: 1, suspended_at: null });
    if (path.endsWith("/access_tokens")) {
      expect(JSON.parse(String(options?.body))).toEqual({
        repositories: ["repo"],
        permissions: { pull_requests: "write", metadata: "read" },
      });
      return Response.json({
        token: "SECRET",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: { pull_requests: "write", metadata: "read" },
      });
    }
    return Response.json({ id: 3, full_name: "owner/repo" });
  };
  expect(
    await new GitHubApp({ appId: 1, keyPath }, "owner/repo", transport).authenticate(),
  ).toEqual({
    appId: 1,
    actor: "code[bot]",
    installationId: 2,
    repositoryId: 3,
    permissions: { pull_requests: "write", metadata: "read" },
  });
  expect(requests).toHaveLength(4);
});
test("never leaks external error body or key path", async () => {
  const { keyPath } = await fixture();
  const transport: typeof fetch = async () =>
    new Response("SECRET PEM /home/private", { status: 403 });
  await expect(
    new GitHubApp({ appId: 1, keyPath }, "owner/repo", transport).authenticate(),
  ).rejects.toThrow("review-app: http-403");
  await expect(
    new GitHubApp(
      { appId: 1, keyPath: "/private/missing" },
      "owner/repo",
      transport,
    ).authenticate(),
  ).rejects.toThrow("review-app: key-unavailable");
});

test("rejects readable keys before network access", async () => {
  const { keyPath } = await fixture();
  await chmod(keyPath, 0o644);
  const transport: typeof fetch = async () => {
    throw new Error("network must not run");
  };
  await expect(
    new GitHubApp({ appId: 1, keyPath }, "owner/repo", transport).authenticate(),
  ).rejects.toThrow("unsafe-key-permissions");
});

test("refreshes rejected token once and paginates complete review history", async () => {
  const { keyPath } = await fixture();
  let tokens = 0,
    queries = 0;
  const transport: typeof fetch = async (url) => {
    const parsed = new URL(String(url)),
      path = parsed.pathname;
    if (path === "/app") return Response.json({ id: 1, slug: "code" });
    if (path.endsWith("/installation")) return Response.json({ id: 2, app_id: 1 });
    if (path.endsWith("/access_tokens")) {
      tokens++;
      return Response.json({
        token: `token${tokens}`,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: { pull_requests: "write", metadata: "read" },
      });
    }
    if (path === "/repos/owner/repo") return Response.json({ id: 3, full_name: "owner/repo" });
    queries++;
    if (queries === 1) return new Response("secret", { status: 401 });
    return Response.json(
      parsed.searchParams.get("page") === "1"
        ? Array.from({ length: 100 }, (_, id) => ({ id }))
        : [{ id: 100 }],
    );
  };
  const rows = await new GitHubApp({ appId: 1, keyPath }, "owner/repo", transport).history(
    "/reviews",
  );
  expect(rows).toHaveLength(101);
  expect(tokens).toBe(2);
  expect(queries).toBe(3);
});
