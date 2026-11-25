VERSIONING

DS version is independent of the npm version. Commit type follows repo rules; a DS bump rides the commit making the change.


SEMVER

  major   remove or rename token, recipe, primitive, prop, variant; change a token role; add a guard ban
  minor   add token, recipe, primitive, variant, scale; deprecate with alias; visible value change in the same role, contrast fixes included
  patch   invisible value fix (deltaE under 2), recipe bug fix, registry metadata

  Visible change at any bump: `design` approval first.
  Public page palette (spur-page-theme.vN.css) rename or removal: new vN+1 file, old file stays served, commit `feat(web)!:`.


LIFECYCLE

  1  add         new token in both themes plus registry entry; minor
  2  deprecate   old name aliases new: --old: var(--new); registry deprecated, replacement, removeIn
  3  migrate     callsites by hand, one file at a time; never sed or codemods
  4  remove      next major deletes alias and entry; guard fails on leftovers

  Never add and remove in one version.


REGISTRY, packages/web/src/design/registry.json

  Shape: assets/registry.example.json.

  contrast: minimum ratio against every surface, each plus every overlay, both themes.
  Parse with a type guard; registry is repo data, still validated at load.


MIGRATION FILE, packages/web/src/design/migrations/<version>.md

  Skill FORMAT law applies. Sections in order; filled example: assets/migration.example.md.

  VERSION    <semver>  <major|minor|patch>  <date>
  CHANGES    one line each: add | deprecate | remove | value | ban  <name> [-> <replacement>]
  CALLSITES  rg command per old name, edit rule, prop changes
  VERIFY     named tests, screenshot scope, APPROVAL pending | approved by user @ <ISO>

  File name equals registry version. One file per version, never edited after merge.


GUARD, packages/web/src/__tests__/design-system.test.ts

  G1  sync          --color-* in @theme equals light block equals registry tokens
  G2  version       registry.version equals newest migrations/*.md name
  G3  deprecated    deprecated name in src fails once version >= removeIn; listed before
  G4  literals      no hex, rgb, hsl, Tailwind palette color outside theme blocks and colors.ts; extends snippet-tokens.test.ts scope to src
  G5  contrast      every contrast rule holds, translucency composited, both themes
  G6  banned        registry.banned patterns fail from their version
  G7  mirror        colors.ts hex constants equal their CSS token values
  G8  page palette  public/spur/spur-page-theme.v*.css files never deleted

  P0 ships G1 G2 G3 G4 G7. P1 adds G5. P6 adds G6, G8.


CANVAS

  Visual mirror lives outside the repo, owned by the operator. Repo wins. PR body states DS version before -> after so the mirror can sync.
