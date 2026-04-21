import { registerWorker, Logger } from 'iii-sdk';
import {
  type Period,
  periodStart,
  nextPeriodStart,
  periodKey,
  daysElapsed,
  daysRemaining,
} from './periods.js';
import {
  type Alert,
  type Budget,
  type Exemption,
  makeStore,
} from './store.js';

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'llm-budget' },
);
const log = new Logger();
const store = makeStore((arg) => iii.trigger(arg));

process.on('unhandledRejection', (reason) => {
  log.error('llm-budget unhandled rejection', { reason: String(reason) });
});

function now(): number {
  return Date.now();
}

// In-process per-budget mutex. Serializes concurrent record/reset/update
// operations on the same budget_id so the non-atomic load→mutate→save cycle
// can't lose updates. Engine-level CAS would be a stronger fix but isn't
// exposed yet. This is single-process only; horizontal scale needs
// state-backed locks.
const locks = new Map<string, Promise<unknown>>();
async function withBudgetLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const task = prev.then(fn, fn);
  locks.set(id, task);
  try {
    return await task;
  } finally {
    if (locks.get(id) === task) locks.delete(id);
  }
}

function requireBudget(b: Budget | null, id: string): Budget {
  if (!b) throw new Error(`budget not found: ${id}`);
  return b;
}

// Roll the period forward if we've crossed the reset boundary. Archives each
// closed period to the spend log and returns the rolled budget; caller is
// responsible for persisting (avoids double-writes when combined with record).
async function maybeRollOver(b: Budget, ts: number): Promise<Budget> {
  if (ts < b.period_resets_at) return b;

  let periodStartAt = b.period_start_at;
  let resetsAt = b.period_resets_at;
  let spent = b.spent_usd;
  let archivedCount = 0;

  while (ts >= resetsAt) {
    await store.saveSpendLog(b.id, periodStartAt, {
      budget_id: b.id,
      period_start: periodStartAt,
      period_end: resetsAt,
      spent_usd: spent,
      records_count: 0,
    });
    archivedCount += 1;
    periodStartAt = resetsAt;
    resetsAt = nextPeriodStart(b.period, periodStartAt);
    spent = 0;
  }

  log.info('budget rolled over', { budget_id: b.id, archived_count: archivedCount });
  // Clear alert last-fired so they can re-fire in the new period.
  return {
    ...b,
    period_start_at: periodStartAt,
    period_resets_at: resetsAt,
    spent_usd: spent,
    alerts: b.alerts.map((a) => ({ ...a, last_fired_period_start: undefined })),
    updated_at: ts,
  };
}

function pruneExemptions(b: Budget, ts: number): Budget {
  const live = b.exemptions.filter((e) => e.expires_at > ts);
  if (live.length === b.exemptions.length) return b;
  return { ...b, exemptions: live, updated_at: ts };
}

// Fire-and-forget meter increment. Meter worker may not exist yet; never let
// its absence break the budget record flow.
function bumpMeter(budgetId: string, key: string, delta: number): void {
  iii
    .trigger({
      function_id: 'meter::incr',
      payload: { key: `budget:${budgetId}:${key}`, delta },
    })
    .catch((err) => {
      log.warn('meter::incr failed', { budget_id: budgetId, reason: String(err) });
    });
}

iii.registerFunction(
  'budget::create',
  async (input: {
    workspace_id?: string;
    agent_id?: string;
    ceiling_usd: number;
    period: Period;
    name?: string;
  }) => {
    if (!Number.isFinite(input.ceiling_usd) || input.ceiling_usd <= 0) {
      throw new Error('ceiling_usd must be > 0');
    }
    const ts = now();
    const start = periodStart(input.period, ts);
    const budget: Budget = {
      id: crypto.randomUUID(),
      workspace_id: input.workspace_id,
      agent_id: input.agent_id,
      name: input.name,
      ceiling_usd: input.ceiling_usd,
      period: input.period,
      spent_usd: 0,
      period_start_at: start,
      period_resets_at: nextPeriodStart(input.period, start),
      enforced: true,
      paused: false,
      alerts: [],
      exemptions: [],
      created_at: ts,
      updated_at: ts,
    };
    await store.saveBudget(budget);
    return { budget_id: budget.id };
  },
);

