# Security Policy

## Reporting

Do not report vulnerabilities in public issues.

Report them privately to the maintainers with:

- affected commit or branch
- impacted files or commands
- reproduction steps
- expected impact

## Scope

This repo's live product surfaces are:

- `v2/`
- `packages/web/`

## Secrets

- Do not commit secrets in Spur configs or env files.
- Prefer environment variables for tokens, keys, and webhook URLs.
- Keep machine-specific or secret-bearing configs in untracked files.

The repository already ignores common secret file patterns and local env files.

## Automated Checks

- Gitleaks runs in CI.
- Dependency audits run in CI.

## Local Checks

Before pushing, you can run:

```bash
gitleaks detect --no-git
pnpm audit --audit-level=moderate
```

## Supported Version

Only the latest mainline branch is supported for security updates.
