// Hand-mirrored copy of DEFAULT_SELF_DESTRUCT_CONDITION from
// v2/src/self-destruct.ts (web cannot import from v2 — see
// packages/web/server/spur-instance.ts:55 for the convention). Keep both
// literals identical — guarded by the drift test in
// v2/test/fast/self-destruct.test.ts.
export const DEFAULT_SELF_DESTRUCT_CONDITION = "every objective in the task prompt is done";
