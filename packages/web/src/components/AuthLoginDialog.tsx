"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BusyContent } from "@/components/BusyContent";
import {
  Checklist,
  ErrorBox,
  loginErrorCopy,
  type SignInMethod,
  StepLine,
  WaitLine,
} from "@/components/AuthLoginParts";
import { IconCloseButton } from "@/components/IconCloseButton";
import { TerminalIcon } from "@/components/icons/TerminalIcon";
import { TerminalIconButton } from "@/components/TerminalIconButton";
import { INPUT_CLASS, PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from "@/design/classes";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import {
  accountIdentityLine,
  authProviderName,
  invalidateAuthQueries,
  isAuthLogin,
  postAuthJson,
  useAuthAccounts,
} from "@/lib/auth-accounts";
import { readResponsePayload, responseErrorMessage } from "@/lib/json-payload";
import type { AuthAccountSummary, AuthLogin, AuthProvider } from "@/lib/types";

const LOGIN_POLL_INTERVAL_MS = 3_000;
const VERIFIED_CLOSE_MS = 3_000;

interface MethodOption {
  id: SignInMethod;
  title: string;
  description: string;
  tag?: string;
}

const API_KEY_OPTION: Record<AuthProvider, MethodOption> = {
  claude: { id: "api_key", title: "API key", description: "Paste an Anthropic API key" },
  codex: { id: "api_key", title: "API key", description: "Paste an OpenAI API key" },
};

const METHOD_OPTIONS: Record<AuthProvider, MethodOption[]> = {
  claude: [
    {
      id: "oauth",
      title: "Claude account",
      description: "Browser sign-in, paste the returned URL",
    },
    API_KEY_OPTION.claude,
  ],
  codex: [
    {
      id: "device",
      title: "Device code",
      description: "Enter a short code on any device",
      tag: "default",
    },
    { id: "browser", title: "Browser", description: "Browser sign-in, paste the returned URL" },
    API_KEY_OPTION.codex,
  ],
};

const ACCEPTED_LABEL: Record<SignInMethod, string> = {
  oauth: "Code received",
  browser: "Code received",
  device: "Approval received",
  api_key: "Key received",
};

type Phase = "picker" | "api-key" | "attempt";
type View =
  | Exclude<Phase, "attempt">
  | "starting"
  | "authorize"
  | "device"
  | "verifying"
  | "verified"
  | "error";
type Begin = { method: SignInMethod };
type Dismissal = "close" | "terminal" | "back";

/** The account a sign-in targets; identity fields are present once it has signed in. */
export type SignInAccount = Pick<AuthAccountSummary, "id" | "provider" | "displayName"> &
  Partial<Pick<AuthAccountSummary, "identity" | "credential" | "createdAt">>;

interface AuthLoginDialogProps {
  account: SignInAccount;
  /** True for an account added from this flow: the title reads "Add <Provider> account". */
  isNew?: boolean;
  onClose: () => void;
  /** Called once the in-UI attempt is cancelled; the caller opens the terminal. */
  onContinueInTerminal: () => void;
}

export function AuthLoginDialog({
  account,
  isNew = false,
  onClose,
  onContinueInTerminal,
}: AuthLoginDialogProps) {
  const queryClient = useQueryClient();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const doneRef = useRef<HTMLButtonElement | null>(null);
  const options = METHOD_OPTIONS[account.provider];
  const [method, setMethod] = useState<SignInMethod>(options[0].id);
  const [phase, setPhase] = useState<Phase>("picker");
  // Each attempt reads its own status cache, so a settled attempt never leaks into the next.
  const [attempt, setAttempt] = useState(0);
  const [pasted, setPasted] = useState("");
  const [apiKey, setApiKey] = useState("");
  // The submitted key lives here only until the request starts, never in mutation variables.
  const sentKeyRef = useRef("");
  const [copied, setCopied] = useState(false);
  const accountPath = `/api/auth-accounts/${encodeURIComponent(account.id)}`;
  const loginKey = ["auth-account-login", account.id, attempt];

  const beginMutation = useMutation<AuthLogin, Error, Begin & { attempt: number }>({
    mutationFn: async (begin) => {
      const sentKey = sentKeyRef.current;
      sentKeyRef.current = "";
      const result =
        begin.method === "api_key"
          ? await postAuthJson(
              `${accountPath}/api-key`,
              "POST",
              { apiKey: sentKey },
              "Failed to save API key",
            )
          : await postAuthJson(
              `${accountPath}/login`,
              "POST",
              { method: begin.method },
              "Failed to start sign-in",
            );
      if (!isAuthLogin(result)) throw new Error("Failed to start sign-in");
      return result;
    },
    onMutate: (begin) => {
      setAttempt(begin.attempt);
      setPhase("attempt");
    },
    onSuccess: (result, begin) =>
      queryClient.setQueryData(["auth-account-login", account.id, begin.attempt], result),
    onSettled: () => void invalidateAuthQueries(queryClient),
  });

  const statusQuery = useQuery<AuthLogin>({
    queryKey: loginKey,
    queryFn: async ({ signal }) => {
      const response = await fetch(`${accountPath}/login-status`, { signal });
      const payload = await readResponsePayload(response);
      if (!response.ok || !isAuthLogin(payload)) {
        throw new Error(responseErrorMessage(payload, "Failed to read sign-in status"));
      }
      return payload;
    },
    // Reading status before the start call settles would return the previous attempt.
    enabled: attempt > 0 && beginMutation.isSuccess,
    staleTime: LOGIN_POLL_INTERVAL_MS,
    refetchInterval: (query) =>
      query.state.data?.status === "pending" ? LOGIN_POLL_INTERVAL_MS : false,
  });
  const login = attempt > 0 ? statusQuery.data : undefined;
  // Read only once signed in: the verified line names the identity the sign-in produced.
  const accountsQuery = useAuthAccounts(login?.status === "ready");

  const inputMutation = useMutation<unknown, Error, string>({
    mutationFn: (input) =>
      postAuthJson(
        `${accountPath}/login-input`,
        "POST",
        { input },
        "Failed to submit sign-in input",
      ),
    onSuccess: (result) => {
      setPasted("");
      if (isAuthLogin(result)) queryClient.setQueryData(loginKey, result);
    },
    onSettled: () => void invalidateAuthQueries(queryClient),
  });

  const cancelMutation = useMutation<unknown, Error, Dismissal>({
    mutationFn: () =>
      postAuthJson(
        `${accountPath}/login-input`,
        "POST",
        { cancel: true },
        "Failed to cancel sign-in",
      ),
    onSuccess: (_result, dismissal) => {
      if (dismissal === "back") {
        beginMutation.reset();
        setPhase("picker");
      }
    },
    // The daemon forgets a cancelled attempt anyway, so a failed cancel never blocks leaving.
    onSettled: (_result, _error, dismissal) => {
      void invalidateAuthQueries(queryClient);
      if (dismissal === "close") onClose();
      if (dismissal === "terminal") onContinueInTerminal();
    },
  });

  let view: View;
  if (phase !== "attempt") view = phase;
  else if (beginMutation.isError) view = "error";
  else if (beginMutation.isPending || !login) view = "starting";
  else if (login.status === "ready") view = "verified";
  else if (login.status !== "pending") view = "error";
  else if (login.stage === "submitted" || login.stage === "verifying") view = "verifying";
  else view = method === "device" ? "device" : "authorize";

  useEffect(() => {
    if (login?.status === "ready" || login?.status === "failed") {
      void invalidateAuthQueries(queryClient);
    }
  }, [login?.status, queryClient]);

  useEffect(() => {
    if (view !== "verified") return;
    const timer = setTimeout(onClose, VERIFIED_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [view, onClose]);

  const busy = beginMutation.isPending || inputMutation.isPending || cancelMutation.isPending;
  // Only an attempt started here is cancelled; a CLI or other-tab sign-in is left alone.
  const dismiss = () =>
    phase === "attempt" && view !== "verified" ? cancelMutation.mutate("close") : onClose();
  useDialogFocus({ panelRef, initialRef: inputRef, onEscape: dismiss, escapeBlocked: busy });

  // Declared after useDialogFocus so that hook captures the opener before this moves focus.
  useEffect(() => {
    // Views without a field keep focus inside the dialog on the panel.
    ((view === "verified" ? doneRef : inputRef).current ?? panelRef.current)?.focus();
  }, [view]);

  const begin = (next: Begin) => beginMutation.mutate({ ...next, attempt: attempt + 1 });
  const tryAgain = () => {
    if (method === "api_key") {
      beginMutation.reset();
      setPhase("api-key");
    } else {
      begin({ method });
    }
  };
  const goBack = () => (phase === "attempt" ? cancelMutation.mutate("back") : setPhase("picker"));
  const submitKey = () => {
    sentKeyRef.current = apiKey.trim();
    setApiKey("");
    begin({ method: "api_key" });
  };

  const name = authProviderName(account.provider);
  const title = isNew ? `Add ${name} account` : `Sign in ${name} · ${account.displayName}`;
  // The identity arrives with the refetch after the verified sign-in.
  const signedInAccount = accountsQuery.data?.accounts.find((entry) => entry.id === account.id);
  const signedInLine = signedInAccount?.identity ? accountIdentityLine(signedInAccount) : null;
  const actionError = cancelMutation.error ?? inputMutation.error;
  const errorCopy = loginErrorCopy(login, method, beginMutation.error?.message ?? null);
  const url = login?.url;
  const host = url?.replace(/^https?:\/\//, "");

  const copyCode = async () => {
    if (!login?.userCode) return;
    try {
      await navigator.clipboard.writeText(login.userCode);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const openLink = (text: string) =>
    url ? (
      <a
        // The global unlayered `a` color rule beats utilities, so the colors are important (see SessionDetail).
        className={`${PRIMARY_BUTTON_CLASS} inline-flex items-center gap-1.5 text-[var(--color-text-inverse)]! hover:text-[var(--color-text-inverse)]! hover:no-underline`}
        data-testid="auth-login-url"
        href={url}
        rel="noreferrer"
        target="_blank"
      >
        {text} ↗
      </a>
    ) : null;

  const footer = (...buttons: ReactNode[]) => (
    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">{buttons}</div>
  );
  const cancelButton = (
    <button
      key="cancel"
      className={SECONDARY_BUTTON_CLASS}
      disabled={busy}
      type="button"
      onClick={dismiss}
    >
      Cancel
    </button>
  );
  const backButton = (
    <button
      key="back"
      className={SECONDARY_BUTTON_CLASS}
      disabled={busy}
      type="button"
      onClick={goBack}
    >
      Back
    </button>
  );

  return (
    <div
      aria-labelledby="auth-login-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--color-modal-backdrop)]"
      role="dialog"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="max-h-[calc(100dvh-2rem)] w-[min(26rem,calc(100vw-2rem))] overflow-y-auto outline-none border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4 shadow-[0_8px_24px_var(--color-shadow-modal-sm)]"
      >
        <div className="mb-3 flex items-center gap-2">
          <h2
            className="min-w-0 flex-1 font-bold uppercase text-[var(--color-text-primary)] [overflow-wrap:anywhere]"
            id="auth-login-dialog-title"
          >
            {title}
          </h2>
          {view === "verified" ? null : (
            <TerminalIconButton disabled={busy} onClick={() => cancelMutation.mutate("terminal")} />
          )}
          <IconCloseButton
            disabled={busy}
            idleTextClass="text-[var(--color-text-secondary)]"
            label="Close sign-in"
            onClick={dismiss}
          />
        </div>
        <div className="flex flex-col gap-2 normal-case tracking-normal text-[var(--color-text-secondary)]">
          {view === "picker" ? (
            <fieldset
              aria-label="Sign-in method"
              className="flex flex-col gap-1.5"
              role="radiogroup"
            >
              {options.map((option) => (
                <label
                  key={option.id}
                  className={`flex cursor-pointer items-start gap-2.5 border px-2.5 py-2 has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-solid has-[:focus-visible]:outline-[var(--color-accent)] ${
                    method === option.id
                      ? "border-[var(--color-accent)]"
                      : "border-[var(--color-border-default)]"
                  }`}
                >
                  <input
                    ref={method === option.id ? inputRef : undefined}
                    checked={method === option.id}
                    className="sr-only"
                    name="auth-sign-in-method"
                    type="radio"
                    value={option.id}
                    onChange={() => setMethod(option.id)}
                  />
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 h-2.5 w-2.5 shrink-0 border ${
                      method === option.id
                        ? "border-[var(--color-accent)] bg-[var(--color-accent)]"
                        : "border-[var(--color-border-strong)]"
                    }`}
                  />
                  <span>
                    <span className="block font-bold uppercase tracking-[0.06em] text-[var(--color-text-primary)]">
                      {option.title}
                      {option.tag ? (
                        <span className="ml-1.5 border border-[var(--color-border-default)] px-1 font-normal text-[var(--color-text-secondary)]">
                          {option.tag}
                        </span>
                      ) : null}
                    </span>
                    {option.description}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}

          {view === "api-key" ? (
            <>
              <label className="flex flex-col gap-1">
                <span className="uppercase tracking-[0.08em]">API key</span>
                <input
                  ref={inputRef}
                  autoComplete="off"
                  className={`min-w-0 ${INPUT_CLASS}`}
                  spellCheck={false}
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
              <span>Shown by its last 4 characters in Accounts. Key never displayed again.</span>
            </>
          ) : null}

          {view === "starting" ? <WaitLine>Preparing sign-in…</WaitLine> : null}

          {view === "authorize" ? (
            <>
              <StepLine n={1}>Open the sign-in page and approve access.</StepLine>
              <div>{openLink("Open sign-in page")}</div>
              <StepLine n={2}>
                After approval the page won&apos;t load.{" "}
                <span className="font-bold text-[var(--color-text-primary)]">
                  Copy its address bar URL
                </span>{" "}
                and paste it here (or the code#state shown).
              </StepLine>
              <label className="flex flex-col gap-1">
                {account.provider === "codex" ? (
                  <span className="uppercase tracking-[0.08em]">
                    Returned URL · localhost:1455/auth/callback?code=…
                  </span>
                ) : null}
                <input
                  ref={inputRef}
                  aria-label="Returned URL or code"
                  autoComplete="off"
                  className={`min-w-0 ${INPUT_CLASS}`}
                  disabled={busy}
                  spellCheck={false}
                  type="text"
                  value={pasted}
                  onChange={(event) => setPasted(event.target.value)}
                />
              </label>
            </>
          ) : null}

          {view === "device" ? (
            <>
              {login?.userCode ? (
                <>
                  <StepLine n={1}>Copy the code.</StepLine>
                  <div className="flex items-center justify-between gap-2.5 border border-[var(--color-border-strong)] px-3.5 py-3">
                    <span
                      className="min-w-0 break-all text-[22px] font-bold tracking-[0.12em] text-[var(--color-text-primary)] sm:text-[26px] sm:tracking-[0.18em]"
                      data-testid="auth-login-user-code"
                    >
                      {login.userCode}
                    </span>
                    <button
                      className={SECONDARY_BUTTON_CLASS}
                      type="button"
                      onClick={() => void copyCode()}
                    >
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <StepLine n={2}>Open the page and enter the code.</StepLine>
                  <div className="flex flex-wrap items-center gap-2.5">
                    {openLink("Open link")}
                    {host ? <span className="min-w-0 break-all">{host}</span> : null}
                  </div>
                  <WaitLine>Waiting for approval… checks every 3s</WaitLine>
                </>
              ) : (
                <WaitLine>Waiting for the device code…</WaitLine>
              )}
            </>
          ) : null}

          {view === "verifying" ? (
            <>
              <WaitLine>
                <span className="font-bold text-[var(--color-text-primary)]">
                  Verifying sign-in…
                </span>
              </WaitLine>
              <Checklist
                items={[
                  login?.stage === "verifying"
                    ? { label: ACCEPTED_LABEL[method], state: "done" }
                    : { label: "Submitting sign-in", state: "active" },
                  {
                    label: "Test request with new credential",
                    state: login?.stage === "verifying" ? "active" : "todo",
                  },
                  { label: "Account ready", state: "todo" },
                ]}
              />
            </>
          ) : null}

          {view === "verified" ? (
            <>
              <div
                className="flex items-center gap-2 font-bold text-[var(--color-status-ready)]"
                role="status"
              >
                <span aria-hidden="true">✓</span>
                {signedInLine ? `Signed in as ${signedInLine}` : "Signed in"}
              </div>
              <Checklist
                items={[
                  { label: ACCEPTED_LABEL[method], state: "done" },
                  { label: "Test request with new credential", state: "done" },
                  { label: "Account ready", state: "done" },
                ]}
              />
              <span>Account ready for sessions. Closes in 3s.</span>
            </>
          ) : null}

          {view === "error" ? <ErrorBox {...errorCopy} /> : null}

          {actionError ? (
            <div
              className="text-[var(--color-status-error)]"
              data-testid="auth-login-action-error"
              role="alert"
            >
              {actionError.message}
            </div>
          ) : null}
        </div>

        {view === "picker"
          ? footer(
              cancelButton,
              <button
                key="continue"
                className={PRIMARY_BUTTON_CLASS}
                disabled={busy}
                type="button"
                onClick={() => (method === "api_key" ? setPhase("api-key") : begin({ method }))}
              >
                Continue
              </button>,
            )
          : null}
        {view === "api-key"
          ? footer(
              backButton,
              cancelButton,
              <button
                key="save"
                className={PRIMARY_BUTTON_CLASS}
                disabled={busy || !apiKey.trim()}
                type="button"
                onClick={submitKey}
              >
                <BusyContent busy={beginMutation.isPending}>Save</BusyContent>
              </button>,
            )
          : null}
        {view === "starting" ? footer(cancelButton) : null}
        {view === "authorize"
          ? footer(
              backButton,
              cancelButton,
              <button
                key="submit"
                className={PRIMARY_BUTTON_CLASS}
                disabled={busy || !pasted.trim()}
                type="button"
                onClick={() => inputMutation.mutate(pasted.trim())}
              >
                <BusyContent busy={inputMutation.isPending}>Submit</BusyContent>
              </button>,
            )
          : null}
        {view === "device" ? footer(backButton, cancelButton) : null}
        {view === "verifying" ? footer(cancelButton) : null}
        {view === "verified"
          ? footer(
              <button
                key="done"
                ref={doneRef}
                className={PRIMARY_BUTTON_CLASS}
                type="button"
                onClick={onClose}
              >
                Done
              </button>,
            )
          : null}
        {view === "error"
          ? footer(
              <button
                key="retry"
                className={SECONDARY_BUTTON_CLASS}
                disabled={busy}
                type="button"
                onClick={tryAgain}
              >
                Try again
              </button>,
              <button
                key="terminal"
                className={`${PRIMARY_BUTTON_CLASS} inline-flex items-center gap-1.5`}
                disabled={busy}
                type="button"
                onClick={() => cancelMutation.mutate("terminal")}
              >
                <TerminalIcon className="h-3 w-3" />
                Continue in terminal
              </button>,
            )
          : null}
      </div>
    </div>
  );
}
