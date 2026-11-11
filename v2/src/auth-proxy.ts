import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AuthorizationError, authProviderSchema, type AuthAccountsState } from "./auth-accounts.js";

const statusSchema = z.enum(["ready", "sign-in-required", "pending", "failed"]);
const endpointSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const endpoint = new URL(value);
      return (
        endpoint.protocol === "http:" &&
        endpoint.hostname === "127.0.0.1" &&
        endpoint.port !== "" &&
        endpoint.pathname === "/" &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.search &&
        !endpoint.hash
      );
    } catch {
      return false;
    }
  }, "Authorization proxy endpoint must be loopback HTTP");
export const authSessionSchema = z.object({
  sessionId: z.string(),
  provider: authProviderSchema,
  mode: z.enum(["auto", "pinned"]),
  accountId: z.string().nullable(),
  effectiveAccountId: z.string(),
  generation: z.number().int().nonnegative(),
});
const registrationSchema = authSessionSchema.extend({
  endpoint: endpointSchema,
  token: z.string().min(1),
});
const loginSchema = z.object({
  accountId: z.string(),
  status: statusSchema,
  url: z.string().optional(),
  userCode: z.string().optional(),
  prompt: z.string().optional(),
  error: z.string().optional(),
});
const stateSchema = z.object({
  accounts: z.array(
    z.object({
      id: z.string(),
      provider: authProviderSchema,
      status: statusSchema,
      error: z.string().optional(),
    }),
  ),
  sessions: z.array(authSessionSchema),
});
const messageSchema = z.union([
  z.object({ event: z.literal("ready"), endpoint: endpointSchema }),
  z.object({ id: z.number(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    id: z.number(),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

export type AuthSession = z.infer<typeof authSessionSchema>;
export type AuthRegistration = z.infer<typeof registrationSchema>;
export type AuthLogin = z.infer<typeof loginSchema>;
export type AuthProxyState = z.infer<typeof stateSchema>;

type AuthControlRequest =
  | {
      method: "configure";
      params: {
        accounts: { id: string; provider: "claude" | "codex"; createdAt: string }[];
        pools: {
          provider: "claude" | "codex";
          defaultAccountId: string | null;
          defaultGeneration: number;
          autoRotate: boolean;
        }[];
        policy: { cooldownMinutes: number; maxRotationsPerEpisode: number };
      };
    }
  | { method: "getState"; params: object }
  | {
      method: "registerSession";
      params: { sessionId: string; provider: "claude" | "codex"; accountId: string | null };
    }
  | { method: "switchSession"; params: { sessionId: string; accountId: string | null } }
  | { method: "revokeSession"; params: { sessionId: string } }
  | { method: "login"; params: { accountId: string; provider: "claude" | "codex" } }
  | { method: "loginInput"; params: { accountId: string; input: string } }
  | { method: "loginStatus" | "cancelLogin" | "removeAccount"; params: { accountId: string } };

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function authProxyBinaryPath(): string {
  const architecture = process.arch === "x64" ? "amd64" : process.arch;
  if (process.platform !== "linux" || !["amd64", "arm64"].includes(architecture)) {
    throw new Error("Managed authorization requires Linux amd64 or arm64");
  }
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "bin",
    "auth-proxy",
    `linux-${architecture}`,
  );
}

/** Private control channel. The companion owns durable routing and provider secrets. */
export class AuthProxy {
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private disposed = false;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryAttempts = 0;

  constructor(
    private readonly dataDir: string,
    private readonly configuration: () => {
      state: AuthAccountsState;
      policy: { cooldownMinutes: number; maxRotationsPerEpisode: number };
    },
    private readonly binaryPath: () => string = authProxyBinaryPath,
  ) {}

  async recover(): Promise<void> {
    if (existsSync(join(this.dataDir, "auth-proxy-state.json"))) await this.configure();
  }

  dispose(): void {
    this.disposed = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.child?.stdin.end();
    this.rejectPending(new Error("Managed authorization proxy stopped"));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private ensureStarted(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Managed authorization proxy stopped"));
    if (this.starting) return this.starting;
    const startup = this.start();
    this.starting = startup;
    void startup.catch(() => {
      if (this.starting === startup) this.starting = undefined;
    });
    return startup;
  }

  private start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let ready = false;
      const child = spawn(this.binaryPath(), ["--data-dir", this.dataDir], { stdio: "pipe" });
      this.child = child;
      const timeout = setTimeout(() => {
        reject(new Error("Managed authorization proxy did not become ready"));
        child.kill();
      }, 30_000);
      const lines = createInterface({ input: child.stdout });
      child.stderr.resume();
      child.once("error", () => {
        clearTimeout(timeout);
        reject(new Error("Managed authorization proxy unavailable; rebuild or reinstall Spur"));
      });
      child.stdin.on("error", () => {
        if (this.child !== child) return;
        this.rejectPending(new Error("Managed authorization proxy disconnected"));
        child.kill();
      });
      lines.on("line", (line) => {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          child.kill();
          reject(new Error("Invalid authorization proxy response"));
          return;
        }
        const parsed = messageSchema.safeParse(value);
        if (!parsed.success) {
          child.kill();
          reject(new Error("Invalid authorization proxy response"));
          return;
        }
        const message = parsed.data;
        if ("event" in message) {
          ready = true;
          clearTimeout(timeout);
          resolve();
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new AuthorizationError(message.error.message));
      });
      child.once("close", () => {
        clearTimeout(timeout);
        lines.close();
        if (!ready) reject(new Error("Managed authorization proxy failed to start"));
        if (this.child !== child) return;
        this.child = undefined;
        this.starting = undefined;
        this.rejectPending(new Error("Managed authorization proxy disconnected"));
        if (!this.disposed && this.recoveryAttempts < 3) {
          this.recoveryAttempts += 1;
          this.recoveryTimer = setTimeout(() => {
            this.recoveryTimer = undefined;
            void this.configure().catch(() => {});
          }, 250);
          this.recoveryTimer.unref();
        }
      });
    });
  }

  private async request(request: AuthControlRequest): Promise<unknown> {
    await this.ensureStarted();
    const child = this.child;
    if (!child || child.stdin.destroyed) throw new Error("Managed authorization proxy unavailable");
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Managed authorization proxy request timed out"));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, ...request })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new Error("Managed authorization proxy disconnected"));
      });
    });
  }

  async configure(): Promise<void> {
    const { state, policy } = this.configuration();
    await this.request({
      method: "configure",
      params: {
        accounts: state.accounts.map(({ id, provider, createdAt }) => ({
          id,
          provider,
          createdAt,
        })),
        pools: (["claude", "codex"] as const).flatMap((provider) => {
          const pool = state.pools[provider];
          return pool ? [{ provider, ...pool }] : [];
        }),
        policy,
      },
    });
  }

  private async execute<T>(request: AuthControlRequest, schema: z.ZodType<T>): Promise<T> {
    await this.configure();
    const value = schema.parse(await this.request(request));
    this.recoveryAttempts = 0;
    return value;
  }

  getState(): Promise<AuthProxyState> {
    return this.execute({ method: "getState", params: {} }, stateSchema);
  }

  registerSession(
    params: Extract<AuthControlRequest, { method: "registerSession" }>["params"],
  ): Promise<AuthRegistration> {
    return this.execute({ method: "registerSession", params }, registrationSchema);
  }

  switchSession(sessionId: string, accountId: string | null): Promise<AuthRegistration> {
    return this.execute(
      { method: "switchSession", params: { sessionId, accountId } },
      registrationSchema,
    );
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.execute({ method: "revokeSession", params: { sessionId } }, z.object({}));
  }

  login(accountId: string, provider: "claude" | "codex"): Promise<AuthLogin> {
    return this.execute({ method: "login", params: { accountId, provider } }, loginSchema);
  }

  loginInput(accountId: string, input: string): Promise<AuthLogin> {
    return this.execute({ method: "loginInput", params: { accountId, input } }, loginSchema);
  }

  loginStatus(accountId: string): Promise<AuthLogin> {
    return this.execute({ method: "loginStatus", params: { accountId } }, loginSchema);
  }

  cancelLogin(accountId: string): Promise<AuthLogin> {
    return this.execute({ method: "cancelLogin", params: { accountId } }, loginSchema);
  }

  async removeAccount(accountId: string): Promise<void> {
    await this.execute({ method: "removeAccount", params: { accountId } }, z.object({}));
  }
}
