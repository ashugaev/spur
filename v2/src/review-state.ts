import { integer, object, string, ReviewAppError, type GitHubApp } from "./github-app.js";
import { parseAssessment, type InterfaceAssessment } from "./review-interface.js";

export const stateMarker = "Spur review state v1\n";
export interface LaneState {
  version: 1;
  lane: "code" | "browser";
  repo: string;
  pr: number;
  session: string;
  attempt: string;
  H: string;
  B: string;
  status: "PENDING" | "BLOCKED" | "APPROVED" | "CHANGES_REQUESTED";
  evidenceDigest: string;
  reviewId: number | null;
  assessment: InterfaceAssessment | null;
}
export function parseLaneState(value: unknown): LaneState {
  const data = object(value);
  if (
    data.version !== 1 ||
    (data.lane !== "code" && data.lane !== "browser") ||
    !["PENDING", "BLOCKED", "APPROVED", "CHANGES_REQUESTED"].includes(String(data.status))
  )
    throw new ReviewAppError("invalid-lane-state");
  for (const key of ["H", "B"] as const)
    if (!/^[a-f0-9]{40}$/.test(string(data[key]))) throw new ReviewAppError("invalid-lane-state");
  if (!/^[a-f0-9]{64}$/.test(string(data.evidenceDigest)))
    throw new ReviewAppError("invalid-lane-state");
  const reviewId = data.reviewId === null ? null : integer(data.reviewId);
  const assessment = data.assessment === null ? null : parseAssessment(data.assessment);
  if (
    ["APPROVED", "CHANGES_REQUESTED"].includes(String(data.status)) &&
    (reviewId === null || assessment === null)
  )
    throw new ReviewAppError("invalid-lane-state");
  return {
    version: 1,
    lane: data.lane,
    repo: string(data.repo),
    pr: integer(data.pr),
    session: string(data.session),
    attempt: string(data.attempt),
    H: string(data.H),
    B: string(data.B),
    status: data.status as LaneState["status"],
    evidenceDigest: string(data.evidenceDigest),
    reviewId,
    assessment,
  };
}
export function stateBody(state: LaneState): string {
  return `${stateMarker}${JSON.stringify(parseLaneState(state))}\n\nWritten by Spur · ${state.session}`;
}
export function readStateBody(body: string): LaneState {
  if (!body.startsWith(stateMarker)) throw new ReviewAppError("invalid-lane-state");
  try {
    return parseLaneState(JSON.parse(body.slice(stateMarker.length).split("\n")[0] ?? ""));
  } catch {
    throw new ReviewAppError("invalid-lane-state");
  }
}
export async function publishLaneState(app: GitHubApp, state: LaneState): Promise<void> {
  const body = stateBody(state);
  const access = await app.authenticate();
  const path = `/repos/${state.repo}/issues/${state.pr}/comments`;
  const fresh = async () => {
    if (state.status === "BLOCKED") return;
    const pr = object(await app.request(`/repos/${state.repo}/pulls/${state.pr}`));
    if (pr.state !== "open" || object(pr.head).sha !== state.H || object(pr.base).sha !== state.B)
      throw new ReviewAppError("revision-changed");
  };
  await fresh();
  const exact = (value: unknown) => {
    const row = object(value);
    return row.body === body && object(row.user).login === access.actor;
  };
  const rows = await app.history(path);
  const latest = rows
    .map(object)
    .filter(
      (row) =>
        object(row.user).login === access.actor &&
        typeof row.body === "string" &&
        row.body.startsWith(stateMarker),
    )
    .sort((a, b) => integer(b.id) - integer(a.id))[0];
  if (latest && exact(latest)) return;
  const result = object(await app.request(path, "POST", { body }));
  const readback = await app.request(`/repos/${state.repo}/issues/comments/${integer(result.id)}`);
  if (!exact(result) || !exact(readback)) throw new ReviewAppError("state-publication-mismatch");
  await fresh();
}
export const consentMarker = "Spur interface consent v1\n";
export interface ConsentState {
  version: 1;
  repo: string;
  pr: number;
  task: string;
  branch: string;
  baseBranch: string;
  manifestDigest: string;
  baselineDigest: string;
  challenge: string;
  decision: "approved" | "rejected" | "revoked";
  generation: number;
}
type ConsentScope = Pick<
  ConsentState,
  "repo" | "pr" | "branch" | "baseBranch" | "manifestDigest" | "baselineDigest"
