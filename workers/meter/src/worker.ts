import { registerWorker, Logger } from 'iii-sdk';

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'meter' },
);
const log = new Logger();

const SCOPE = 'meter';
const SAMPLE_TTL_MS = 24 * 60 * 60 * 1000;

type Sample = { ts: number; delta: number };

type Counter = {
  key: string;
  value: number;
  samples: Sample[];
  updated_at: number;
};

type Alert = {
  id: string;
  key: string;
  threshold: number;
  window_ms?: number;
  callback_function_id: string;
  callback_payload?: Record<string, unknown>;
  last_fired_at?: number;
  armed: boolean;
};

process.on('unhandledRejection', (reason) => {
  log.error('meter unhandled rejection', { reason: String(reason) });
});

const stateSet = (key: string, value: unknown) =>
  iii.trigger({ function_id: 'state::set', payload: { scope: SCOPE, key, value } });

const stateGet = async <T>(key: string): Promise<T | null> =>
  ((await iii.trigger({ function_id: 'state::get', payload: { scope: SCOPE, key } })) as T | null) ?? null;

const stateList = async <T>(prefix: string): Promise<T[]> => {
  const v = await iii.trigger({ function_id: 'state::list', payload: { scope: SCOPE, prefix } });
  return Array.isArray(v) ? (v as T[]) : [];
};

const stateDelete = (key: string) =>
  iii.trigger({ function_id: 'state::delete', payload: { scope: SCOPE, key } });

// Per-key mutex. Engine lacks CAS on state today (see issues::assign), so we
// serialize incr for a given key inside this worker to avoid lost updates.
const keyLocks = new Map<string, Promise<void>>();

async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = keyLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => next);
  keyLocks.set(key, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (keyLocks.get(key) === chained) keyLocks.delete(key);
  }
}

function trimSamples(samples: Sample[], now: number): Sample[] {
  const cutoff = now - SAMPLE_TTL_MS;
  return samples.filter((s) => s.ts >= cutoff);
}

function windowSum(samples: Sample[], window_ms: number, now: number): { sum: number; count: number } {
  const cutoff = now - window_ms;
  let sum = 0;
  let count = 0;
  for (const s of samples) {
    if (s.ts >= cutoff) {
      sum += s.delta;
      count += 1;
    }
  }
  return { sum, count };
}

async function loadCounter(key: string): Promise<Counter> {
  const existing = await stateGet<Counter>(`counter:${key}`);
  if (existing) return existing;
  return { key, value: 0, samples: [], updated_at: Date.now() };
}

async function alertsForKey(key: string): Promise<Alert[]> {
  const all = await stateList<Alert>('alert:');
  return all.filter((a) => a.key === key);
}

async function evaluateAlerts(counter: Counter): Promise<void> {
  const alerts = await alertsForKey(counter.key);
  if (alerts.length === 0) return;
  const now = Date.now();
  for (const alert of alerts) {
    const observed = alert.window_ms
      ? windowSum(counter.samples, alert.window_ms, now).sum
      : counter.value;
    const crossed = observed >= alert.threshold;
    if (crossed && alert.armed) {
      alert.armed = false;
      alert.last_fired_at = now;
      await stateSet(`alert:${alert.id}`, alert);
      try {
        await iii.trigger({
          function_id: alert.callback_function_id,
          payload: {
            ...(alert.callback_payload ?? {}),
            alert_id: alert.id,
            key: alert.key,
            value: observed,
          },
        });
      } catch (err) {
        log.error('alert callback failed', {
          alert_id: alert.id,
          callback: alert.callback_function_id,
          reason: String(err),
        });
      }
    } else if (!crossed && !alert.armed) {
      alert.armed = true;
      await stateSet(`alert:${alert.id}`, alert);
    }
  }
}

iii.registerFunction(
  'meter::incr',
  async (input: { key: string; delta?: number }) => {
    const delta = input.delta ?? 1;
    if (!Number.isFinite(delta)) throw new Error('delta must be a finite number');
    return await withKeyLock(input.key, async () => {
      const now = Date.now();
      const counter = await loadCounter(input.key);
      counter.value += delta;
      counter.samples = trimSamples(counter.samples, now);
      counter.samples.push({ ts: now, delta });
      counter.updated_at = now;
      await stateSet(`counter:${input.key}`, counter);
      await evaluateAlerts(counter);
      return { key: counter.key, value: counter.value };
    });
  },
);

iii.registerFunction(
  'meter::get',
  async (input: { key: string; window_ms?: number }) => {
    const counter = await loadCounter(input.key);
    if (input.window_ms !== undefined) {
      const { sum } = windowSum(counter.samples, input.window_ms, Date.now());
      return { key: counter.key, value: sum, window_ms: input.window_ms };
    }
    return { key: counter.key, value: counter.value };
  },
);

iii.registerFunction(
  'meter::window_sum',
  async (input: { key: string; window_ms: number }) => {
    const counter = await loadCounter(input.key);
    const { sum, count } = windowSum(counter.samples, input.window_ms, Date.now());
    return { key: counter.key, window_ms: input.window_ms, sum, samples: count };
  },
);

iii.registerFunction('meter::reset', async (input: { key: string }) => {
  return await withKeyLock(input.key, async () => {
    const counter = await loadCounter(input.key);
    const previous = counter.value;
    const cleared: Counter = {
      key: input.key,
      value: 0,
      samples: [],
      updated_at: Date.now(),
    };
    await stateSet(`counter:${input.key}`, cleared);
    // Re-arm any alerts bound to this key so a future incr can fire them again.
    const alerts = await alertsForKey(input.key);
    for (const a of alerts) {
      if (!a.armed) {
        a.armed = true;
        await stateSet(`alert:${a.id}`, a);
      }
    }
    return { key: input.key, previous };
  });
});

iii.registerFunction(
  'meter::alert_set',
  async (input: {
    id: string;
    key: string;
    threshold: number;
    window_ms?: number;
    callback_function_id: string;
    callback_payload?: Record<string, unknown>;
  }) => {
    if (!input.id) throw new Error('alert id required');
    if (!Number.isFinite(input.threshold)) throw new Error('threshold must be finite');
    const alert: Alert = {
      id: input.id,
      key: input.key,
      threshold: input.threshold,
      window_ms: input.window_ms,
      callback_function_id: input.callback_function_id,
      callback_payload: input.callback_payload,
      armed: true,
    };
    await stateSet(`alert:${input.id}`, alert);
    return { alert_id: input.id };
  },
);

iii.registerFunction('meter::alert_list', async (input: { key?: string }) => {
  const all = await stateList<Alert>('alert:');
  const alerts = input.key ? all.filter((a) => a.key === input.key) : all;
  return { alerts };
});

iii.registerFunction('meter::alert_delete', async (input: { alert_id: string }) => {
  await stateDelete(`alert:${input.alert_id}`);
  return { ok: true };
});

log.info('meter worker registered');
