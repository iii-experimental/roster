import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { registerWorker, Logger } from 'iii-sdk';

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'shell' },
);
const log = new Logger();

// Accept only plain executable names: no slashes, no shell metachars. Prevents
// injection through shell::which bin names.
const SAFE_BIN_RE = /^[A-Za-z0-9_.+-]+$/;

async function resolveOnPath(bin: string): Promise<string | null> {
  if (!SAFE_BIN_RE.test(bin)) return null;
  const paths = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of paths) {
    const candidate = join(dir, bin);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return null;
}

// Never forward the worker's own environment to a spawned child. Build a
// minimal allowlist, then merge input.env entries that pass a key-name check.
const SHELL_ENV_ALLOW = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'USER', 'TMPDIR'] as const;

function buildShellEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SHELL_ENV_ALLOW) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(k)) env[k] = v;
    }
  }
  return env;
}

process.on('unhandledRejection', (reason) => {
  log.error('shell unhandled rejection', { reason: String(reason) });
});

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const DENY_BINS = new Set([
  'rm', 'rmdir', 'mkfs', 'dd', 'shutdown', 'reboot', 'mount',
  'umount', 'sudo', 'su', 'halt', 'poweroff', 'init',
]);

// Interpreters that can smuggle a denied command as an argument. When one of
// these is the exec, scan its args for the real work too.
const INTERPRETERS = new Set(['env', 'sh', 'bash', 'zsh', 'dash', 'ash', 'ksh']);

function basename(token: string): string {
  const t = token.replace(/^['"]|['"]$/g, '').trim();
  const slash = t.lastIndexOf('/');
  return (slash === -1 ? t : t.slice(slash + 1)).toLowerCase();
}

function isDenied(cmd: string, args: readonly string[] = []): boolean {
  const exe = basename(cmd);
  if (DENY_BINS.has(exe)) return true;
  if (exe === ':') return true; // classic fork-bomb alias
  if (INTERPRETERS.has(exe)) {
    // Any positional arg that resolves to a denied bin is also rejected.
    for (const a of args) {
      if (typeof a !== 'string') continue;
      const firstToken = a.trim().split(/\s+/)[0] ?? '';
      if (firstToken && DENY_BINS.has(basename(firstToken))) return true;
    }
  }
  return false;
}

function truncate(buf: string, max: number): string {
  const bytes = Buffer.byteLength(buf, 'utf8');
  if (bytes <= max) return buf;
  const sliced = Buffer.from(buf, 'utf8').subarray(0, max).toString('utf8');
  return `${sliced}\n... [truncated ${bytes - max}b]`;
}

iii.registerFunction(
  'shell::exec',
  async (input: {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeout_ms?: number;
    stdin?: string;
  }) => {
    if (isDenied(input.cmd, input.args ?? [])) {
      throw new Error(`command denied by policy: ${input.cmd}`);
    }
    const timeout = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();

    return await new Promise<{ stdout: string; stderr: string; code: number; elapsed_ms: number }>(
      (resolve, reject) => {
        const child = spawn(input.cmd, input.args ?? [], {
          cwd: input.cwd,
          env: buildShellEnv(input.env),
          timeout,
          shell: false,
        });

        let stdout = '';
        let stderr = '';
        let stdoutBytes = 0;
        let stderrBytes = 0;

        child.stdout.on('data', (d: Buffer) => {
          stdoutBytes += d.byteLength;
          stdout += d.toString('utf8');
          if (stdoutBytes > MAX_OUTPUT_BYTES) child.kill('SIGTERM');
        });
        child.stderr.on('data', (d: Buffer) => {
          stderrBytes += d.byteLength;
          stderr += d.toString('utf8');
          if (stderrBytes > MAX_OUTPUT_BYTES) child.kill('SIGTERM');
        });

        if (input.stdin) {
          child.stdin.write(input.stdin);
          child.stdin.end();
        }

        child.on('error', reject);
        child.on('close', (code) => {
          resolve({
            stdout: truncate(stdout, MAX_OUTPUT_BYTES),
            stderr: truncate(stderr, MAX_OUTPUT_BYTES),
            code: code ?? -1,
            elapsed_ms: Date.now() - started,
          });
        });
      },
    );
  },
);

iii.registerFunction('shell::which', async (input: { bin: string }) => {
  return { path: await resolveOnPath(input.bin) };
});

iii.registerFunction(
  'shell::detect_clis',
  async (input: { bins?: string[] }) => {
    const candidates = input.bins ?? [
      'claude', 'codex', 'openclaw', 'opencode', 'gemini',
      'cursor-agent', 'hermes', 'pi',
    ];
    const found: string[] = [];
    for (const bin of candidates) {
      if (await resolveOnPath(bin)) found.push(bin);
    }
    return { clis: found };
  },
);

log.info('shell worker registered');
