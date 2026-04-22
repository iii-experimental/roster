import { randomUUID } from 'node:crypto';

export const SCOPE = 'repocache';
export const STALE_LOCK_MS = 5 * 60 * 1000;
const WAIT_INTERVAL_MS = 500;
const MAX_WAIT_RETRIES = 30;

type Trigger = (args: { function_id: string; payload: unknown }) => Promise<unknown>;

type LockRecord = { held_by: string; acquired_at: number };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Acquire a state-backed lock keyed on (repo_url, ref). On contention we wait
// up to MAX_WAIT_RETRIES * WAIT_INTERVAL_MS; stale locks older than
// STALE_LOCK_MS are stolen so a crashed worker can't pin a key forever.
export async function withMutex<T>(
  trigger: Trigger,
  hash: string,
  body: () => Promise<T>,
): Promise<T> {
  const key = `mutex:${hash}`;
  const heldBy = randomUUID();

  const get = () =>
    trigger({ function_id: 'state::get', payload: { scope: SCOPE, key } }) as Promise<LockRecord | null>;
  const set = (value: LockRecord) =>
    trigger({ function_id: 'state::set', payload: { scope: SCOPE, key, value } });
  const del = () =>
    trigger({ function_id: 'state::delete', payload: { scope: SCOPE, key } }).catch(() => undefined);

  for (let attempt = 0; attempt < MAX_WAIT_RETRIES; attempt += 1) {
    const existing = await get();
    const stale = existing && Date.now() - existing.acquired_at >= STALE_LOCK_MS;

    if (!existing || stale) {
      await set({ held_by: heldBy, acquired_at: Date.now() });
      // Re-read to confirm we won the race. The last writer wins; everyone
      // else backs off and retries.
      const confirmed = await get();
      if (confirmed?.held_by === heldBy) {
        try {
          return await body();
        } finally {
          await del();
        }
      }
    }

    await sleep(WAIT_INTERVAL_MS);
  }

  throw new Error(`repocache: mutex ${hash} held after ${MAX_WAIT_RETRIES} retries`);
}
