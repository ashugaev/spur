import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, loadProjectConfig, resolveConfigPath } from "../../src/config.js";
import { DEFAULT_PROJECT_PREFLIGHT_PROMPT } from "../../src/preflight-contract.js";
import { createTempDir } from "../helpers/common.js";

const tempDirs: string[] = [];
const initialCwd = process.cwd();
const initialSpurConfig = process.env["SPUR_CONFIG"];
const WORKTREE_PATH_SHELL_TOKEN = "$" + "{worktreePathShell}";
const WORKTREE_PATH_URL_TOKEN = "$" + "{worktreePathUrl}";

async function writeConfig(content: string): Promise<string> {
  return writeNamedConfig("spur.yaml", content);
}

async function writeNamedConfig(name: string, content: string): Promise<string> {
  const dir = await createTempDir("spur-fast-config-");
  tempDirs.push(dir);
  const repoPath = join(dir, "repo");
  await mkdir(repoPath, { recursive: true });
  const configPath = join(dir, name);
  await writeFile(configPath, content.replaceAll("$REPO_PATH", repoPath), "utf8");
  return configPath;
}

async function writeProjectEnv(configPath: string, content: string): Promise<void> {
  await writeFile(join(configPath, "..", "repo", ".env"), content, "utf8");
}

afterEach(async () => {
  process.chdir(initialCwd);
  if (initialSpurConfig === undefined) {
    delete process.env["SPUR_CONFIG"];
  } else {
    process.env["SPUR_CONFIG"] = initialSpurConfig;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadConfig", () => {
  it("applies Spur defaults once at the config boundary", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
    triggers:
      notify:
        source: pr-watch
        event: github:comment
        send: {}
`);

    const config = loadConfig(configPath);

    expect(config.server.host).toBe("127.0.0.1");
    expect(config.server.port).toBe(4310);
    expect(config.defaultAgent).toBe("claude");
    expect(config.dataDir).toContain(".spur");
    expect(config.worktreeDir).toContain(".spur/worktrees");
    expect(config.voice.provider).toBe("whisper_cpp");
    expect(config.voice.model).toBe("base");
    expect(config.voice.modelPath).toBeUndefined();
    expect(config.voice.language).toBe("auto");
    expect(config.projects["backend"]?.defaultBranch).toBe("main");
    expect(config.projects["backend"]?.sessionPrefix).toBe("backend");
    expect(config.projects["backend"]?.worktree).toBe(true);
    expect(config.projects["backend"]?.sources["pr-watch"]).toEqual({
      type: "github",
      intervalMs: 60_000,
      runOnStart: false,
    });
    expect(config.projects["backend"]?.triggers["notify"]).toEqual({
      source: "pr-watch",
      event: "github:comment",
      send: {
        interrupt: false,
      },
    });
  });

  it("accepts cursor as an instance and project default agent", async () => {
    const configPath = await writeConfig(`
defaultAgent: cursor
projects:
  backend:
    path: $REPO_PATH
    defaultAgent: cursor
`);

    const config = loadConfig(configPath);

    expect(config.defaultAgent).toBe("cursor");
    expect(config.projects["backend"]?.defaultAgent).toBe("cursor");
  });

  it("parses explicit project worktree defaults and spawn overrides", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    worktree: false
    triggers:
      review:
        source: weekday
        event: cron:tick
        spawn:
          prompt: "review this task"
          steps:
            - "research"
            - "implement"
          overrides:
            worktree: true
            defaultBranch: release
    sources:
      weekday:
        type: cron
        schedule: "* * * * *"
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.worktree).toBe(false);
    expect(config.projects["backend"]?.triggers["review"]).toEqual({
      source: "weekday",
      event: "cron:tick",
      spawn: {
        prompt: "review this task",
        steps: ["research", "implement"],
        overrides: {
          worktree: true,
          defaultBranch: "release",
        },
      },
    });
  });

  it("parses optional send prompt on triggers", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
    triggers:
      notify:
        source: pr-watch
        event: github:changes_requested
        send:
          interrupt: true
          prompt: "Run $manager and $github. Address requested changes."
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.triggers["notify"]).toEqual({
      source: "pr-watch",
      event: "github:changes_requested",
      send: {
        interrupt: true,
        prompt: "Run $manager and $github. Address requested changes.",
      },
    });
  });

  it("accepts github merge conflict events during config validation", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
    triggers:
      notify:
        source: pr-watch
        event: github:merge_conflict
        send: {}
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.triggers["notify"]).toEqual({
      source: "pr-watch",
      event: "github:merge_conflict",
      send: {
        interrupt: false,
      },
    });
  });

  it("accepts gitlab source defaults and gitlab trigger events", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      mr-watch:
        type: gitlab
    triggers:
      notify:
        source: mr-watch
        event: gitlab:comment
        send: {}
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.sources["mr-watch"]).toEqual({
      type: "gitlab",
      intervalMs: 60_000,
      runOnStart: false,
    });
    expect(config.projects["backend"]?.triggers["notify"]).toEqual({
      source: "mr-watch",
      event: "gitlab:comment",
      send: {
        interrupt: false,
      },
    });
  });

  it("parses service sources with rule defaults and matching trigger events", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      web-watch:
        type: service
        service: web
        rules:
          crash:
            match: "SERVICE_ERROR"
    triggers:
      notify:
        source: web-watch
        event: service:crash
        send: {}
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.sources["web-watch"]).toEqual({
      type: "service",
      runOnStart: false,
      service: "web",
      intervalMs: 2_000,
      tailLines: 200,
      rules: {
        crash: {
          match: "SERVICE_ERROR",
          cooldownMs: 60_000,
        },
      },
    });
    expect(config.projects["backend"]?.triggers["notify"]).toEqual({
      source: "web-watch",
      event: "service:crash",
      send: {
        interrupt: false,
      },
    });
  });

  it("rejects non-string send prompts", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
    triggers:
      notify:
        source: pr-watch
        event: github:comment
        send:
          prompt: true
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.triggers.notify.send.prompt must be a non-empty string",
    );
  });

  it("parses project default spawn steps", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    spawn:
      steps:
        - "research"
        - "test"
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.spawn).toEqual({
      steps: ["research", "test"],
    });
  });

  it("parses project codex args", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    codexArgs:
      - -c
      - 'model_reasoning_effort="high"'
      - --enable
      - fast_mode
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.codexArgs).toEqual([
      "-c",
      'model_reasoning_effort="high"',
      "--enable",
      "fast_mode",
    ]);
  });

  it("rejects non-string project codex args", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    codexArgs:
      - -c
      - true
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.codexArgs[1] must be a non-empty string",
    );
  });

  it("parses a custom voice model path from the instance config", async () => {
    const configPath = await writeConfig(`
voice:
  modelPath: ~/models/ggml-small.bin

projects:
  backend:
    path: $REPO_PATH
`);

    const config = loadConfig(configPath);

    expect(config.voice.modelPath).toContain("/models/ggml-small.bin");
  });

  it("parses voice provider and model with minimal config", async () => {
    const configPath = await writeConfig(`
voice:
  provider: faster_whisper
  language: auto
  model: small

projects:
  backend:
    path: $REPO_PATH
`);

    const config = loadConfig(configPath);

    expect(config.voice).toEqual({
      provider: "faster_whisper",
      language: "auto",
      model: "small",
    });
  });

  it("parses azure_openai voice provider with deployment name only", async () => {
    const configPath = await writeConfig(`
voice:
  provider: azure_openai
  model: whisper

projects:
  backend:
    path: $REPO_PATH
`);

    const config = loadConfig(configPath);

    expect(config.voice).toEqual({
      provider: "azure_openai",
      language: "auto",
      model: "whisper",
    });
  });

  it("keeps legacy voice configs backwards compatible", async () => {
    const configPath = await writeConfig(`
voice:
  modelPath: ~/models/ggml-base.bin
  language: ru

projects:
  backend:
    path: $REPO_PATH
`);

    const config = loadConfig(configPath);

    expect(config.voice.provider).toBe("whisper_cpp");
    expect(config.voice.model).toBe("base");
    expect(config.voice.modelPath).toContain("/models/ggml-base.bin");
    expect(config.voice.language).toBe("ru");
  });

  it("rejects unsupported voice providers", async () => {
    const configPath = await writeConfig(`
voice:
  provider: whisperx

projects:
  backend:
    path: $REPO_PATH
`);

    expect(() => loadConfig(configPath)).toThrow(
      'voice.provider must be "whisper_cpp", "faster_whisper", or "azure_openai"',
    );
  });

  it("parses an optional project spawn preflight prompt", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    preflight:
      prompt: "Suggest a branch from the task and repo rules."
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.preflight).toEqual({
      prompt: "Suggest a branch from the task and repo rules.",
    });
  });

  it("defaults project spawn preflight prompt when omitted", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    preflight: {}
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.preflight).toEqual({
      prompt: DEFAULT_PROJECT_PREFLIGHT_PROMPT,
    });
  });

  it("parses github source query and accepts github:work_item.new triggers", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
        query: "is:pr is:open label:spur"
    triggers:
      pick-up:
        source: pr-watch
        event: github:work_item.new
        spawn:
          prompt: "Take this work item."
`);

    const config = loadConfig(configPath);
    expect(config.projects["backend"]?.sources["pr-watch"]).toEqual({
      type: "github",
      intervalMs: 60_000,
      runOnStart: false,
      query: "is:pr is:open label:spur",
    });
    expect(config.projects["backend"]?.triggers["pick-up"]).toEqual({
      source: "pr-watch",
      event: "github:work_item.new",
      spawn: {
        prompt: "Take this work item.",
      },
    });
  });

  it("parses a jira source with resolved auth and raw JQL", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      jira-backlog:
        type: jira
        baseUrl: https://jira.example.com
        email: \${JIRA_EMAIL}
        token: \${JIRA_TOKEN}
        jql: "project = WEB AND status = Backlog"
`);
    await writeProjectEnv(configPath, "JIRA_EMAIL=bot@example.com\nJIRA_TOKEN=secret-token\n");

    const config = loadConfig(configPath);
    expect(config.projects["backend"]?.sources["jira-backlog"]).toEqual({
      type: "jira",
      runOnStart: false,
      baseUrl: "https://jira.example.com/",
      email: "bot@example.com",
      token: "secret-token",
      jql: "project = WEB AND status = Backlog",
      intervalMs: 60_000,
    });
  });

  it("rejects a jira source whose auth cannot be resolved", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      jira-backlog:
        type: jira
        baseUrl: https://jira.example.com
        email: \${JIRA_EMAIL}
        token: \${JIRA_TOKEN}
        jql: "project = WEB"
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.sources.jira-backlog.email could not be resolved from the environment",
    );
  });

  it("rejects github:work_item.new triggers when the source has no query", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
    triggers:
      pick-up:
        source: pr-watch
        event: github:work_item.new
        spawn:
          prompt: "Take this work item."
`);

    expect(() => loadConfig(configPath)).toThrow(
      'projects.backend.triggers.pick-up.event uses unsupported event "github:work_item.new"',
    );
  });

  it("rejects multiple work-item triggers on the same github source", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
        query: "is:pr is:open"
    triggers:
      one:
        source: pr-watch
        event: github:work_item.new
        spawn:
          prompt: "first"
      two:
        source: pr-watch
        event: github:work_item.new
        spawn:
          prompt: "second"
`);

    expect(() => loadConfig(configPath)).toThrow(
      'projects.backend: source "pr-watch" has 2 triggers subscribed to "github:work_item.new"; at most one is allowed',
    );
  });

  it("rejects removed GitHub event names during config validation", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
    triggers:
      old-trigger:
        source: pr-watch
        event: github:review
        send: {}
`);

    expect(() => loadConfig(configPath)).toThrow(
      'projects.backend.triggers.old-trigger.event uses unsupported event "github:review"',
    );
  });

  it("requires trigger spawn.prompt", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      weekday:
        type: cron
        schedule: "* * * * *"
    triggers:
      review:
        source: weekday
        event: cron:tick
        spawn:
          steps:
            - "continue"
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.triggers.review.spawn.prompt must be a non-empty string",
    );
  });

  it("rejects unsupported service events during config validation", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      web-watch:
        type: service
        service: web
        rules:
          crash:
            match: "SERVICE_ERROR"
    triggers:
      notify:
        source: web-watch
        event: service:missing
        send: {}
`);

    expect(() => loadConfig(configPath)).toThrow(
      'projects.backend.triggers.notify.event uses unsupported event "service:missing"',
    );
  });

  it("rejects duplicate session prefixes across projects", async () => {
    const configPath = await writeConfig(`
projects:
  api:
    path: $REPO_PATH
    sessionPrefix: shared
  web:
    path: $REPO_PATH
    sessionPrefix: shared
`);

    expect(() => loadConfig(configPath)).toThrow(
      'sessionPrefix "shared" is duplicated in projects.api and projects.web',
    );
  });

  it("parses devServer as sidecar backward compat", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    devServer:
      command: "pnpm dev"
      autoStart: true
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.sidecars).toEqual({
      dev: { command: "pnpm dev", autoStart: true },
    });
  });

  it("parses sidecars block", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sidecars:
      dev:
        command: "pnpm dev"
        autoStart: true
        ports:
          http:
            env: SPUR_RESERVED_PORT_DEV
            start: 3000
            end: 3099
      worker:
        command: "pnpm worker"
        env:
          NODE_ENV: production
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.sidecars).toEqual({
      dev: {
        command: "pnpm dev",
        autoStart: true,
        ports: {
          http: { env: "SPUR_RESERVED_PORT_DEV", start: 3000, end: 3099 },
        },
      },
      worker: { command: "pnpm worker", autoStart: false, env: { NODE_ENV: "production" } },
    });
  });

  it("resolves env placeholders in sidecar env and port url", async () => {
    process.env["SPUR_PUBLIC_HOST_TEST"] = "host.example.com";
    try {
      const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sidecars:
      dev:
        command: "pnpm dev"
        env:
          PUBLIC_HOST: \${SPUR_PUBLIC_HOST_TEST}
        ports:
          http:
            env: SPUR_RESERVED_PORT_DEV
            start: 3000
            end: 3099
            url: http://\${SPUR_PUBLIC_HOST_TEST}
`);

      const config = loadConfig(configPath);

      expect(config.projects["backend"]?.sidecars).toEqual({
        dev: {
          command: "pnpm dev",
          autoStart: false,
          env: { PUBLIC_HOST: "host.example.com" },
          ports: {
            http: {
              env: "SPUR_RESERVED_PORT_DEV",
              start: 3000,
              end: 3099,
              url: "http://host.example.com",
            },
          },
        },
      });
    } finally {
      delete process.env["SPUR_PUBLIC_HOST_TEST"];
    }
  });

  it("reads bare env names for sidecar env and port url from project .env", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sidecars:
      dev:
        command: "pnpm dev"
        env:
          PUBLIC_URL: SPUR_SIDECAR_PUBLIC_URL
        ports:
          http:
            env: SPUR_RESERVED_PORT_DEV
            start: 3000
            end: 3099
            url: SPUR_SIDECAR_PUBLIC_URL
`);
    await writeProjectEnv(configPath, "SPUR_SIDECAR_PUBLIC_URL=http://public.example.com\n");

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.sidecars).toEqual({
      dev: {
        command: "pnpm dev",
        autoStart: false,
        env: { PUBLIC_URL: "http://public.example.com" },
        ports: {
          http: {
            env: "SPUR_RESERVED_PORT_DEV",
            start: 3000,
            end: 3099,
            url: "http://public.example.com",
          },
        },
      },
    });
  });

  it("parses optional workspace access block", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    workspaceAccess:
      items:
        - label: Cursor
          kind: copy
          value: cursor --remote ssh-remote+100.80.107.19 \${worktreePathShell}
        - label: Web IDE
          kind: link
          value: https://code.example.com/?folder=\${worktreePathUrl}
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.workspaceAccess).toEqual({
      items: [
        {
          label: "Cursor",
          kind: "copy",
          value: `cursor --remote ssh-remote+100.80.107.19 ${WORKTREE_PATH_SHELL_TOKEN}`,
        },
        {
          label: "Web IDE",
          kind: "link",
          value: `https://code.example.com/?folder=${WORKTREE_PATH_URL_TOKEN}`,
        },
      ],
    });
  });

  it("resolves env placeholders in optional workspace access", async () => {
    process.env["SPUR_WORKSPACE_HOST_TEST"] = "100.80.107.19";
    process.env["SPUR_WORKSPACE_PORT_TEST"] = "9090";
    try {
      const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    workspaceAccess:
      items:
        - label: Cursor
          kind: copy
          value: cursor --remote ssh-remote+\${SPUR_WORKSPACE_HOST_TEST} \${worktreePathShell}
        - label: Web IDE
          kind: link
          value: http://\${SPUR_WORKSPACE_HOST_TEST}:\${SPUR_WORKSPACE_PORT_TEST}/?folder=\${worktreePathUrl}
`);

      const config = loadConfig(configPath);

      expect(config.projects["backend"]?.workspaceAccess).toEqual({
        items: [
          {
            label: "Cursor",
            kind: "copy",
            value: `cursor --remote ssh-remote+100.80.107.19 ${WORKTREE_PATH_SHELL_TOKEN}`,
          },
          {
            label: "Web IDE",
            kind: "link",
            value: `http://100.80.107.19:9090/?folder=${WORKTREE_PATH_URL_TOKEN}`,
          },
        ],
      });
    } finally {
      delete process.env["SPUR_WORKSPACE_HOST_TEST"];
      delete process.env["SPUR_WORKSPACE_PORT_TEST"];
    }
  });

  it("reads bare env names for optional workspace access from project .env", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    workspaceAccess:
      items:
        - label: Cursor
          kind: copy
          value: cursor --remote ssh-remote+SPUR_SIDECAR_PUBLIC_HOST \${worktreePathShell}
        - label: Web IDE
          kind: link
          value: SPUR_VSCODE_WEB_URL/?folder=\${worktreePathUrl}
`);
    await writeProjectEnv(
      configPath,
      [
        "SPUR_SIDECAR_PUBLIC_HOST=100.80.107.19",
        "SPUR_VSCODE_WEB_URL=http://code.example.com:9090",
        "",
      ].join("\n"),
    );

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.workspaceAccess).toEqual({
      items: [
        {
          label: "Cursor",
          kind: "copy",
          value: `cursor --remote ssh-remote+100.80.107.19 ${WORKTREE_PATH_SHELL_TOKEN}`,
        },
        {
          label: "Web IDE",
          kind: "link",
          value: `http://code.example.com:9090/?folder=${WORKTREE_PATH_URL_TOKEN}`,
        },
      ],
    });
  });

  it("omits unresolved bare env names for optional workspace access", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    workspaceAccess:
      items:
        - label: Cursor
          kind: copy
          value: cursor --remote ssh-remote+SPUR_SIDECAR_PUBLIC_HOST \${worktreePathShell}
        - label: Web IDE
          kind: link
          value: SPUR_VSCODE_WEB_URL/?folder=\${worktreePathUrl}
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.workspaceAccess).toBeUndefined();
  });

  it("omits unresolved optional workspace access entries", async () => {
    delete process.env["SPUR_WORKSPACE_HOST_MISSING"];
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    workspaceAccess:
      items:
        - label: Cursor
          kind: copy
          value: cursor --remote ssh-remote+\${SPUR_WORKSPACE_HOST_MISSING} \${worktreePathShell}
        - label: Web IDE
          kind: link
          value: http://\${SPUR_WORKSPACE_HOST_MISSING}:9090/?folder=\${worktreePathUrl}
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.workspaceAccess).toBeUndefined();
  });

  it("requires workspace access items", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    workspaceAccess: {}
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.workspaceAccess.items must be an array",
    );
  });

  it("rejects invalid workspace access item kind", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    workspaceAccess:
      items:
        - label: Nope
          kind: shell
          value: echo hi
`);

    expect(() => loadConfig(configPath)).toThrow(
      'projects.backend.workspaceAccess.items[0].kind must be "copy" or "link"',
    );
  });

  it("omits only unresolved workspace access items", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    workspaceAccess:
      items:
        - label: Cursor
          kind: copy
          value: cursor --remote ssh-remote+SPUR_SIDECAR_PUBLIC_HOST \${worktreePathShell}
        - label: Stable docs
          kind: link
          value: https://example.com/docs
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.workspaceAccess).toEqual({
      items: [{ label: "Stable docs", kind: "link", value: "https://example.com/docs" }],
    });
  });

  it("rejects invalid sidecar port ranges", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sidecars:
      dev:
        command: "pnpm dev"
        ports:
          http:
            env: SPUR_RESERVED_PORT_DEV
            start: 3100
            end: 3000
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.sidecars.dev.ports.http.end must be greater than or equal to projects.backend.sidecars.dev.ports.http.start",
    );
  });

  it("rejects sidecar port urls with explicit ports", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sidecars:
      dev:
        command: "pnpm dev"
        ports:
          http:
            env: SPUR_RESERVED_PORT_DEV
            start: 3000
            end: 3099
            url: http://host.example.com:9090
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.sidecars.dev.ports.http.url must not include an explicit port",
    );
  });

  it("rejects both devServer and sidecars", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    devServer:
      command: "pnpm dev"
    sidecars:
      dev:
        command: "pnpm dev"
`);

    expect(() => loadConfig(configPath)).toThrow('defines both "devServer" and "sidecars"');
  });

  it("returns empty sidecars when no sidecar or devServer key present", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.sidecars).toEqual({});
  });

  it("rejects non-boolean project worktree values", async () => {
    const configPath = await writeConfig(`
projects:
  api:
    path: $REPO_PATH
    worktree: nope
`);

    expect(() => loadConfig(configPath)).toThrow("projects.api.worktree must be a boolean");
  });

  it("rejects non-string project preflight prompts", async () => {
    const configPath = await writeConfig(`
projects:
  api:
    path: $REPO_PATH
    preflight:
      prompt: true
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.api.preflight.prompt must be a non-empty string",
    );
  });

  it("finds spur.yml in the current directory when no config path is passed", async () => {
    delete process.env["SPUR_CONFIG"];
    const configPath = await writeNamedConfig(
      "spur.yml",
      `
projects:
  api:
    path: $REPO_PATH
`,
    );

    process.chdir(join(configPath, ".."));
    const canonicalConfigPath = await realpath(configPath);

    expect(resolveConfigPath()).toBe(canonicalConfigPath);
    expect(loadProjectConfig().configPath).toBe(canonicalConfigPath);
  });

  it("reports the default spur.yaml path when no default config file exists", async () => {
    delete process.env["SPUR_CONFIG"];
    const dir = await createTempDir("spur-fast-config-missing-");
    tempDirs.push(dir);
    process.chdir(dir);
    const canonicalDir = await realpath(dir);

    expect(() => resolveConfigPath()).toThrow(
      `Config file not found: ${join(canonicalDir, "spur.yaml")}`,
    );
  });
});
