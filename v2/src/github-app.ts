import { sign } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export class ReviewAppError extends Error {
  constructor(public readonly category: string) {
    super(`review-app: ${category}`);
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReviewAppError("invalid-response");
  return value as Record<string, unknown>;
}

export function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new ReviewAppError("invalid-response");
  return value;
}

export function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new ReviewAppError("invalid-response");
  return value as number;
}

export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new ReviewAppError("invalid-json-file");
  }
}

export interface AppCredentials {
  appId: number;
  keyPath: string;
}
export interface AppAccess {
  appId: number;
  actor: string;
  installationId: number;
  repositoryId: number;
  permissions: { pull_requests: "write"; metadata: "read" };
}

export class GitHubApp {
  private token = "";
  private expires = 0;
  private access?: AppAccess;
  constructor(
    private readonly credentials: AppCredentials,
    private readonly repo: string,
    private readonly transport: typeof fetch = fetch,
  ) {}

  private async jwt(): Promise<string> {
    try {
      const path = this.credentials.keyPath.startsWith("~/")
        ? resolve(homedir(), this.credentials.keyPath.slice(2))
        : this.credentials.keyPath;
      const metadata = await stat(path);
      if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
        throw new ReviewAppError("unsafe-key-permissions");
      const key = await readFile(path, "utf8");
      const now = Math.floor(Date.now() / 1000);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: this.credentials.appId })}`;
      return `${payload}.${sign("RSA-SHA256", Buffer.from(payload), key).toString("base64url")}`;
    } catch (error) {
      if (error instanceof ReviewAppError) throw error;
      throw new ReviewAppError("key-unavailable");
    }
  }

  private async http(
    path: string,
    token: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport(`https://api.github.com${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ReviewAppError(method === "POST" ? "ambiguous-write" : "network");
    }
    if (!response.ok) throw new ReviewAppError(`http-${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new ReviewAppError(method === "POST" ? "ambiguous-write" : "invalid-response");
    }
  }

  async authenticate(): Promise<AppAccess> {
    const jwt = await this.jwt();
    const app = object(await this.http("/app", jwt));
    if (integer(app.id) !== this.credentials.appId) throw new ReviewAppError("app-mismatch");
    const installation = object(await this.http(`/repos/${this.repo}/installation`, jwt));
    const installationId = integer(installation.id);
    if (
      integer(installation.app_id) !== this.credentials.appId ||
      (installation.suspended_at !== null && installation.suspended_at !== undefined)
    )
      throw new ReviewAppError("installation-unavailable");
    const token = object(
      await this.http(`/app/installations/${installationId}/access_tokens`, jwt, "POST", {
        repositories: [this.repo.split("/")[1]],
        permissions: { pull_requests: "write", metadata: "read" },
      }),
    );
    const permissions = object(token.permissions);
    if (permissions.pull_requests !== "write" || permissions.metadata !== "read")
      throw new ReviewAppError("permissions");
    this.token = string(token.token);
    this.expires = Date.parse(string(token.expires_at));
    if (!Number.isFinite(this.expires) || this.expires <= Date.now())
      throw new ReviewAppError("token-expiry");
    const repository = object(await this.http(`/repos/${this.repo}`, this.token));
    if (string(repository.full_name).toLowerCase() !== this.repo.toLowerCase())
      throw new ReviewAppError("repository-mismatch");
    this.access = {
      appId: this.credentials.appId,
      actor: `${string(app.slug)}[bot]`,
      installationId,
      repositoryId: integer(repository.id),
      permissions: { pull_requests: "write", metadata: "read" },
    };
    return this.access;
  }

  async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    if (!this.access || Date.now() + 60_000 >= this.expires) await this.authenticate();
    try {
      return await this.http(path, this.token, method, body);
    } catch (error) {
      // A rejected request did not mutate; ambiguous writes never retry.
      if (!(error instanceof ReviewAppError) || error.category !== "http-401") throw error;
      await this.authenticate();
      return this.http(path, this.token, method, body);
    }
  }

  async history(path: string): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (let page = 1; ; page++) {
      const result = await this.request(`${path}?per_page=100&page=${page}`);
      if (!Array.isArray(result)) throw new ReviewAppError("invalid-response");
      rows.push(...result);
      if (result.length < 100) return rows;
    }
  }
}
