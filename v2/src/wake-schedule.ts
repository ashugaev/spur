const DAILY_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_DAILY_WAKE_LOOKAHEAD_DAYS = 8;

interface DailyTimeParts {
  value: string;
  hour: number;
  minute: number;
}

function parseDailyTime(value: string): DailyTimeParts {
  const trimmed = value.trim();
  const match = DAILY_TIME_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error("dailyAt entries must use HH:MM from 00:00 through 23:59");
  }
  const [, hourText, minuteText] = match;
  if (hourText === undefined || minuteText === undefined) {
    throw new Error("dailyAt entries must use HH:MM from 00:00 through 23:59");
  }
  return {
    value: trimmed,
    hour: Number.parseInt(hourText, 10),
    minute: Number.parseInt(minuteText, 10),
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
