import { registerWorker, Logger } from 'iii-sdk';

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'provider-cli' },
);
const log = new Logger();

process.on('unhandledRejection', (reason) => {
  log.error('provider-cli unhandled rejection', { reason: String(reason) });
});

// Model ids are "<cli-bin>/<tag>" — e.g. "claude-cli/opus", "codex-cli/default".
// The tag is currently informational; the actual CLI + argv shape lives here.
const CLI_SHAPES: Record<string, { bin: string; args: (prompt: string) => string[] }> = {
  'claude-cli': { bin: 'claude', args: (p) => ['--print', p] },
  'codex-cli': { bin: 'codex', args: (p) => ['exec', p] },
  'opencode-cli': { bin: 'opencode', args: (p) => ['run', p] },
  'openclaw-cli': { bin: 'openclaw', args: (p) => ['run', p] },
  'hermes-cli': { bin: 'hermes', args: (p) => ['chat', p] },
  'pi-cli': { bin: 'pi', args: (p) => ['chat', p] },
  'gemini-cli': { bin: 'gemini', args: (p) => ['--prompt', p] },
  'cursor-agent-cli': { bin: 'cursor-agent', args: (p) => ['--print', p] },
};

type ShellResult = { stdout: string; stderr: string; code: number; elapsed_ms: number };

type CompleteInput = {
  model: string;
  prompt: string;
  timeout_ms?: number;
};

type CompleteResult = {
  ok: boolean;
  text: string;
  model: string;
  error?: string;
};

iii.registerFunction('provider-cli::complete', async (input: CompleteInput): Promise<CompleteResult> => {
  const prefix = input.model.split('/')[0];
  const shape = CLI_SHAPES[prefix];
  if (!shape) {
    return { ok: false, text: '', model: input.model, error: `unsupported cli provider: ${prefix}` };
  }

  const { path } = (await iii.trigger({
    function_id: 'shell::which',
    payload: { bin: shape.bin },
  })) as { path: string | null };
  if (!path) {
    return { ok: false, text: '', model: input.model, error: `${shape.bin} not installed` };
  }

  const res = (await iii.trigger({
    function_id: 'shell::exec',
    payload: { cmd: shape.bin, args: shape.args(input.prompt), timeout_ms: input.timeout_ms ?? 120_000 },
  })) as ShellResult;

  return res.code === 0
    ? { ok: true, text: res.stdout, model: input.model }
    : { ok: false, text: '', model: input.model, error: `exit ${res.code}: ${res.stderr}` };
});

iii.registerFunction('provider-cli::list_models', async () => {
  const out = [];
  for (const [tag, shape] of Object.entries(CLI_SHAPES)) {
    const { path } = (await iii.trigger({
      function_id: 'shell::which',
      payload: { bin: shape.bin },
    })) as { path: string | null };
    out.push({ id: `${tag}/default`, bin: shape.bin, installed: !!path });
  }
  return { models: out };
});

log.info('provider-cli worker registered', { supported: Object.keys(CLI_SHAPES) });
