COMPONENTS

Owner file per primitive. Screens compose; never restyle internals.


OWNERS

  packages/web/src/design/classes.ts       shared recipes
  packages/web/src/design/tone.ts          status tone type and helpers
  packages/web/src/components/DataRow.tsx  row shell and actions
  packages/web/src/design/tag.ts           tag chips
  packages/web/src/components/             primitive APIs and state behavior


ADDING A PRIMITIVE

  1  Two or more callers with the same recipe. One caller: keep it local.
  2  Owner file in components/ or recipe in classes.ts. Props: tone, size, variant as unions.
  3  Registry recipe entry when classes.ts gains an export; minor bump; migration file.
  4  Migrate existing duplicates in the same change or list them in roadmap.md.

  New UI design: every new reusable control goes to the DS canvas board 04b as proposed (base) or 05 (composite), marked new or naming the recipe it extends. Approved, it follows steps 1-4.

  Consolidation targets: references/roadmap.md NEXT.