>;
export function sameConsentScope(a: ConsentScope, b: ConsentScope): boolean {
  return (
    a.repo === b.repo &&
    a.pr === b.pr &&
    a.branch === b.branch &&
    a.baseBranch === b.baseBranch &&
    a.manifestDigest === b.manifestDigest &&
    a.baselineDigest === b.baselineDigest
  );
}
export function resolveConsentGeneration(
  states: readonly ConsentState[],
  scope: ConsentScope,
  task: string,
): ConsentState | null {
  const eligible = states.filter((state) => state.task === task && sameConsentScope(state, scope));
  const generation = eligible.reduce((maximum, state) => Math.max(maximum, state.generation), 0);
  const latest = eligible.filter((state) => state.generation === generation);
  const selected = latest[0];
  if (
    selected &&
    latest.some(
      (state) => state.challenge !== selected.challenge || state.decision !== selected.decision,
    )
  )
    throw new ReviewAppError("consent-conflict");
  return selected ?? null;
}
export function parseConsentState(value: unknown): ConsentState {
  const data = object(value);
  if (data.version !== 1 || !["approved", "rejected", "revoked"].includes(String(data.decision)))
    throw new ReviewAppError("invalid-consent-state");
  for (const key of ["manifestDigest", "baselineDigest"])
    if (!/^[a-f0-9]{64}$/.test(string(data[key])))
      throw new ReviewAppError("invalid-consent-state");
  return {
    version: 1,
    repo: string(data.repo),
    pr: integer(data.pr),
    task: string(data.task),
    branch: string(data.branch),
    baseBranch: string(data.baseBranch),
    manifestDigest: string(data.manifestDigest),
    baselineDigest: string(data.baselineDigest),
    challenge: string(data.challenge),
    decision: data.decision as ConsentState["decision"],
    generation: integer(data.generation),
  };
}
export async function publishConsentState(
  app: GitHubApp,
  value: ConsentState,
  session = value.task,
): Promise<void> {
  const state = parseConsentState(value);
  const body = `${consentMarker}${JSON.stringify(state)}\n\nWritten by Spur · ${session}`;
  const access = await app.authenticate();
  const exact = (value: unknown) => {
    const row = object(value);
    return row.body === body && object(row.user).login === access.actor;
  };
  const path = `/repos/${state.repo}/issues/${state.pr}/comments`;
  const history = (await app.history(path))
    .map(object)
    .filter(
      (row) =>
        object(row.user).login === access.actor &&
        typeof row.body === "string" &&
        row.body.startsWith(consentMarker),
    )
    .map((row) => {
      try {
        return {
          row,
          state: parseConsentState(
            JSON.parse(string(row.body).slice(consentMarker.length).split("\n")[0] ?? ""),
          ),
        };
      } catch {
        throw new ReviewAppError("invalid-consent-state");
      }
    })
    .filter((current) => sameConsentScope(current.state, state));
  for (const { state: current } of history) {
    if (current.task !== state.task && state.decision === "approved")
      throw new ReviewAppError("consent-authority-handoff-required");
  }
  const current = resolveConsentGeneration(
    [...history.map((entry) => entry.state), state],
    state,
    state.task,
  );
  if (current && current.generation > state.generation)
    throw new ReviewAppError("consent-superseded");
  const previous = history.sort((a, b) => integer(b.row.id) - integer(a.row.id))[0]?.row;
  if (previous && exact(previous)) return;
  const result = object(await app.request(path, "POST", { body }));
  const readback = await app.request(`/repos/${state.repo}/issues/comments/${integer(result.id)}`);
  if (!exact(result) || !exact(readback)) throw new ReviewAppError("state-publication-mismatch");
}
