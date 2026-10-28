/**
 * Epoch budget window (BUD-001).
 *
 * The daily epoch must only count yield and creator fees that were produced in
 * the window immediately before the epoch start. Counting every indexed event
 * (the previous behaviour) turns the budget into a cumulative total, so quota
 * grows every day even when nothing new was harvested.
 *
 * Definition: for an epoch that starts at `epochDate` 00:00 UTC, the budget
 * window is `[epochStart - days * 24h, epochStart)`. With the default of one
 * day, yesterday's yield funds today's quota.
 */

export const DEFAULT_EPOCH_BUDGET_WINDOW_DAYS = 1;
export const MAX_EPOCH_BUDGET_WINDOW_DAYS = 7;
export const SECONDS_PER_DAY = 86_400;

export interface EpochBudgetWindow {
  epochDate: string;
  /** Inclusive lower bound, unix seconds. */
  sinceSec: number;
  /** Exclusive upper bound, unix seconds (the epoch start itself). */
  untilSec: number;
  /** Effective number of days covered by the window. */
  days: number;
}

/**
 * A window of zero days would silently produce a zero budget, so anything below
 * 1 is clamped up instead of being honoured.
 */
function clampDays(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_EPOCH_BUDGET_WINDOW_DAYS;
  }
  const floored = Math.floor(value);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_EPOCH_BUDGET_WINDOW_DAYS);
}

export function resolveEpochBudgetWindow(
  epochDate: string,
  days?: number,
): EpochBudgetWindow {
  const startMs = Date.parse(`${epochDate}T00:00:00Z`);
  if (!Number.isFinite(startMs)) {
    throw new Error(`Invalid epoch date "${epochDate}" (expected YYYY-MM-DD)`);
  }

  const resolvedDays = clampDays(
    days ?? Number(process.env.EPOCH_BUDGET_WINDOW_DAYS ?? DEFAULT_EPOCH_BUDGET_WINDOW_DAYS),
  );
  const untilSec = Math.floor(startMs / 1000);

  return {
    epochDate,
    sinceSec: untilSec - resolvedDays * SECONDS_PER_DAY,
    untilSec,
    days: resolvedDays,
  };
}