iii.registerFunction(
  'budget::list',
  async (input: { workspace_id?: string }) => {
    const all = await store.listAll();
    const filtered = input.workspace_id
      ? all.filter((b) => b.workspace_id === input.workspace_id)
      : all;
    filtered.sort((a, b) => b.created_at - a.created_at);
    return { budgets: filtered };
  },
);

iii.registerFunction('budget::get', async (input: { budget_id: string }) => {
  return { budget: requireBudget(await store.loadBudget(input.budget_id), input.budget_id) };
});

iii.registerFunction(
  'budget::update',
  async (input: { budget_id: string; patch: Partial<Budget> }) =>
    withBudgetLock(input.budget_id, async () => {
      const ts = now();
      const current = requireBudget(await store.loadBudget(input.budget_id), input.budget_id);
      // Block mutation of immutable fields; spent/period windows are managed
      // internally via record/reset/rollover.
      const {
        id: _id,
        created_at: _created,
        spent_usd: _spent,
        period_start_at: _ps,
        period_resets_at: _pr,
        ...mutable
      } = input.patch as Partial<Budget>;
      if (mutable.ceiling_usd !== undefined) {
        if (!Number.isFinite(mutable.ceiling_usd) || mutable.ceiling_usd <= 0) {
          throw new Error('ceiling_usd must be a positive finite number');
        }
      }
      // If period kind is changing, first roll the old period forward so any
      // elapsed zero-spend boundaries are archived (otherwise a period switch
      // after inactivity would collapse them into one synthetic entry).
      const rolledCurrent =
        mutable.period && mutable.period !== current.period
          ? await maybeRollOver(current, ts)
          : current;
      const next: Budget = { ...rolledCurrent, ...mutable, updated_at: ts };
      if (mutable.period && mutable.period !== rolledCurrent.period) {
        // Period kind changed: archive the just-closed window and re-anchor so
        // the new period starts at zero spend on a deterministic UTC boundary.
        await store.saveSpendLog(rolledCurrent.id, rolledCurrent.period_start_at, {
          budget_id: rolledCurrent.id,
          period_start: rolledCurrent.period_start_at,
          period_end: ts,
          spent_usd: rolledCurrent.spent_usd,
          records_count: 0,
        });
        next.period_start_at = periodStart(mutable.period, ts);
        next.period_resets_at = nextPeriodStart(mutable.period, next.period_start_at);
        next.spent_usd = 0;
        next.alerts = next.alerts.map((a) => ({ ...a, last_fired_period_start: undefined }));
      }
      await store.saveBudget(next);
      return { budget: next };
    }),
);

iii.registerFunction('budget::delete', async (input: { budget_id: string }) =>
  withBudgetLock(input.budget_id, async () => {
    await store.deleteBudget(input.budget_id);
    return { ok: true };
  }),
);

iii.registerFunction(
  'budget::check',
  async (input: { budget_id: string; estimated_cost_usd?: number; principal_id?: string }) =>
    withBudgetLock(input.budget_id, async () => {
      const est = input.estimated_cost_usd ?? 0;
      if (!Number.isFinite(est) || est < 0) {
        throw new Error('estimated_cost_usd must be a finite number >= 0');
      }
      const ts = now();
      const loaded = requireBudget(await store.loadBudget(input.budget_id), input.budget_id);
      const rolled = await maybeRollOver(loaded, ts);
      const b = pruneExemptions(rolled, ts);
      // Persist if rollover or exemption prune mutated anything; check is on
      // the hot path, so only write when state actually changed.
      if (b !== loaded) await store.saveBudget(b);

      const remaining = b.ceiling_usd - b.spent_usd;

      if (b.paused) {
        return { allowed: true, remaining_usd: remaining, reason: 'paused' };
      }
      if (!b.enforced) {
        return { allowed: true, remaining_usd: remaining, reason: 'not_enforced' };
      }
      if (input.principal_id) {
        const exempt = b.exemptions.find((e) => e.principal_id === input.principal_id);
        if (exempt) {
          return { allowed: true, remaining_usd: remaining, reason: 'exempt' };
        }
      }
      if (remaining < est) {
        return { allowed: false, remaining_usd: remaining, reason: 'ceiling_exceeded' };
      }
      return { allowed: true, remaining_usd: remaining };
    }),
);

