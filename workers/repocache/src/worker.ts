import { mkdir, rm, stat, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { registerWorker, Logger } from 'iii-sdk';
import {
  cacheKey,
  cloneRepo,
  defaultBranch,
  fetchAndFastForward,
  revParseHead,
  validateRef,
  validateRepoUrl,
} from './git.js';
import { SCOPE, withMutex } from './mutex.js';

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'repocache' },
);
const log = new Logger();

const STATE_ROOT = process.env.III_STATE_DIR
  ? resolve(process.env.III_STATE_DIR)
  : resolve(process.cwd(), 'data');
const CACHE_ROOT = resolve(STATE_ROOT, 'repocache');
const DEFAULT_PRUNE_DAYS = 30;

type RepoEntry = {
  hash: string;
  url: string;
  ref: string;
  path: string;
  head_sha: string;
  created_at: number;
  last_used_at: number;
  size_bytes?: number;
};

process.on('unhandledRejection', (reason) => {
  log.error('repocache unhandled rejection', { reason: String(reason) });
});

const stateSet = (key: string, value: unknown) =>
  iii.trigger({ function_id: 'state::set', payload: { scope: SCOPE, key, value } });

const stateGet = async <T>(key: string): Promise<T | null> =>
  ((await iii.trigger({ function_id: 'state::get', payload: { scope: SCOPE, key } })) as T | null) ?? null;

const stateList = async <T>(): Promise<T[]> => {
  const v = await iii.trigger({ function_id: 'state::list', payload: { scope: SCOPE } });
  return Array.isArray(v) ? (v as T[]) : [];
};

const stateDelete = (key: string) =>
  iii.trigger({ function_id: 'state::delete', payload: { scope: SCOPE, key } });

async function resolveRef(repoUrl: string, ref: string | undefined): Promise<string> {
  if (ref) {
    validateRef(ref);
    return ref;
  }
  const branch = await defaultBranch(repoUrl);
  validateRef(branch);
  return branch;
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function touchLastUsed(entry: RepoEntry): Promise<void> {
  const updated: RepoEntry = { ...entry, last_used_at: Date.now() };
  await stateSet(`repo:${entry.hash}`, updated);
}

async function computeSize(path: string): Promise<number | undefined> {
  // Cheap one-level scan. Full recursive sizing would dominate the call for
  // large repos; callers that need it can walk themselves.
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile());
    const sizes = await Promise.all(
      files.map((e) => stat(join(path, e.name)).then((s) => s.size).catch(() => 0)),
    );
    return sizes.reduce((a, b) => a + b, 0);
  } catch {
    return undefined;
  }
}

iii.registerFunction(
  'repocache::ensure',
  async (input: { repo_url: string; ref?: string }) => {
    validateRepoUrl(input.repo_url);
    const ref = await resolveRef(input.repo_url, input.ref);
    const hash = cacheKey(input.repo_url, ref);
    const path = resolve(CACHE_ROOT, hash);

    return await withMutex(
      (args) => iii.trigger(args),
      hash,
      async () => {
        await mkdir(CACHE_ROOT, { recursive: true });
        const existing = await stateGet<RepoEntry>(`repo:${hash}`);
        const hasDir = await dirExists(path);
        const cached = Boolean(existing) && hasDir;

        if (!cached) {
          if (hasDir) await rm(path, { recursive: true, force: true });
          await cloneRepo(input.repo_url, ref, path);
        } else {
          await fetchAndFastForward(path, ref);
        }

        const head_sha = await revParseHead(path);
        const now = Date.now();
        const entry: RepoEntry = {
          hash,
          url: input.repo_url,
          ref,
          path,
          head_sha,
          created_at: existing?.created_at ?? now,
          last_used_at: now,
          size_bytes: await computeSize(path),
        };
        await stateSet(`repo:${hash}`, entry);
        return { path, head_sha, cached };
      },
    );
  },
);

iii.registerFunction(
  'repocache::path',
  async (input: { repo_url: string; ref?: string }) => {
    validateRepoUrl(input.repo_url);
    const ref = await resolveRef(input.repo_url, input.ref);
    const hash = cacheKey(input.repo_url, ref);
    const entry = await stateGet<RepoEntry>(`repo:${hash}`);
    if (!entry || !(await dirExists(entry.path))) {
      return { path: '', head_sha: '', exists: false };
    }
    await touchLastUsed(entry);
    return { path: entry.path, head_sha: entry.head_sha, exists: true };
  },
);

iii.registerFunction(
  'repocache::prune',
  async (input: { older_than_days?: number } = {}) => {
    const days = input.older_than_days ?? DEFAULT_PRUNE_DAYS;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const entries = await stateList<RepoEntry>();
    const pruned: string[] = [];
    for (const entry of entries) {
      if (entry.last_used_at >= cutoff) continue;
      await rm(entry.path, { recursive: true, force: true }).catch(() => undefined);
      await stateDelete(`repo:${entry.hash}`);
      pruned.push(entry.hash);
    }
    return { pruned };
  },
);

iii.registerFunction(
  'repocache::list',
  async (_input: { cursor?: string } = {}) => {
    const entries = await stateList<RepoEntry>();
    entries.sort((a, b) => b.last_used_at - a.last_used_at);
    return { entries };
  },
);

try {
  iii.registerTrigger({
    type: 'cron',
    function_id: 'repocache::prune',
    config: { schedule: '0 * * * *' },
  });
} catch (err) {
  log.warn('repocache cron trigger failed', { error: String(err) });
}

log.info('repocache worker registered', { cache_root: CACHE_ROOT });
