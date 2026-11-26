VERSIONING

DS version: registry.json version, independent of the npm version. Commit type follows repo rules; a DS bump rides the commit making the change.


SEMVER

  major   remove or rename token, recipe, primitive, prop, variant; change a token role
  minor   add token, recipe, primitive, variant, scale, guard ban; deprecate with alias; visible value change in the same role, contrast fixes included
  patch   invisible value fix (deltaE under 2), recipe bug fix, registry metadata

  Visible change at any bump: `design` approval first.


LIFECYCLE

  1  add         token per references/tokens.md placement plus registry entry; minor
  2  deprecate   old name aliases new: --old: var(--new); registry entry gains deprecated, replacement, removeIn
  3  migrate     callsites use replacement
  4  remove      next major deletes alias and entry; guard fails on leftovers once version >= removeIn

  Never add and remove in one version.


REGISTRY

  Shape: design/registry.json and its type guard in design-system.test.ts. Extend both together.
  literalAllow: file plus reason; add only for a color that paints outside the app theme (iframe page, canvas raster).


MIGRATION FILE

  migrations/<version>.md, name equals registry version, never edited after merge. Examples: migrations/1.0.0.md, 1.1.0.md.
  Sections: VERSION, CHANGES, CALLSITES, VERIFY. Skill FORMAT law applies.
  CHANGES names tokens and intent; values stay in tokens.css and git history.


GUARD

  Enforced checks: packages/web/src/__tests__/design-system.test.ts.
  Bans and exceptions: packages/web/src/design/registry.json.


CANVAS

  Visual mirror lives outside the repo, owned by the operator. PR body states DS version before -> after so the mirror can sync.
