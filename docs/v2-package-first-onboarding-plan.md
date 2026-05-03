## Plan: v2 package-first install + doctor + onboarding shift

Steps
1. `v2/package.json`: turn `v2` into the real install boundary. Remove `private`, add a pack-time build hook, and add an explicit publish whitelist that keeps only runtime assets in the tarball: `dist/**`, `tmux.conf`, `README.md`, `spur.yaml.example`, and package metadata. Exclude `src/`, `test/`, fixtures, and repo-local `bin/` symlink baggage.
2. `v2/src/config.ts`: add a pure scaffold helper that can render and write a project-only `spur.yaml` without calling `loadProjectConfig()` first. Keep the generated file minimal: one `projects.<id>` entry, `path: .`, derived `defaultBranch`, and derived `sessionPrefix`.
3. `v2/src/workspace.ts`: add a doctor-safe branch hint helper for the current repo that handles empty repos and detached HEAD cleanly. Do not change the semantics of existing `readCurrentBranch()` call sites used by session/runtime flows.
4. `v2/src/cli.ts`: add `spur doctor` as a non-interactive command. Reuse `prepareInstanceConfig()` for global auto-init, call the new scaffold helper, refuse to overwrite an existing local `spur.yaml`/`spur.yml`, and print next steps that rely on existing `list`/`spawn` auto-connect instead of calling `connect` directly.
5. `v2/test/fast/config.test.ts`: cover project scaffold YAML shape, file write behavior, and no-config bootstrap cases.
6. `v2/test/fast/workspace.test.ts`: cover branch hint resolution for a normal branch and the empty-repo or detached fallback path used by `doctor`.
7. `v2/test/fast/cli-help.test.ts`: add `doctor` to root help coverage and per-command help coverage.
8. `v2/test/runtime/cli-lifecycle.runtime.test.ts`: add runtime coverage for `doctor` writing a local config, then `list --json` auto-connecting it; add the existing-file/no-overwrite path.
9. `v2/TEST_SCENARIOS.md`: add the `doctor` scenario and the package-boundary expectations so future CLI changes keep this path intact.
10. `v2/spur.yaml.example`: align the example with the project-local config shape that docs and `doctor` now present as the default path.
11. `v2/README.md`: rewrite the primary install and first-run path to package-first: install package or local tarball, run `spur doctor`, then use `spur list` or `spur spawn`. Keep advanced config and sidecar/runtime reference here.
12. `README.md`: make package install plus `spur doctor` the primary user path. Move repo bootstrap to a contributor subsection that points to `SETUP.md`.
13. `SETUP.md`: make this contributor-only. Keep `scripts/setup.sh` here as repo bootstrap and dogfood tooling, not as the main product onboarding path.
14. `TROUBLESHOOTING.md`: split package-install issues from contributor-only `scripts/setup.sh` and `npm link` issues.
15. `CONTRIBUTING.md`: point contributors at `SETUP.md`; keep repo checks unchanged.
16. `scripts/setup.sh`: keep scope minimal. Update output text so it clearly says contributor or dogfood setup, not the default Spur install path.
17. `tests/integration/Dockerfile`: keep repo dependency install for the web smoke, but remove comments and assumptions tied to `npm link`.
18. `tests/integration/onboarding-test.sh`: replace `./scripts/setup.sh` and global-link verification with `pnpm install`, `npm pack` in `v2`, global install of the tarball, `spur doctor`, and then the existing daemon and optional web smoke.

Acceptance criteria
- Package boundary: `npm pack` from `v2` produces an installable tarball that contains built runtime assets only, global tarball install exposes `spur`, and installed runtime can still resolve `tmux.conf`.
- Doctor command: `spur doctor` succeeds in a fresh repo checkout, creates a minimal local `spur.yaml`, never overwrites an existing local config silently, and does not call `connect`, `daemon start`, or any new bootstrap path outside the existing instance auto-init.
- Auto-connect contract: after `spur doctor`, the next `spur list` or `spur spawn` auto-connects the new local config through the existing `maybeAutoConnectProject()` path. `send`, `pause`, `complete`, `kill`, `service`, and hidden `daemon` commands keep their current no-auto-connect behavior.
- Docs rewrite: user-facing docs lead with package install plus `spur doctor`; repo-local `scripts/setup.sh` is visibly demoted to contributor-only guidance.
- Onboarding integration: the repo smoke no longer depends on `npm link`, installs the packed tarball instead, runs `spur doctor`, and still validates the optional `packages/web` UI against the repo checkout.

Risks
- Package whitelist risk: installed runtime reads `tmux.conf` from a relative asset path in `v2/src/runtime-tmux.ts`. Missing it from the tarball breaks live session startup even if `spur --help` works.
- Pack hook risk: `v2/package.json` currently has no `dist/` in git and `npm pack --dry-run` shows source and test files. The pack hook must build before pack without broadening package contents again.
- Branch detection risk: onboarding creates empty repos. Existing `readCurrentBranch()` is not safe to reuse blindly for `doctor` because empty repos and detached HEAD can yield unusable values.
- Config bootstrap risk: `resolveConfigPath()` throws when no local `spur.yaml` exists. `doctor` must scaffold before any code path that tries to load a project config from cwd.
- Registry risk: the generated `project` id and `sessionPrefix` must stay predictable and valid, but `connect` still merges against the global registry. Duplicate ids or prefixes across already-connected configs will surface only on later `list` or `spawn`.
- Scope creep risk: if `doctor` starts editing `~/.spur/config.yaml`, prompting for triggers, or auto-connecting directly, it stops being a thin wrapper around current bootstrap behavior and grows past the requested scope.
- Onboarding split risk: the integration smoke still needs repo dependencies for `packages/web`, so the tarball replaces only the CLI install boundary, not the repo dependency install needed for the UI smoke.

Trade-offs
- Minimal scope: keep `scripts/setup.sh` behavior largely intact and demote it in docs instead of rewriting contributor tooling away from `npm link` in the same change.
- Minimal scope: `spur doctor` only scaffolds local project config. It does not manage the global instance config beyond current auto-init, and it does not auto-connect or start the daemon itself.
- Minimal scope: use a local packed tarball in onboarding to prove the install boundary. Do not add a second wrapper package, release automation, or registry-publish requirements in this step.
- Minimal scope: keep the generated local config lean. Do not scaffold `symlinks`, `sources`, `triggers`, `codexArgs`, or sidecars by default.
- Trade-off: updating `v2/spur.yaml.example` to match the new local-project-first story makes the reference smaller and clearer, but advanced examples may need to move into `v2/README.md` prose instead of living entirely in the example file.

Test coverage
Unit
- `v2/test/fast/config.test.ts`
- `v2/test/fast/workspace.test.ts`
- `v2/test/fast/cli-help.test.ts`

E2E
- `v2/test/runtime/cli-lifecycle.runtime.test.ts`
- `v2/TEST_SCENARIOS.md`
- `tests/integration/onboarding-test.sh`

Design reference
none

Manual checks
none
