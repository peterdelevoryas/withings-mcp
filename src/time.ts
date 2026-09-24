const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date as YYYY-MM-DD in `tz`. */
export function todayYmd(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds. */
function tzOffsetMs(ms: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map(p => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Unix timestamp (seconds) of local midnight at the start of `ymd` in `tz`. */
export function startOfDay(ymd: string, tz: string): number {
  const utcMidnight = Date.parse(`${ymd}T00:00:00Z`);
  let ms = utcMidnight - tzOffsetMs(utcMidnight, tz);
  ms = utcMidnight - tzOffsetMs(ms, tz); // second pass settles DST transitions
  return Math.floor(ms / 1000);
}

/** Formats a unix timestamp as "YYYY-MM-DD HH:MM" in `tz`. */
export function formatTs(ts: number, tz: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts * 1000));
}

export interface DateRange {
  startYmd: string;
  endYmd: string; // inclusive
  startTs: number;
  endTs: number; // exclusive: midnight after endYmd
}

/** Resolves optional start/end dates (inclusive) into a range, defaulting to the last `defaultDays` days. */
export function resolveRange(start: string | undefined, end: string | undefined, defaultDays: number, tz: string): DateRange {
  for (const d of [start, end]) if (d !== undefined && !YMD.test(d)) throw new Error(`Dates must be YYYY-MM-DD, got "${d}"`);
  const endYmd = end ?? todayYmd(tz);
  const startYmd = start ?? addDays(endYmd, -(defaultDays - 1));
  if (startYmd > endYmd) throw new Error(`start_date ${startYmd} is after end_date ${endYmd}`);
  return { startYmd, endYmd, startTs: startOfDay(startYmd, tz), endTs: startOfDay(addDays(endYmd, 1), tz) };
}
