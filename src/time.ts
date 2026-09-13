export type Schedule = {
  name: string;
  bot: string;
  /** Local wall-clock time, "HH:MM". */
  time: string;
  /** Days of the week it runs, 0 = Sunday. */
  days: number[];
  prompt: string;
};

export type QuietHours = { start: string; end: string };

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Minutes after midnight for "HH:MM", or undefined when malformed. */
export function parseClock(value: string): number | undefined {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

/** Accepts "daily", "weekdays", "weekends", or a list like ["mon", "wed"]. */
export function parseDays(value: unknown): number[] | undefined {
  if (value === undefined || value === "daily") return [0, 1, 2, 3, 4, 5, 6];
  if (value === "weekdays") return [1, 2, 3, 4, 5];
  if (value === "weekends") return [0, 6];
  if (!Array.isArray(value)) return undefined;
  const days = value.map((d) => DAY_NAMES.indexOf(String(d).trim().slice(0, 3).toLowerCase()));
  return days.length > 0 && days.every((d) => d >= 0) ? [...new Set(days)].sort() : undefined;
}

export function isQuietTime(quiet: QuietHours | undefined, now: Date): boolean {
  if (!quiet) return false;
  const start = parseClock(quiet.start);
  const end = parseClock(quiet.end);
  if (start === undefined || end === undefined || start === end) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** Local calendar day as "YYYY-MM-DD". */
export function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Schedules that should fire now. A schedule missed while the Mac slept still fires
 * if it wakes within `graceMinutes`; each schedule fires at most once per day.
 */
export function dueSchedules(
  schedules: Schedule[],
  now: Date,
  hasRun: (name: string, day: string) => boolean,
  graceMinutes = 120,
): Schedule[] {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const day = localDay(now);
  return schedules.filter((schedule) => {
    const at = parseClock(schedule.time);
    if (at === undefined || !schedule.days.includes(now.getDay())) return false;
    return minutes >= at && minutes - at <= graceMinutes && !hasRun(schedule.name, day);
  });
}