iii.registerFunction(
  'budget::record',
  async (input: {
    budget_id: string;
    cost_usd: number;
    run_id?: string;
    agent_id?: string;
    tokens_in?: number;
    tokens_out?: number;
  }) =>
    withBudgetLock(input.budget_id, async () => {
    if (!Number.isFinite(input.cost_usd) || input.cost_usd < 0) {
      throw new Error('cost_usd must be >= 0');
    }
    const ts = now();
    let b = requireBudget(await store.loadBudget(input.budget_id), input.budget_id);
    b = await maybeRollOver(b, ts);

    b = { ...b, spent_usd: b.spent_usd + input.cost_usd, updated_at: ts };

    // Fire-and-forget meter bump; never block record on meter availability.
    bumpMeter(b.id, periodKey(b.period, b.period_start_at), input.cost_usd);

    // Alerts: fire once per period when the spent ratio crosses the threshold.
    const ratio = b.spent_usd / b.ceiling_usd;
    const pendingAlerts: Alert[] = [];
    const nextAlerts = b.alerts.map((a) => {
      if (ratio >= a.threshold_pct && a.last_fired_period_start !== b.period_start_at) {
        pendingAlerts.push(a);
        return { ...a, last_fired_period_start: b.period_start_at };
      }
      return a;
    });
    b = { ...b, alerts: nextAlerts };

    await store.saveBudget(b);

    for (const a of pendingAlerts) {
      iii
        .trigger({
          function_id: a.callback_function_id,
          payload: {
            alert_id: a.alert_id,
            budget_id: b.id,
            spent_usd: b.spent_usd,
            ceiling_usd: b.ceiling_usd,
            threshold_pct: a.threshold_pct,
            ...(a.callback_payload ?? {}),
          },
        })
        .catch((err) => {
          log.error('alert callback failed', {
            alert_id: a.alert_id,
            callback: a.callback_function_id,
            reason: String(err),
          });
        });
    }

    return { spent_usd: b.spent_usd, remaining_usd: b.ceiling_usd - b.spent_usd };
  }),
);

iii.registerFunction('budget::reset', async (input: { budget_id: string }) =>
  withBudgetLock(input.budget_id, async () => {
    const ts = now();
    const b = requireBudget(await store.loadBudget(input.budget_id), input.budget_id);
    const previous = b.spent_usd;

    await store.saveSpendLog(b.id, b.period_start_at, {
      budget_id: b.id,
      period_start: b.period_start_at,
      period_end: ts,
      spent_usd: previous,
      records_count: 0,
    });

    const start = periodStart(b.period, ts);
    const reset: Budget = {
      ...b,
      spent_usd: 0,
      period_start_at: start,
      period_resets_at: nextPeriodStart(b.period, start),
      updated_at: ts,
      // Allow alerts to re-fire in the new period.
      alerts: b.alerts.map((a) => ({ ...a, last_fired_period_start: undefined })),
    };
    await store.saveBudget(reset);
    return { budget_id: b.id, previous_spent_usd: previous };
  }),
);

iii.registerFunction(
  'budget::alert_set',
  async (input: {
    budget_id: string;
    threshold_pct: number;
    callback_function_id: string;
    callback_payload?: Record<string, unknown>;
  }) =>
    withBudgetLock(input.budget_id, async () => {
      if (input.threshold_pct <= 0 || input.threshold_pct > 1) {
        throw new Error('threshold_pct must be in (0, 1]');
      }
      const b = requireBudget(await store.loadBudget(input.budget_id), input.budget_id);
      const alert: Alert = {
        alert_id: crypto.randomUUID(),
        threshold_pct: input.threshold_pct,
        callback_function_id: input.callback_function_id,
        callback_payload: input.callback_payload,
      };
      const next: Budget = { ...b, alerts: [...b.alerts, alert], updated_at: now() };
      await store.saveBudget(next);
      return { alert_id: alert.alert_id };
    }),
);

