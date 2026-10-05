# Set up GitHub review protections

Use repository administrator access. Keep auto-merge OFF. These settings protect native reviews and checks; they do not implement Spur's trusted approval gate.

## Prepare two reviewer identities

1. Open account/organization Settings → Developer settings → GitHub Apps → New GitHub App. Create separate code and browser/manual Apps; enter unique names and repository Homepage URL. Deselect webhook Active; select Only on this account.
2. Under Repository permissions, grant Pull requests: Read and write; leave Contents write and Administration unset. Click Create GitHub App, then Install App → Install beside target account → Only select repositories → select this repository → Install. [App registration](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app), [permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), [installation](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app).
3. Alternatively, use two distinct eligible non-author machine-user accounts with repository review permission. Assign one code lane and one browser/manual lane.
4. Prove each identity can submit a native approving review and count toward protection on a sandbox PR. Two sessions sharing one login remain one voter; PR authors cannot approve their own PR. App registration alone proves no review eligibility. [Review requirements](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

This guide does not deploy credentials. Native approval count does not enforce designated code/browser identities.

## Protect main

1. Open repository Settings → Branches → Add classic branch protection rule; edit an existing matching rule instead of adding an overlapping rule. Set Branch name pattern to `main`.
2. Require a pull request before merging; require approvals; select 2 approvals.
3. Enable Dismiss stale pull request approvals when new commits are pushed, Require approval of the most recent reviewable push, and Require conversation resolution before merging.
4. Require status checks; add `Quality`, `Playwright E2E`, `Runtime Integration`, and `Real-Agent Smoke`. Require branches to be up to date before merging.
5. Enable Do not allow bypassing the above settings, including administrators. Leave actor bypass lists empty; leave Allow force pushes and Allow deletions unchecked.
6. Save changes. Verify protections apply to administrators and reviewer Apps on a sandbox PR. [Branch protection steps](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule).

If rulesets also apply, inspect Settings → Rules → Rulesets; keep every applicable Bypass list empty. Options depend on repository plan and ownership. Missing protection options block activation. [Ruleset setup](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository).

Leave merge queue disabled: [CI](../.github/workflows/ci.yml) has no `merge_group` trigger. Add and verify supported merge-group CI before selecting queue requirements. [Merge queue CI](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).

## Handle running or failing CI

Open PR → Checks; inspect all four required jobs. Pending/running, missing, canceled or failing required checks block merge. If a check is unavailable in protection settings, let its workflow complete before selecting it; do not replace it with an optional check.

For failure, open job details, fix the failure and push; rerun transient failures through Actions → workflow run → Re-run jobs → Re-run failed jobs. Wait for required checks on the current revision. Never bypass a failure. [Rerun controls](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).

GitHub accepts skipped/neutral required check conclusions; dependent jobs in [CI](../.github/workflows/ci.yml) can skip after an earlier failure. Native checks alone do not enforce successful execution of every job. Strict-success aggregation: NOT IMPLEMENTED. [Required status-check semantics](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

## Keep automation inactive

Approval Gate and authenticated revision-bound Telegram consent issuer: NOT IMPLEMENTED. Do not require an absent check or treat ordinary Telegram replies, session footers, PR-owned receipts or prompt affirmations as protected proof. Prompt gates remain advisory.

Keep repository Settings → General → Pull Requests → Allow auto-merge unchecked until a separately authorized trusted producer enforces exact reviewer identities, current consent and strict CI success. [Auto-merge settings](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-auto-merge-for-pull-requests-in-your-repository).

Before administrator activation, prove in a sandbox: stale/replayed consent and wrong identities fail; same-App forged checks fail; head/base/review changes invalidate proof; skipped/neutral/missing/canceled jobs fail strict success; privileged credentials remain isolated from PR code. Existing self-hosted runners establish no such isolation by prompt. Manual GitHub setup alone does not complete automated approval.
