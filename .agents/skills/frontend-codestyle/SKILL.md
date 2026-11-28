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

  Follow manager's check ownership and cheapest boundary tier.
  Verify changed visual flows on branch's real isolated-ui sidecar; check secure-context behavior through HTTPS when required.
  Capture and inspect affected states in both themes.
