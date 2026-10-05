import { expect, test } from "vitest";
import {
  parseManifest,
  manifestDigest,
  baselineDigest,
  parseAssessment,
} from "../../src/review-interface.js";

const manifest = {
  version: 1,
  repository: "owner/repo",
  baseBranch: "main",
  surfaces: [
    {
      kind: "CLI",
      id: "spur example",
      before: ["old behavior"],
      after: ["new behavior"],
      constraints: ["no restart"],
    },
  ],
};
test("semantic sets canonicalize without implementation/head hashes", () => {
  const parsed = parseManifest(manifest);
  expect(manifestDigest(parsed)).toBe(
    manifestDigest(parseManifest({ ...manifest, unrelatedInternalCommit: "new head" })),
  );
  expect(baselineDigest(parsed)).toBe(
    baselineDigest(
      parseManifest({
        ...manifest,
        surfaces: [{ ...manifest.surfaces[0], after: ["other behavior"] }],
      }),
    ),
  );
  expect(manifestDigest(parsed)).not.toBe(
    manifestDigest(
      parseManifest({
        ...manifest,
        surfaces: [{ ...manifest.surfaces[0], after: ["other behavior"] }],
      }),
    ),
  );
  expect(baselineDigest(parsed)).not.toBe(
    baselineDigest(
      parseManifest({
        ...manifest,
        surfaces: [{ ...manifest.surfaces[0], before: ["changed baseline"] }],
      }),
    ),
  );
});
test("duplicate identities and unsupported assessment exemptions fail", () => {
  expect(() =>
    parseManifest({ ...manifest, surfaces: [...manifest.surfaces, ...manifest.surfaces] }),
  ).toThrow();
  expect(() => parseAssessment({ status: "N/A", manifest, dispositions: [] })).toThrow();
  expect(() =>
    parseAssessment({
      status: "required",
      manifest,
      dispositions: [{ path: "cli.ts", callers: [], surfaceIds: ["missing"], evidence: ["proof"] }],
    }),
  ).toThrow();
});
