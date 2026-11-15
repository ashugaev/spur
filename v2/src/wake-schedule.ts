/** Text Spur sends for a scheduled wake that carries no message of its own. */
export const DEFAULT_WAKE_MESSAGE =
  "Scheduled wake-up. Review current state and continue orchestration.";
export const DEFAULT_INTERVAL_WAKE_MESSAGE = "Scheduled interval wake-up. Review current state.";
export const DEFAULT_DAILY_WAKE_MESSAGE = "Scheduled daily wake-up. Review current state.";

export function formatIntervalWakeMessage(
  sessionId: string,
  message: string,
  stopCondition: string,
): string {
  return [
    "Scheduled interval wake-up.",
    `Stop condition: ${stopCondition}`,
    "",
    message,
    "",
    `If the stop condition is satisfied, cancel this interval with \`spur wake ${sessionId} --cancel\`.`,
  ].join("\n");
}

export function formatDailyWakeMessage(
  sessionId: string,
  message: string,
  stopCondition: string,
): string {
  return [
    "Scheduled daily wake-up.",
    `Stop condition: ${stopCondition}`,
    "",
    message,
    "",
    `If the stop condition is satisfied, cancel this daily wake with \`spur wake ${sessionId} --cancel\`.`,
  ].join("\n");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * RegExp source matching an interval or daily wake delivered with Spur's default body. A wake
 * with its own message shares the header but not the body, so it stays real input.
 */
export const DEFAULT_WAKE_FORMAT_PATTERN =
  `^(?:Scheduled interval wake-up\\.\\nStop condition: [\\s\\S]*?\\n\\n${escapeRegExp(DEFAULT_INTERVAL_WAKE_MESSAGE)}` +
  `|Scheduled daily wake-up\\.\\nStop condition: [\\s\\S]*?\\n\\n${escapeRegExp(DEFAULT_DAILY_WAKE_MESSAGE)})` +
  "\\n\\nIf the stop condition is satisfied, cancel this (?:interval|daily wake) with ";

const DAILY_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_DAILY_WAKE_LOOKAHEAD_DAYS = 8;

interface DailyTimeParts {
  value: string;
  hour: number;
  minute: number;
}

function parseDailyTime(value: string): DailyTimeParts {
  const trimmed = value.trim();
  if (!DAILY_TIME_PATTERN.test(trimmed)) {
    throw new Error("dailyAt entries must use HH:MM from 00:00 through 23:59");
  }
  return {
    value: trimmed,
    hour: Number.parseInt(trimmed.slice(0, 2), 10),
    minute: Number.parseInt(trimmed.slice(3), 10),
  };
}

export function normalizeDailyWakeTimes(dailyAt: readonly string[]): string[] {
  if (dailyAt.length === 0) {
    throw new Error("dailyAt requires at least one time");
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of dailyAt) {
    const parsed = parseDailyTime(value);
    if (seen.has(parsed.value)) {
      throw new Error(`duplicate daily wake time: ${parsed.value}`);
    }
    seen.add(parsed.value);
    normalized.push(parsed.value);
  }
  return normalized.sort();
}

export function resolveNextDailyWakeAt(dailyAt: readonly string[], now = new Date()): Date {
  const times = normalizeDailyWakeTimes(dailyAt).map(parseDailyTime);
  for (let dayOffset = 0; dayOffset < MAX_DAILY_WAKE_LOOKAHEAD_DAYS; dayOffset += 1) {
    for (const time of times) {
      const candidate = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + dayOffset,
        time.hour,
        time.minute,
        0,
        0,
      );
      if (candidate.getHours() !== time.hour || candidate.getMinutes() !== time.minute) {
        continue;
      }
      if (candidate.getTime() > now.getTime()) {
        return candidate;
      }
    }
  }
  throw new Error("next daily wake time could not be resolved");
}
