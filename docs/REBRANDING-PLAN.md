# Rebranding Plan: Clean-Room Independent Repo

**Decision:** Detach from ashugaev/ao fork. Create independent project.
**Status:** APPROVED
**Referenced in:** STRATEGY.md (Part 0), STRATEGY-FINAL.md (Phase 0)

---

## Why Not Hide the Origin

Hiding origin is risky and unnecessary:
- `git log` forensics, code structure analysis, anyone can discover the connection
- One Reddit/HN post "this project stole Composio's code" = reputation death
- MIT license REQUIRES preserving copyright notice -- skipping it is a license violation
- Being transparent about origins is a STRENGTH ("we built on solid foundations and went further")
- MariaDB, Preact, io.js, LibreOffice all credit their origins prominently and thrived

**The play: credit loudly, differentiate clearly.**

## What MIT License Requires

MIT license has ONE requirement: keep the copyright notice and license text.
You can: fork, rename, rebrand, commercialize, modify -- anything.
You MUST: include the original copyright notice somewhere (LICENSE or NOTICES file).

## Step-by-Step

### 1. Choose a name

Options (check GitHub/npm availability first):
- `agentorch` -- short, memorable, "agent" + "orchestrator"
- `ao-fleet` -- keeps `ao` CLI command
- `agentctl` -- Kubernetes-inspired, feels like infra tooling
- `fleetcode` -- agents as a fleet
- `orchestr8` -- stylized, short
- `agentpilot` -- piloting agents

Requirements:
- GitHub org/repo available
- npm scope available (e.g. `@agentorch/core`)
- Domain available (nice to have)

### 2. Create new GitHub repo (NOT fork)

```bash
# Create fresh repo -- NO "Fork" button, NO git history from upstream
mkdir agentorch && cd agentorch
git init
# Copy your code files (not .git)
cp -r /path/to/agent-orchestrator/* .
cp -r /path/to/agent-orchestrator/.* . 2>/dev/null
rm -rf .git
git init
git add .
git commit -m "Initial commit: agent orchestration with bidirectional messaging"
gh repo create your-org/agentorch --public --source=. --push
```

### 3. Update all package names

Find and replace across codebase:
- `@composio/ao-core` -> `@agentorch/core`
- `@composio/ao-cli` -> `@agentorch/cli`
- `@composio/ao-web` -> `@agentorch/web`
- `@composio/ao-plugin-*` -> `@agentorch/plugin-*`
- `ashugaev/ao` -> `your-org/agentorch`
- All `repository.url` fields in package.json files

### 4. Handle attribution (REQUIRED by MIT)

Option A -- NOTICES file (standard practice, used by Apache projects):
```
NOTICES

This project includes code originally from:

  Agent Orchestrator
  Copyright (c) 2025 Composio, Inc.
  https://github.com/ashugaev/ao
  Licensed under the MIT License

Portions of this codebase were derived from the above project.
Significant additions include bidirectional messaging, inbound context
routing, Jira sprint integration, and source-reply adapters.
```

Option B -- In LICENSE file (simpler):
```
MIT License

Copyright (c) 2026 [Your Name]

Portions copyright (c) 2025 Composio, Inc.
Originally from: https://github.com/ashugaev/ao

[standard MIT text]
```

Option C -- Both (recommended for maximum transparency).

### 5. README attribution

One line in the README, near the bottom:
```markdown
## Acknowledgments

This project builds on [agent-orchestrator](https://github.com/ashugaev/ao)
by Composio, Inc. (MIT licensed). We added bidirectional messaging,
Telegram/Jira integration, and the inbound context system.
```

### 6. What to remove/change

- [ ] All `@composio` npm scopes -> new scope
- [ ] GitHub URLs -> new repo
- [ ] Composio banner image from README
- [ ] "ComposioHQ" references in CLAUDE.md, docs, tests
- [ ] Social media links to @agent_wrapper (unless you own it)
- [ ] The "PRs merged: 61" badge (those are upstream PRs)
- [ ] The "test cases: 3,288" badge linking to upstream release

### 7. What to KEEP

- [ ] LICENSE file with Composio copyright notice (required by MIT)
- [ ] NOTICES file with attribution
- [ ] README acknowledgment section
- [ ] The actual code (it's MIT, this is legal)

### 8. New branding elements needed

- [ ] New GitHub org
- [ ] New npm scope
- [ ] New social preview image (og:image)
- [ ] New banner for README
- [ ] New Discord server
- [ ] New Twitter/X account (optional)
