PR EVIDENCE

  Visible packages/web change only. tester captures pairs before its PASS verdict; github close-out uploads.

CAPTURE

  - One harness both runs: same browser steps, viewport, fixture data; screenshot changed element located by role/name.
  - Files: "$SPUR_SESSION_ARTIFACTS_DIR"/before/ and after/, same name per state, NN-<state>.png. One capture per state at final head; retake replaces file.
  - Unreachable state: name it and the code line proving it cannot differ; body before cell reads `unreachable`.
  - Branch diff touches packages/web package.json, tsconfig.json or next.config.* -> before state unreachable, no swap.

BEFORE STATE

  Run from repo root on the branch isolated-ui stand. Second command prints anything -> stop. Never git stash, never commit mid-capture. target = PR base branch, main by default.

  base=$(git merge-base "origin/${target:-main}" HEAD)
  git status --short
  git restore --source="$base" --worktree -- packages/web

  Wait for Next recompile, hard reload, confirm changed element renders base state, capture.

  git restore --source=HEAD --worktree -- packages/web
  git diff -z --no-renames --name-only --diff-filter=D "$base" HEAD -- packages/web | xargs -0 -r rm -f --
  git status --short

  Last command prints nothing before any next step.

UPLOAD

  - Repo public: --attach upload is public and irreversible. Fixture data only.
  - Close-out reads every image back right before --attach; retake any frame showing host, path, username, real session or project name.
  - --attach per image on gh pr create or gh pr edit, gh 2.103+; body refs ./before/<file> and ./after/<file>, relative to pr-body.md.
  - gh exits nonzero -> rerun gh pr edit once with same --body-file and every --attach file; still failing -> report.
  - Never commit images, never external image host.
