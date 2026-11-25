---
name: frontend-codestyle
description: Frontend code style and validation for packages/web. Use when reviewing or implementing frontend changes. Visual rules live in design-system.
---

FRONTEND CODESTYLE

DESIGN SYSTEM

  Load `design-system` for tokens, colors, typography, spacing, radius, icons, components, patterns, breakpoints, copy, voice and contrast.
  This skill owns code style and validation only.

DO NOT

  Use `text-sm`/`text-xs`: body size set in `globals.css`, components inherit.
  Show empty attention zones: filter them out.

VALIDATION

  Follow manager's CI/local check ownership; keep Vitest unit/component and Playwright E2E coverage current.

  Add matching Playwright E2E coverage for each new or changed UI surface in `packages/web/tests/` in the same commit.
  Build must pass: `pnpm --dir packages/web build`.
  Manual browser check: use available browser tooling on branch's real isolated-ui sidecar; verify touched scenarios and secure-context behavior through its HTTPS URL when required.
  Use `playwright-test-generator` for new E2E tests when exposed. If missing, write repository Playwright fixtures/browser tools and record the missing tool in validation notes.
  Capture screenshots for each touched state (idle, active, error, loading) and review them.
