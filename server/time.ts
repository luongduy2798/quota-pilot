import { AppError } from "./types";
export const DEFAULT_TIMEZONE = "Asia/Ho_Chi_Minh";
export function validateTimezone(value: unknown): string {
  if (typeof value !== "string" || value.length > 80)
    throw new AppError("invalid_timezone");
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return value;
  } catch {
    throw new AppError("invalid_timezone");
  }
}
export function validateTime(value: unknown): string {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    throw new AppError("invalid_time");
  return value;
}
export function validateWeekdays(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 7 ||
    value.some((v) => !Number.isInteger(v) || v < 0 || v > 6)
  )
    throw new AppError("invalid_weekdays");
  return [...new Set(value)].sort();
}
export function nextOccurrence(
  localTime: string,
  timezone: string,
  weekdays: number[],
  after: Date,
): string {
  validateTime(localTime);
  validateTimezone(timezone);
  validateWeekdays(weekdays);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  function parts(date: Date) {
    const p = Object.fromEntries(
      formatter.formatToParts(date).map((v) => [v.type, v.value]),
    );
    return {
      year: +p.year,
      month: +p.month,
      day: +p.day,
      hour: +p.hour,
      minute: +p.minute,
      second: +p.second,
    };
  }
  const today = parts(after),
    [hour, minute] = localTime.split(":").map(Number);
  const start = Date.UTC(today.year, today.month - 1, today.day);
  for (let day = 0; day <= 8; day++) {
    const date = new Date(start + day * 86400000);
    if (!weekdays.includes(date.getUTCDay())) continue;
    const wall = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      hour,
      minute,
    );
    const offsets = new Set<number>();
    // Nearby UTC offsets cover DST changes, including half-hour transitions.
    for (const delta of [-36, -12, 0, 12, 36]) {
      const sample = new Date(wall + delta * 3600000),
        p = parts(sample);
      offsets.add(
        Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
          sample.getTime(),
      );
    }
    const candidates = [...offsets]
      .map((offset) => new Date(wall - offset))
      .filter((candidate) => {
        const p = parts(candidate);
        return (
          p.year === date.getUTCFullYear() &&
          p.month === date.getUTCMonth() + 1 &&
          p.day === date.getUTCDate() &&
          p.hour === hour &&
          p.minute === minute
        );
      })
      .sort((a, b) => a.getTime() - b.getTime());
    // Nonexistent spring time: skip. Repeated fall time: first occurrence only.
    if (candidates[0] && candidates[0] > after)
      return candidates[0].toISOString();
  }
  throw new AppError("next_occurrence_unavailable");
}
