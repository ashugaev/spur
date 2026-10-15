# CI runner admission

New pull-request stages pass through a GitHub-hosted admission job before entering the self-hosted queue.
Existing queued or running jobs keep their GitHub scheduling order.
Admission reserves no runner and promises no FIFO ordering.

## Scheduling classes

Ready class requires both designated review Apps' effective native approvals at the observed PR head and base, the pinned contract, complete matching file assessments, and required scope consent.
The designated actors come from repository variables `SPUR_CODE_REVIEW_ACTOR` and `SPUR_BROWSER_REVIEW_ACTOR`.
Native and state author identities must match the public App policy in [ci-ready-admission-policy.json](../.github/ci-ready-admission-policy.json).
Observed PR base and live default-branch head remain separate; admission grants no merge qualification.

Ready pull requests enter the queue immediately.
Ordinary pull requests wait only while a verified ready pull request has unfinished current-attempt CI work.
Main, tags, release publishing, and the approval writer receive no admission hold.

## Limits

- CI: 150 seconds before each of Quality, Playwright E2E, Runtime Integration, and Real-Agent Smoke; 600 seconds total allocation per workflow attempt.
- Security: 300 seconds before each scan; 600 seconds total allocation.
- Onboarding: 600 seconds.
- Source loading, metadata requests, and polling consume the stage allocation.
- Initial stages use run creation time; later CI stages use the successful predecessor's completion in the same attempt.
- Retrying an admission job cannot reset its immutable deadline.
- Each stage makes at most 96 read requests, reads at most eight pages per collection, considers 20 candidate PRs, and polls no faster than 30 seconds.

Expiry, missing policy, unavailable trusted source, restricted tokens, malformed evidence, and read failures release ordinary work with a reason.
Admission success never replaces the four real required CI results.
Upstream failure or workflow cancellation prevents dependent stages from running.

## Trusted source and activation

The hosted wrapper loads only the executable and policy from one immutable default-branch SHA, using a read-only workflow token.
It checks no PR code out and receives no reviewer credentials or inherited secrets.
Forks with incomplete identity or insufficient read access receive ordinary admission.
Head, base, source, and review evidence are revalidated; movement removes cached priority.

Before the controller exists on the trusted default branch, its candidate workflow reports degraded ordinary admission.
Candidate tests validate that bootstrap behavior; priority effectiveness requires a subsequent trusted-source ready/ordinary pilot and actual required-job execution.
Implementation and reason fields: [ci-ready-admission.mjs](../scripts/ci-ready-admission.mjs).
