VERSIONING

DS version: registry.json version, independent of the npm version. Commit type follows repo rules; a DS bump rides the commit making the change.


SEMVER

  major   remove or rename token, recipe, primitive, prop, variant; change a token role; add a guard ban
  minor   add token, recipe, primitive, variant, scale; deprecate with alias; visible value change in the same role, contrast fixes included
  patch   invisible value fix (deltaE under 2), recipe bug fix, registry metadata

  Visible change at any bump: `design` approval first.
  Public page palette (spur-page-theme.vN.css) rename or removal: new vN+1 file, old file stays served, commit `feat(web)!:`.


LIFECYCLE

  1  add         token in both blocks plus registry entry; minor
  2  deprecate   old name aliases new: --old: var(--new); registry entry gains deprecated, replacement, removeIn
  3  migrate     callsites by hand, one file at a time; never sed or codemods
  4  remove      next major deletes alias and entry; guard fails on leftovers once version >= removeIn

  Never add and remove in one version.


REGISTRY

  Shape: design/registry.json and its type guard in design-system.test.ts. Extend both together.
  literalAllow: file plus reason; add only for a color that paints outside the app theme (iframe page, canvas raster).


MIGRATION FILE

  migrations/<version>.md, name equals registry version, never edited after merge. Examples: migrations/1.0.0.md, 1.1.0.md.
  Sections: VERSION, CHANGES, CALLSITES, VERIFY. Skill FORMAT law applies.
  CHANGES names tokens and intent; values stay in tokens.css and git history.


GUARD, design-system.test.ts

  sync        light block equals dark block minus derived equals registry tokens; registry recipes equal classes.ts exports
  version     registry version equals newest migration file
  literals    no color literal outside tokens.css, colors.ts, literalAllow
  refs        every var(--color-*) in src names a registry token
  removed     token past removeIn used nowhere in src
  contrast    every registry contrast rule, both themes, worst surface plus overlay
  mirror      colors.ts constants equal their tokens
  banned      registry banned patterns: arbitrary and named text sizes, arbitrary tracking and shadows, rounded-* except rounded-dot
  tone        design/tone.ts resolves to registry tokens


CANVAS

  Visual mirror lives outside the repo, owned by the operator. PR body states DS version before -> after so the mirror can sync.
