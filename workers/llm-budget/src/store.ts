import type { Period } from './periods.js';

export const SCOPE = 'budgets';

export type Alert = {
  alert_id: string;
  threshold_pct: number;
  callback_function_id: string;
  callback_payload?: Record<string, unknown>;
  last_fired_period_start?: number;
};

export type Exemption = {
  principal_id: string;
  reason: string;
  expires_at: number;
};

export type Budget = {
  id: string;
  workspace_id?: string;
  agent_id?: string;
  name?: string;
  ceiling_usd: number;
  period: Period;
  spent_usd: number;
  period_start_at: number;
  period_resets_at: number;
  enforced: boolean;
  paused: boolean;
  alerts: Alert[];
  exemptions: Exemption[];
  created_at: number;
  updated_at: number;
};

export type SpendLogEntry = {
  budget_id: string;
  period_start: number;
  period_end: number;
  spent_usd: number;
  records_count: number;
};

export const budgetKey = (id: string) => `budget:${id}`;
export const spendLogKey = (id: string, periodStart: number) =>
  `spend_log:${id}:${periodStart}`;

type Trigger = (arg: { function_id: string; payload: unknown }) => Promise<unknown>;

export function makeStore(trigger: Trigger) {
  const set = (key: string, value: unknown) =>
    trigger({ function_id: 'state::set', payload: { scope: SCOPE, key, value } });

  const get = async <T>(key: string): Promise<T | null> =>
    ((await trigger({ function_id: 'state::get', payload: { scope: SCOPE, key } })) as
      | T
      | null) ?? null;

  const list = async <T>(prefix?: string): Promise<T[]> => {
    const payload: Record<string, unknown> = { scope: SCOPE };
    if (prefix) payload.prefix = prefix;
    const v = await trigger({ function_id: 'state::list', payload });
    return Array.isArray(v) ? (v as T[]) : [];
  };

  const del = (key: string) =>
    trigger({ function_id: 'state::delete', payload: { scope: SCOPE, key } });

  return {
    loadBudget: (id: string) => get<Budget>(budgetKey(id)),
    saveBudget: (b: Budget) => set(budgetKey(b.id), b),
    deleteBudget: (id: string) => del(budgetKey(id)),
    listAll: async (): Promise<Budget[]> => {
      // Server-side prefix filter keeps the budget list cheap even when
      // spend_log:* entries dominate the scope.
      const all = await list<Budget>('budget:');
      return all.filter((v) => v && typeof v === 'object' && 'ceiling_usd' in v);
    },
    saveSpendLog: (id: string, periodStartMs: number, entry: SpendLogEntry) =>
      set(spendLogKey(id, periodStartMs), entry),
    listSpendLogs: async (budgetId: string): Promise<SpendLogEntry[]> => {
      const all = await list<SpendLogEntry>(`spend_log:${budgetId}:`);
      return all.filter(
        (e) => e && typeof e === 'object' && 'budget_id' in e && e.budget_id === budgetId,
      );
    },
  };
}

export type Store = ReturnType<typeof makeStore>;
