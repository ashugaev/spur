"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CenteredLoader } from "@/components/CenteredLoader";
import { formatRelativeTime, formatShortTimestamp, formatTokenCount } from "@/lib/format";
import type {
  ProviderTokenUsage,
  QuotaSourceResult,
  QuotaWindow,
  TokenUsageTotals,
  TokenUsageWindow,
  TokenUsageWindowSummary,
  UsageReport,
} from "@/lib/types";
import {
  errorKindLabel,
  errorKindTone,
  fetchUsage,
  formatResetIn,
  meterTone,
  quotaLevel,
  type MeterTone,
  type QuotaLevel,
} from "@/lib/usage";

type LoadState =
  | { status: "pending" }
  | { status: "error" }
  | { status: "ready"; data: UsageReport };

const PRIMARY_TEXT = "text-[var(--color-text-primary)]";
const SECONDARY_TEXT = "text-[var(--color-text-secondary)]";
const TERTIARY_TEXT = "text-[var(--color-text-tertiary)]";

const TOKEN_WINDOWS: { window: TokenUsageWindow; label: string }[] = [
  { window: "today", label: "Today" },
  { window: "7d", label: "7D" },
  { window: "30d", label: "30D" },
];

const PROVIDER_NAMES: Record<
  ProviderTokenUsage["provider"] | QuotaSourceResult["provider"],
  string
> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
};

const DOT_COLOR: Record<QuotaLevel | "working" | "neutral", string> = {
  neutral: "var(--color-text-tertiary)",
  ready: "var(--color-status-ready)",
  attention: "var(--color-status-attention)",
  error: "var(--color-status-error)",
  working: "var(--color-status-working)",
};

const TONE_TEXT: Record<MeterTone, string> = {
  normal: SECONDARY_TEXT,
  attention: "text-[var(--color-status-attention)]",
  error: "text-[var(--color-status-error)]",
};

const TONE_FILL: Record<MeterTone, string> = {
  normal: "bg-[var(--color-text-secondary)]",
  attention: "bg-[var(--color-status-attention)]",
  error: "bg-[var(--color-status-error)]",
};

const ACTION_CLASS = `uppercase ${SECONDARY_TEXT} outline-none transition underline-offset-2 hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-accent)] focus-visible:underline disabled:opacity-60`;

function SectionHeader({
  dot,
  label,
  right,
}: {
  dot: keyof typeof DOT_COLOR;
  label: string;
  right: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-[13px] pb-1.5 pt-3">
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 shrink-0"
        data-level={dot === "working" ? undefined : dot}
        data-testid={dot === "working" ? undefined : "quota-dot"}
        style={{ background: DOT_COLOR[dot] }}
      />
      <span className={`font-bold uppercase tracking-[0.1em] ${SECONDARY_TEXT}`}>{label}</span>
      <span className="flex-1 border-t border-[var(--color-border-default)]" />
      {right}
    </div>
  );
}

function QuotaMeter({ window: quotaWindow }: { window: QuotaWindow }) {
  const tone = meterTone(quotaWindow.usedPercent);
  const used = Math.round(quotaWindow.usedPercent);
  const reset = formatResetIn(quotaWindow.resetsAt, Date.now());
  const fill = Math.min(100, Math.max(0, quotaWindow.usedPercent));
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2.5 gap-y-1 py-1 sm:grid-cols-[9.5rem_minmax(0,1fr)_4.5rem_4.5rem_9rem] sm:gap-x-3 sm:py-[3px]">
      <span className={`min-w-0 truncate ${PRIMARY_TEXT}`}>{quotaWindow.label}</span>
      <div
        aria-label={quotaWindow.label}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={quotaWindow.usedPercent}
        className="relative order-last col-span-full h-1.5 bg-[var(--color-border-default)] sm:order-none sm:col-span-1"
        data-tone={tone}
        role="meter"
      >
        <span
          className={`absolute inset-y-0 left-0 ${TONE_FILL[tone]}`}
          style={{ width: `${fill}%` }}
        />
      </div>
      <span
        className={`text-right tabular-nums ${tone === "normal" ? PRIMARY_TEXT : TONE_TEXT[tone]}`}
        data-tone={tone}
      >
        {used}% used
      </span>
      <span className={`text-right tabular-nums ${SECONDARY_TEXT}`}>
        {Math.round(quotaWindow.remainingPercent)}% left
      </span>
      <span
        className={`order-last col-span-full text-left sm:order-none sm:col-span-1 sm:text-right ${TERTIARY_TEXT}`}
        title={quotaWindow.resetsAt ? formatShortTimestamp(quotaWindow.resetsAt) : undefined}
      >
        {reset === "no reset time" ? reset : `resets in ${reset}`}
      </span>
    </div>
  );
}

