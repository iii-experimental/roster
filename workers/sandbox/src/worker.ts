import { registerWorker, Logger } from 'iii-sdk';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve as pathResolve } from 'node:path';
import { spawn } from 'node:child_process';

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'sandbox' },
);
const log = new Logger();

process.on('unhandledRejection', (reason) => {
  log.error('sandbox unhandled rejection', { reason: String(reason) });
});

const STATE_DIR = process.env.III_STATE_DIR ?? '/var/iii/state';
const SANDBOX_ROOT = join(STATE_DIR, 'sandbox');
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

type Sandbox = {
  id: string;
  path: string;
  created_at: number;
};

const sandboxes = new Map<string, Sandbox>();

function resolveSafe(sandboxDir: string, rel: string): string {
  const abs = pathResolve(sandboxDir, rel);
  const base = pathResolve(sandboxDir);
  if (!abs.startsWith(base + '/') && abs !== base) {
    throw new Error(`path traversal rejected: ${rel}`);
  }
  return abs;
}

function truncate(buf: string): string {
  return buf.length > MAX_OUTPUT_BYTES
    ? `${buf.slice(0, MAX_OUTPUT_BYTES)}\n... [truncated]`
    : buf;
}

iii.registerFunction(
  'sandbox::create',
  async (input: { image?: string; resources?: { memory_mib?: number; vcpus?: number } }) => {
    const id = crypto.randomUUID();
    const path = join(SANDBOX_ROOT, id);
    await mkdir(path, { recursive: true });
    const box: Sandbox = { id, path, created_at: Date.now() };
    sandboxes.set(id, box);
    log.info('sandbox created', { id, path });
    return {
      sandbox_id: id,
      path,
      note:
        'v1 stub: files live on host mounted into microVM via virtiofs. ' +
        'Nested-VM isolation waits for engine `vm::spawn` API. ' +
        'For now, isolation = host filesystem subtree + agent-worker microVM boundary.',
    };
  },
);

iii.registerFunction(
  'sandbox::write_files',
  async (input: { sandbox_id: string; files: { path: string; content: string; mode?: number }[] }) => {
    const box = sandboxes.get(input.sandbox_id);
    if (!box) throw new Error(`sandbox not found: ${input.sandbox_id}`);
    for (const f of input.files) {
      const abs = resolveSafe(box.path, f.path);
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, f.content, { mode: f.mode ?? 0o644 });
    }
    return { written: input.files.length };
  },
);

iii.registerFunction(
  'sandbox::read_files',
  async (input: { sandbox_id: string; paths: string[] }) => {
    const box = sandboxes.get(input.sandbox_id);
    if (!box) throw new Error(`sandbox not found: ${input.sandbox_id}`);
    const out: Record<string, string> = {};
    for (const p of input.paths) {
      const abs = resolveSafe(box.path, p);
      try {
        out[p] = await readFile(abs, 'utf-8');
      } catch (err) {
        out[p] = `<error: ${String(err)}>`;
      }
    }
    return { files: out };
  },
);

iii.registerFunction(
  'sandbox::exec',
  async (input: {
    sandbox_id: string;
    cmd: string;
    args?: string[];
    timeout_ms?: number;
    env?: Record<string, string>;
  }) => {
    const box = sandboxes.get(input.sandbox_id);
    if (!box) throw new Error(`sandbox not found: ${input.sandbox_id}`);
    const started = Date.now();
    const timeout = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    return await new Promise<{ stdout: string; stderr: string; code: number; elapsed_ms: number }>(
      (resolveP, reject) => {
        const child = spawn(input.cmd, input.args ?? [], {
          cwd: box.path,
          env: { ...process.env, ...(input.env ?? {}) },
          timeout,
          shell: false,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => {
          stdout += d.toString();
          if (stdout.length > MAX_OUTPUT_BYTES) child.kill('SIGTERM');
        });
        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString();
          if (stderr.length > MAX_OUTPUT_BYTES) child.kill('SIGTERM');
        });
        child.on('error', reject);
        child.on('close', (code) => {
          resolveP({
            stdout: truncate(stdout),
            stderr: truncate(stderr),
            code: code ?? -1,
            elapsed_ms: Date.now() - started,
          });
        });
      },
    );
  },
);

iii.registerFunction('sandbox::destroy', async (input: { sandbox_id: string }) => {
  const box = sandboxes.get(input.sandbox_id);
  if (!box) return { ok: true, noop: true };
  await rm(box.path, { recursive: true, force: true });
  sandboxes.delete(input.sandbox_id);
  return { ok: true };
});

iii.registerFunction('sandbox::list', async () => {
  return { sandboxes: Array.from(sandboxes.values()) };
});

log.info('sandbox worker registered (v1 stub — nested microVM pending engine vm::spawn API)');
