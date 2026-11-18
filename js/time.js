// Date/time helpers built on Temporal.
//
// Entries store start/end as epoch milliseconds (an instant in physical time).
// Everything shown to the user is projected into the device's IANA time zone,
// so calendar days and week boundaries follow the local wall clock and DST.

export async function ensureTemporal() {
  if (typeof globalThis.Temporal === 'undefined') {
    // Bundled locally (not from a CDN) so the installed app works offline.
    const { Temporal } = await import('../vendor/temporal-polyfill.js');
    globalThis.Temporal = Temporal;
  }
}

const LOCALE = 'en-GB';
const tz = () => Temporal.Now.timeZoneId();

export const zoned = (ms) => Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(tz());
export const dayOf = (ms) => zoned(ms).toPlainDate();
export const today = () => Temporal.Now.plainDateISO();

/** Monday of the week containing `date`. */
export const weekStart = (date) => date.subtract({ days: date.dayOfWeek - 1 });

/** Epoch ms for the start of a calendar day in the local zone. */
export const startOfDay = (date) => date.toZonedDateTime({ timeZone: tz() }).epochMilliseconds;

/** Epoch ms for a wall-clock time on a calendar day ("2026-11-18", "09:30"). */
export function toMs(dateStr, timeStr) {
  return Temporal.PlainDate.from(dateStr)
    .toZonedDateTime({ timeZone: tz(), plainTime: Temporal.PlainTime.from(timeStr) })
    .epochMilliseconds;
}

/** "HH:MM" for <input type="time"> and lists. */
export const timeOf = (ms) => zoned(ms).toPlainTime().toString({ smallestUnit: 'minute' });

const duration = (ms, smallestUnit) =>
  Temporal.Duration.from({ milliseconds: Math.max(0, Math.round(ms)) }).round({
    largestUnit: 'hour',
    smallestUnit,
    roundingMode: smallestUnit === 'second' ? 'trunc' : 'halfExpand',
  });

const clockFormat = new Intl.DurationFormat(LOCALE, { style: 'digital', hoursDisplay: 'always' });
const totalFormat = new Intl.DurationFormat(LOCALE, { style: 'narrow' });

/** Running clock: "1:05:09". */
export const formatClock = (ms) => clockFormat.format(duration(ms, 'second'));

/** Totals: "7h 30m", "45m", "0m". */
export function formatTotal(ms) {
  const d = duration(ms, 'minute');
  return d.sign === 0 ? '0m' : totalFormat.format(d);
}

export const formatDay = (date) =>
  date.toLocaleString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });

export function formatRange(from, to) {
  const sameYear = from.year === to.year;
  const a = from.toLocaleString(LOCALE, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
  const b = to.toLocaleString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
  return `${a} – ${b}`;
}