function QuotaSource({ quota }: { quota: QuotaSourceResult }) {
  return (
    <div className="border-b border-[var(--color-border-subtle)] px-[13px] pb-2 pt-1.5 last:border-b-0">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className={`font-bold ${PRIMARY_TEXT}`}>{PROVIDER_NAMES[quota.provider]}</span>
        <span className={SECONDARY_TEXT}>{quota.label}</span>
        {quota.status === "ok" && quota.plan ? (
          <span className={`min-w-0 truncate uppercase ${TERTIARY_TEXT}`}>{quota.plan}</span>
        ) : null}
        <span className="flex-1" />
        <span className={`shrink-0 whitespace-nowrap ${TERTIARY_TEXT}`}>
          {formatRelativeTime(quota.fetchedAt)}
        </span>
      </div>
      {quota.status === "error" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={
              errorKindTone(quota.error) === "warn"
                ? "border border-[var(--color-chip-warn-border)] px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-chip-warn-text)]"
                : "border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-chip-error-text)]"
            }
          >
            {errorKindLabel(quota.error)}
          </span>
          <span className={SECONDARY_TEXT}>{quota.message}</span>
          {quota.httpStatus !== null ? (
            <span className={TERTIARY_TEXT}>HTTP {quota.httpStatus}</span>
          ) : null}
        </div>
      ) : quota.windows.length === 0 ? (
        <div className={TERTIARY_TEXT}>no windows reported</div>
      ) : (
        quota.windows.map((quotaWindow) => (
          <QuotaMeter key={quotaWindow.label} window={quotaWindow} />
        ))
      )}
    </div>
  );
}

const CELL = "py-[5px] pr-[13px] text-right tabular-nums";
const HEAD_CELL =
  "border-b border-[var(--color-border-default)] py-1 pr-[13px] text-right text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]";
const OPTIONAL_COL = "hidden sm:table-cell";

function optionalCount(value: number | undefined): ReactNode {
  return value === undefined ? (
    <span className={TERTIARY_TEXT}>—</span>
  ) : (
    formatTokenCount(value, true)
  );
}

function TokenRow({
  label,
  model,
  sessionCount,
  totals,
}: {
  label: string;
  model: boolean;
  sessionCount: number;
  totals: TokenUsageTotals;
}) {
  const rowClass = `border-b border-[var(--color-border-subtle)] ${
    model ? SECONDARY_TEXT : `font-bold ${PRIMARY_TEXT}`
  }`;
  return (
    <tr className={rowClass}>
      <td className={`py-[5px] pr-[13px] text-left ${model ? "pl-[25px]" : "pl-[13px]"}`}>
        {label}
      </td>
      <td className={CELL}>{sessionCount}</td>
      <td className={CELL}>{formatTokenCount(totals.inputTokens, true)}</td>
      <td className={CELL}>{formatTokenCount(totals.outputTokens, true)}</td>
      <td className={`${CELL} ${OPTIONAL_COL}`}>{optionalCount(totals.cacheReadInputTokens)}</td>
      <td className={`${CELL} ${OPTIONAL_COL}`}>{optionalCount(totals.cacheWriteInputTokens)}</td>
      <td className={`${CELL} ${OPTIONAL_COL}`}>{optionalCount(totals.reasoningOutputTokens)}</td>
      <td className={CELL}>{formatTokenCount(totals.totalTokens, true)}</td>
    </tr>
  );
}

function TokenTable({ summary }: { summary: TokenUsageWindowSummary | undefined }) {
  if (!summary || summary.byProvider.length === 0) {
    return (
      <div className={`px-[13px] py-5 text-center ${SECONDARY_TEXT}`}>
        No sessions in this window
      </div>
    );
  }
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className={`${HEAD_CELL} pl-[13px] !text-left`}>Model</th>
          <th className={HEAD_CELL}>Sess</th>
          <th className={HEAD_CELL}>Input</th>
          <th className={HEAD_CELL}>Output</th>
          <th className={`${HEAD_CELL} ${OPTIONAL_COL}`}>Cache read</th>
          <th className={`${HEAD_CELL} ${OPTIONAL_COL}`}>Cache write</th>
          <th className={`${HEAD_CELL} ${OPTIONAL_COL}`}>Reasoning</th>
          <th className={HEAD_CELL}>Total</th>
        </tr>
      </thead>
      <tbody>
        {summary.byProvider.map((provider) => (
          <ProviderRows key={provider.provider} provider={provider} />
        ))}
      </tbody>
    </table>
  );
}