iii.registerFunction(
  'budget::usage',
  async (input: { budget_id: string; window?: 'day' | 'week' | 'month' | 'all' }) =>
    withBudgetLock(input.budget_id, async () => {
      const ts = now();
      const loaded = requireBudget(await store.loadBudget(input.budget_id), input.budget_id);
      // Roll forward so we don't report the previous period as current when
      // a UTC boundary has passed since the last check/record.
      const b = await maybeRollOver(loaded, ts);
      if (b !== loaded) await store.saveBudget(b);

      const logs = await store.listSpendLogs(b.id);
      const window = input.window ?? 'all';

      let cutoff = 0;
      if (window !== 'all') {
        cutoff = periodStart(window, ts);
      }

      const relevant = logs.filter((l) => l.period_start >= cutoff);
      const byPeriod: Array<{ period: number; spent: number }> = relevant
        .map((l) => ({ period: l.period_start, spent: l.spent_usd }))
        .sort((a, b2) => a.period - b2.period);
      if (b.period_start_at >= cutoff) {
        byPeriod.push({ period: b.period_start_at, spent: b.spent_usd });
      }

      const spent = byPeriod.reduce((a, p) => a + p.spent, 0);
      return {
        spent_usd: spent,
        by_period: byPeriod,
        records_count: byPeriod.length,
      };
    }),
);

iii.registerFunction('budget::forecast', async (input: { budget_id: string }) =>
  withBudgetLock(input.budget_id, async () => {
    const ts = now();
    const loaded = requireBudget(await store.loadBudget(input.budget_id), input.budget_id);
    const b = await maybeRollOver(loaded, ts);
    if (b !== loaded) await store.saveBudget(b);

    const elapsed = daysElapsed(b.period_start_at, ts);
    const rate = b.spent_usd / elapsed;

    const projectedMonth = rate * 30;

    const remainingBudget = b.ceiling_usd - b.spent_usd;
    let daysUntilBreach: number | undefined;
    if (rate > 0 && remainingBudget > 0) {
      daysUntilBreach = remainingBudget / rate;
    }

    const remainingDays = daysRemaining(ts, b.period_resets_at);
    const onTrack = rate * remainingDays <= remainingBudget;

    return {
      projected_month_usd: projectedMonth,
      on_track: onTrack,
      days_until_breach: daysUntilBreach,
    };
  }),
);

iii.registerFunction(
  'budget::enforce',
  async (input: { budget_id: string; enforced: boolean }) =>
    withBudgetLock(input.budget_id, async () => {
      const b = requireBudget(await store.loadBudget(input.budget_id), input.budget_id);
      const next: Budget = { ...b, enforced: input.enforced, updated_at: now() };
      await store.saveBudget(next);
      return { budget_id: b.id, enforced: next.enforced };
    }),
);

iii.registerFunction(
  'budget::exempt',
  async (input: { budget_id: string; principal_id: string; reason: string }) =>
    withBudgetLock(input.budget_id, async () => {
      const ts = now();
      const EXEMPT_TTL_MS = 24 * 60 * 60 * 1000;
      const b = pruneExemptions(
        requireBudget(await store.loadBudget(input.budget_id), input.budget_id),
        ts,
      );
      const exemption: Exemption = {
        principal_id: input.principal_id,
        reason: input.reason,
        expires_at: ts + EXEMPT_TTL_MS,
      };
      const without = b.exemptions.filter((e) => e.principal_id !== input.principal_id);
      const next: Budget = {
        ...b,
        exemptions: [...without, exemption],
        updated_at: ts,
      };
      await store.saveBudget(next);
      return { budget_id: b.id, expires_at: exemption.expires_at };
    }),
);

iii.registerFunction(
  'budget::pause',
  async (input: { budget_id: string; paused: boolean }) =>
    withBudgetLock(input.budget_id, async () => {
      const b = requireBudget(await store.loadBudget(input.budget_id), input.budget_id);
      const next: Budget = { ...b, paused: input.paused, updated_at: now() };
      await store.saveBudget(next);
      return { budget_id: b.id, paused: next.paused };
    }),
);

log.info('llm-budget worker registered');
