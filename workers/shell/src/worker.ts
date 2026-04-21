import { registerWorker, Logger } from 'iii-sdk';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'shell' },
);
const log = new Logger();
const execFileAsync = promisify(execFile);

process.on('unhandledRejection', (reason) => {
  log.error('shell unhandled rejection', { reason: String(reason) });
});

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const DENY_PREFIX = [
  'rm ', 'rmdir ', 'mkfs', 'dd ', 'shutdown', 'reboot', 'mount ',
  'umount ', 'sudo', 'su ', ':(){ :|:& };:',
];

function isDenied(cmd: string): boolean {
  const lower = cmd.trim().toLowerCase();
  return DENY_PREFIX.some((p) => lower.startsWith(p));
}

function truncate(buf: string, max: number): string {
  return buf.length > max ? `${buf.slice(0, max)}\n... [truncated ${buf.length - max}b]` : buf;
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
    if (isDenied(input.cmd)) {
      throw new Error(`command denied by policy: ${input.cmd}`);
    }
    const timeout = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();

    return await new Promise<{ stdout: string; stderr: string; code: number; elapsed_ms: number }>(
      (resolve, reject) => {
        const child = spawn(input.cmd, input.args ?? [], {
          cwd: input.cwd,
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
  try {
    const { stdout } = await execFileAsync('command', ['-v', input.bin], { shell: '/bin/sh' });
    const path = stdout.trim();
    return { path: path || null };
  } catch {
    return { path: null };
  }
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
      try {
        await execFileAsync('command', ['-v', bin], { shell: '/bin/sh' });
        found.push(bin);
      } catch {
        // not installed
      }
    }
    return { clis: found };
  },
);

log.info('shell worker registered');
