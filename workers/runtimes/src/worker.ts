import { registerWorker, Logger } from 'iii-sdk';

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'runtimes' },
);
const log = new Logger();

const SCOPE = 'runtimes';
const HEARTBEAT_TTL_MS = 90_000;
// Runtimes offline for longer than this are hard-deleted by gc so stale
// agent-daemon boots (which register a new id on every cold-start) don't
// pile up forever.
const OFFLINE_DELETE_MS = 10 * 60_000;

type Runtime = {
  id: string;
  host: string;
  os: string;
  arch: string;
  clis_available: string[];
  last_heartbeat: number;
  status: 'online' | 'offline' | 'revoked';
};

const stateSet = (key: string, value: unknown) =>
  iii.trigger({ function_id: 'state::set', payload: { scope: SCOPE, key, value } });

const stateGet = async <T>(key: string): Promise<T | null> =>
  ((await iii.trigger({ function_id: 'state::get', payload: { scope: SCOPE, key } })) as T | null) ?? null;

const stateList = async <T>(prefix: string): Promise<T[]> => {
  const v = await iii.trigger({ function_id: 'state::list', payload: { scope: SCOPE, prefix } });
  return Array.isArray(v) ? (v as T[]) : [];
};

iii.registerFunction(
  'runtimes::register',
  async (input: { host: string; os: string; arch: string; clis_available: string[] }) => {
    const id = crypto.randomUUID();
    const rt: Runtime = {
      id,
      host: input.host,
      os: input.os,
      arch: input.arch,
      clis_available: input.clis_available,
      last_heartbeat: Date.now(),
      status: 'online',
    };
    await stateSet(`runtime:${id}`, rt);
    log.info('runtime registered', { id, host: input.host, clis: input.clis_available });
    return { runtime_id: id };
  },
);

iii.registerFunction('runtimes::heartbeat', async (input: { runtime_id: string }) => {
  const rt = await stateGet<Runtime>(`runtime:${input.runtime_id}`);
  if (!rt) throw new Error(`runtime not found: ${input.runtime_id}`);
  rt.last_heartbeat = Date.now();
  if (rt.status === 'offline') rt.status = 'online';
  await stateSet(`runtime:${input.runtime_id}`, rt);
  return { ok: true };
});

iii.registerFunction('runtimes::list', async () => {
  const all = await stateList<Runtime>('runtime:');
  return { runtimes: all };
});

iii.registerFunction('runtimes::revoke', async (input: { runtime_id: string }) => {
  const rt = await stateGet<Runtime>(`runtime:${input.runtime_id}`);
  if (!rt) throw new Error(`runtime not found: ${input.runtime_id}`);
  rt.status = 'revoked';
  await stateSet(`runtime:${input.runtime_id}`, rt);
  return { ok: true };
});

const stateDelete = (key: string) =>
  iii.trigger({ function_id: 'state::delete', payload: { scope: SCOPE, key } });

iii.registerFunction('runtimes::gc', async () => {
  const all = await stateList<Runtime>('runtime:');
  const now = Date.now();
  const offlineCutoff = now - HEARTBEAT_TTL_MS;
  const deleteCutoff = now - OFFLINE_DELETE_MS;
  const ops: Promise<unknown>[] = [];
  let marked = 0;
  let deleted = 0;
  for (const rt of all) {
    if (rt.status === 'online' && rt.last_heartbeat < offlineCutoff) {
      rt.status = 'offline';
      ops.push(stateSet(`runtime:${rt.id}`, rt));
      marked += 1;
      continue;
    }
    if ((rt.status === 'offline' || rt.status === 'revoked') && rt.last_heartbeat < deleteCutoff) {
      ops.push(stateDelete(`runtime:${rt.id}`));
      deleted += 1;
    }
  }
  await Promise.all(ops);
  return { marked_offline: marked, deleted };
});

try {
  iii.registerTrigger({
    type: 'cron',
    function_id: 'runtimes::gc',
    config: { schedule: '*/1 * * * *' },
  });
} catch (err) {
  log.warn('cron trigger failed', { error: String(err) });
}

process.on('unhandledRejection', (reason) => {
  log.error('runtimes unhandled rejection', { reason: String(reason) });
});

log.info('runtimes worker registered');