function ProviderRows({ provider }: { provider: ProviderTokenUsage }) {
  return (
    <>
      <TokenRow
        label={PROVIDER_NAMES[provider.provider]}
        model={false}
        sessionCount={provider.sessionCount}
        totals={provider.totals}
      />
      {provider.byModel.map((entry) => (
        <TokenRow
          key={entry.model ?? "default"}
          label={entry.model ?? "default"}
          model
          sessionCount={entry.sessionCount}
          totals={entry.totals}
        />
      ))}
    </>
  );
}

function UsageContent({ data }: { data: UsageReport }) {
  const [tab, setTab] = useState<TokenUsageWindow>("today");
  const summary = data.tokens.find((entry) => entry.window === tab);
  const level = quotaLevel(data.quotas);
  const okCount = data.quotas.filter((quota) => quota.status === "ok").length;
  return (
    <div className="pb-2">
      <SectionHeader
        dot={data.quotas.length === 0 ? "neutral" : level}
        label="Quota"
        right={
          <span className={`tabular-nums ${SECONDARY_TEXT}`}>
            {okCount}/{data.quotas.length}
          </span>
        }
      />
      {data.quotas.length === 0 ? (
        <div className={`px-[13px] pb-2 pt-1.5 ${TERTIARY_TEXT}`}>No quota sources</div>
      ) : (
        data.quotas.map((quota) => (
          <QuotaSource key={`${quota.provider}/${quota.source}`} quota={quota} />
        ))
      )}
      <SectionHeader
        dot="working"
        label="Tokens"
        right={
          <div className="flex border border-[var(--color-border-default)]">
            {TOKEN_WINDOWS.map((entry, index) => (
              <button
                aria-pressed={tab === entry.window}
                className={`px-2 py-0.5 font-bold uppercase tracking-[0.08em] focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-[var(--color-accent)] ${
                  index > 0 ? "border-l border-[var(--color-border-default)]" : ""
                } ${
                  tab === entry.window
                    ? "bg-[var(--color-accent)] text-[var(--color-text-inverse)]"
                    : `${SECONDARY_TEXT} hover:text-[var(--color-text-primary)]`
                }`}
                key={entry.window}
                onClick={() => setTab(entry.window)}
                type="button"
              >
                {entry.label}
              </button>
            ))}
          </div>
        }
      />
      {summary ? (
        <div className={`px-[13px] pb-1.5 ${TERTIARY_TEXT}`}>
          since {formatShortTimestamp(summary.since)}
        </div>
      ) : null}
      <TokenTable summary={summary} />
    </div>
  );
}

export function UsageModal({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<LoadState>({ status: "pending" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  useEffect(() => {
    const controller = new AbortController();
    fetchUsage(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data });
      },
      () => {
        if (!controller.signal.aborted) setState({ status: "error" });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const retry = () => {
    setState({ status: "pending" });
    setAttempt((value) => value + 1);
  };

  return (
    <div
      aria-labelledby="usage-modal-title"
      aria-modal="true"
      className="fixed inset-0 z-[85] flex items-start justify-center bg-[var(--color-modal-backdrop)] px-2 pb-2 pt-2 sm:px-4 sm:pb-4 sm:pt-[max(2.75rem,calc(var(--safe-top)_+_0.75rem))]"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
    >
      <div className="flex max-h-[calc(100dvh-16px)] w-[min(720px,100%)] flex-col border border-[var(--color-border-strong)] bg-[var(--color-bg-base)] sm:max-h-[80vh]">
        <div className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border-default)] px-[13px] py-2">
          <h2
            className={`font-bold uppercase tracking-[0.1em] ${PRIMARY_TEXT}`}
            id="usage-modal-title"
          >
            Usage
          </h2>
          {state.status === "ready" ? (
            <span className={TERTIARY_TEXT}>
              updated {formatRelativeTime(state.data.generatedAt)}
            </span>
          ) : null}
          <span className="flex-1" />
          <button aria-label="Close usage" className={ACTION_CLASS} onClick={onClose} type="button">
            esc
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {state.status === "ready" ? (
            <UsageContent data={state.data} />
          ) : state.status === "pending" ? (
            <CenteredLoader className="py-6" label="Loading usage" />
          ) : (
            <div className="flex flex-col items-center gap-2.5 px-[13px] py-6">
              <span className="text-[var(--color-status-error)]">Could not load usage</span>
              <button
                className={`border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase outline-none hover:border-[var(--color-accent)] focus-visible:border-[var(--color-accent)] ${PRIMARY_TEXT}`}
                onClick={retry}
                type="button"
              >
                Retry
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
