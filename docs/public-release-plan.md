# Public Release Plan

Status: proposal. Spur is not published to a public store yet. This document describes the shortest future path.

## Goal

Give users one command path to get the `spur` CLI, then add macOS/Linux convenience through Homebrew after the first public CLI release is proven.

## First Store

Start with npm.

Reasons:

- Spur is already a Node CLI.
- `v2/package.json` already builds the CLI entrypoint.
- npm gives the lowest setup cost for users who already have Node.
- GitHub Actions can publish from a tag without long-lived local credentials.

Do not start with Homebrew. Homebrew is useful after npm works, but it adds a tap repository, formula maintenance, checksums, and release update automation.

## Namespaces To Reserve

Reserve these before publishing:

- npm organization or user scope: `@spur` if available and owned by the project.
- npm CLI name under that scope: `@spur/spur`.
- Optional npm alias under the same scope: `@spur/cli`.
- GitHub project repository: `<owner>/spur`.
- Homebrew tap repository: `<owner>/homebrew-spur`.

Avoid:

- npm `spur`: occupied as of 2026-05-14.
- unowned brand scopes.
- publishing under a temporary personal namespace unless that namespace is intended to stay permanent.

If `@spur` cannot be owned, use the final public GitHub organization as the npm scope. Keep the command binary named `spur` either way.

## Release Shape

Keep one public runtime artifact at first:

- source: `v2/`
- CLI binary: `spur`
- contents: built `dist`, `README.md`, `spur.yaml.example`, `tmux.conf`
- excluded: `packages/web`, tests, fixtures, local deployment docs

Keep `packages/web` private. It is an optional UI over the local daemon, not a separate public install surface yet.

## Required Repo Changes

Before first public release:

1. Choose and reserve the final npm scope.
2. Rename `v2/package.json` from private local metadata to the final scoped name.
3. Add public metadata to `v2/package.json`: repository, bugs, homepage, keywords, files, engines.
4. Add `publishConfig` with public access and provenance.
5. Add an npm release workflow triggered by version tags.
6. Add a dry-run check that validates the publish contents.
7. Update README install docs only after the first release exists.

## npm Release Flow

Manual first release:

1. Create the npm scope.
2. Enable MFA on publisher accounts.
3. Configure npm trusted publishing for the GitHub Actions workflow.
4. Build and test from a clean checkout.
5. Tag `v0.1.0`.
6. Let GitHub Actions publish from the tag.
7. Verify install in a clean environment.

After that, normal release:

1. Update changelog and version.
2. Merge to `main`.
3. Push tag.
4. GitHub Actions runs quality checks.
5. GitHub Actions publishes.

## GitHub Actions

Use one workflow:

- trigger: `push` tags matching `v*`
- permissions: `contents: read`, `id-token: write`
- steps: checkout, setup Node, setup pnpm, install, test, build, dry-run contents, publish

Do not use a persistent npm token unless trusted publishing cannot be enabled.

## Homebrew Follow-Up

Add Homebrew after npm has at least one working public release.

Structure:

- repository: `<owner>/homebrew-spur`
- formula: `Formula/spur.rb`
- user command: `brew tap <owner>/spur && brew install spur`

Formula source options:

1. Prefer GitHub release source archive once releases are stable.
2. Use bottles only after install volume justifies maintaining them.

The formula should test:

- `spur --help`
- a minimal command that does not start long-running agent work

Automate Homebrew updates only after the manual formula works.

## Deferred

Defer these until users need them:

- standalone native binaries
- Docker images
- Homebrew core submission
- separate web UI distribution
- install shell script
- release-please or changesets

## Acceptance Criteria

First public release is done when:

- final namespace is owned by the project
- tagged release publishes from CI
- clean install can run `spur --help`
- README install instructions match the real released path
- rollback is documented as unpublishing only within the registry's allowed window, otherwise patch-forward
