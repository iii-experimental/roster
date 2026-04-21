export type Period = 'day' | 'week' | 'month';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Start of the UTC day containing `ts`.
export function utcDayStart(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// ISO-week style: week starts Monday 00:00 UTC.
export function utcWeekStart(ts: number): number {
  const dayStart = utcDayStart(ts);
  const dow = new Date(dayStart).getUTCDay(); // 0=Sun..6=Sat
  const offsetDays = (dow + 6) % 7; // Mon=0, Sun=6
  return dayStart - offsetDays * MS_PER_DAY;
}

// Start of the UTC month containing `ts`.
export function utcMonthStart(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

// Start of the current period for a given period kind. Deterministic, UTC.
export function periodStart(period: Period, ts: number): number {
  switch (period) {
    case 'day': return utcDayStart(ts);
    case 'week': return utcWeekStart(ts);
    case 'month': return utcMonthStart(ts);
  }
}

// Start of the next period after `start`.
export function nextPeriodStart(period: Period, start: number): number {
  switch (period) {
    case 'day': return start + MS_PER_DAY;
    case 'week': return start + 7 * MS_PER_DAY;
    case 'month': {
      const d = new Date(start);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
  }
}

// A stable key for this period, used as part of meter keys.
export function periodKey(period: Period, start: number): string {
  const d = new Date(start);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  switch (period) {
    case 'day': return `${y}-${m}-${day}`;
    case 'week': return `${y}-W${m}-${day}`;
    case 'month': return `${y}-${m}`;
  }
}

// Days elapsed since `start` at time `now`, with a floor of 1 so we never
// divide by zero when forecasting on the same day a budget was created.
export function daysElapsed(start: number, now: number): number {
  return Math.max(1, (now - start) / MS_PER_DAY);
}

// Full days remaining in the current period from `now` until `resetsAt`.
export function daysRemaining(now: number, resetsAt: number): number {
  return Math.max(0, (resetsAt - now) / MS_PER_DAY);
}

export const MS_DAY = MS_PER_DAY;
