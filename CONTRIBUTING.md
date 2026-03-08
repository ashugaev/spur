# Contributing to Agent Orchestrator

Contributions welcome! The plugin architecture makes it straightforward to add support for new agents, runtimes, trackers, and notifiers.

## Quick Start

```bash
# Fork and clone
git clone https://github.com/<your-username>/agent-orchestrator.git
cd agent-orchestrator

# Install and build
pnpm install
pnpm build

# Run tests
pnpm test

# Typecheck
pnpm typecheck
```

## Writing a Plugin

Every plugin implements a TypeScript interface from `packages/core/src/types.ts`. The fastest way to start:

1. Pick an interface: `Runtime`, `Agent`, `Workspace`, `Tracker`, `SCM`, `Notifier`, `Terminal`
2. Copy an existing plugin as template (e.g., `packages/plugins/notifier-slack/` for a new notifier)
3. Implement the interface methods
4. Export a `PluginModule` with inline `satisfies`:

```typescript
import type { PluginModule, Notifier } from "@composio/ao-core";

export const manifest = {
  name: "my-notifier",
  slot: "notifier" as const,
  description: "Notifier plugin: my-notifier",
  version: "0.1.0",
};

export function create(): Notifier {
  return {
    name: "my-notifier",
    async notify(event) { /* ... */ },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
```

5. Add tests in `__tests__/` or `*.test.ts`
6. Submit a PR

## Code Conventions

- **ESM modules** with `.js` extensions in imports
- **`node:` prefix** for builtins (`import { readFileSync } from "node:fs"`)
- **`execFile`** instead of `exec` (security -- see CLAUDE.md)
- **No `any`** -- use `unknown` + type guards
- **Semicolons, double quotes, 2-space indent**

See [CLAUDE.md](CLAUDE.md) for the full conventions.

## PR Guidelines

- Keep PRs focused -- one feature or fix per PR
- Add tests for new functionality
- Run `pnpm lint && pnpm typecheck` before submitting
- Use conventional commits: `feat:`, `fix:`, `chore:`, `docs:`

## Review SLA

We aim to review all PRs within 48 hours. If you haven't heard back, ping us in the PR.

## Good First Issues

Look for issues labeled [`good first issue`](https://github.com/ashugaev/ao/labels/good%20first%20issue) -- these are scoped, well-documented, and designed for new contributors.

## Need Help?

Open an issue or join our Discord for faster help.
