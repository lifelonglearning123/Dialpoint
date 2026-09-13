import type { ScheduleState } from "./policy";

/** Same shape as Signal's clients.business_hours: {"mon": {start:"09:00", end:"17:30"}, ...}; a missing/null day is closed. */
export type BusinessHours = Record<string, { start: string; end: string } | null>;

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
void DAY_KEYS;

/** Local wall-clock parts of `date` in `timezone`. */
export function localParts(date: Date, timezone: string) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekday = (parts.weekday ?? "Mon").toLowerCase().slice(0, 3) as (typeof DAY_KEYS)[number];
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    day: weekday,
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${hour}:${parts.minute}`,
  };
}

/**
 * Open right now? No configured hours at all means "always open": a business
 * that never set hours should not have every call treated as after-hours.
 */
export function isOpenAt(date: Date, hours: BusinessHours | null | undefined, timezone: string): boolean {
  const configured = Object.values(hours ?? {}).some((v) => v && v.start && v.end);
  if (!configured) return true;
  const { day, hhmm } = localParts(date, timezone);
  const h = hours?.[day];
  if (!h || !h.start || !h.end) return false;
  if (h.end <= h.start) return hhmm >= h.start || hhmm < h.end; // overnight window
  return hhmm >= h.start && hhmm < h.end;
}

type Holidays = { dates: Set<string>; fetchedAt: number };
const g = globalThis as unknown as { __ukHolidays?: Holidays };
const HOLIDAY_TTL_MS = 24 * 60 * 60 * 1000;

/** England & Wales bank holidays from gov.uk, cached 24h. Fails open (not a holiday). */
export async function ukBankHolidays(): Promise<Set<string>> {
  const cached = g.__ukHolidays;
  if (cached && Date.now() - cached.fetchedAt < HOLIDAY_TTL_MS) return cached.dates;
  try {
    const res = await fetch("https://www.gov.uk/bank-holidays.json", { next: { revalidate: 86400 } });
    if (!res.ok) throw new Error(`gov.uk ${res.status}`);
    const json = (await res.json()) as { "england-and-wales"?: { events?: Array<{ date: string }> } };
    const dates = new Set((json["england-and-wales"]?.events ?? []).map((e) => e.date));
    g.__ukHolidays = { dates, fetchedAt: Date.now() };
    return dates;
  } catch (e) {
    console.warn("[schedule] bank holiday feed unavailable, treating today as a working day", e);
    return cached?.dates ?? new Set();
  }
}

export async function scheduleState(opts: {
  now: Date;
  hours: BusinessHours | null | undefined;
  timezone: string;
  /** ISO dates from tb.closures. */
  closures: string[];
}): Promise<ScheduleState> {
  const { isoDate } = localParts(opts.now, opts.timezone);
  if (opts.closures.includes(isoDate)) return "closed_day";
  const holidays = await ukBankHolidays();
  if (holidays.has(isoDate)) return "closed_day";
  return isOpenAt(opts.now, opts.hours, opts.timezone) ? "in_hours" : "out_of_hours";
}
