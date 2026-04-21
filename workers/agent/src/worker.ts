import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { registerWorker, Logger } from 'iii-sdk';

// microVM mounts the project at /workspace; cwd inside the VM isn't always the
// workspace root, so try the common spots.
for (const p of ['.env', '/workspace/.env', '/workspace/../.env']) {
  if (existsSync(p)) dotenvConfig({ path: p, override: false });
}

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'agent' },
);
const log = new Logger();

process.on('unhandledRejection', (reason) => {
  log.error('agent unhandled rejection', { reason: String(reason) });
});

const SCOPE = 'agents';

type AgentDef = {
  id: string;
  name: string;
  provider: string;
  runtime_id?: string;
  capabilities: string[];
  model_policy?: string;
  budget_id?: string;
  workspace_id: string;
  created_at: number;
};

type Turn = {
  n: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_calls?: unknown[];
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  ms: number;
};

type Run = {
  id: string;
  agent_id: string;
  issue_id: string;
  started_at: number;
  ended_at?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  turns: Turn[];
  budget_used_usd: number;
};

type ShellResult = { stdout: string; stderr: string; code: number; elapsed_ms: number };

const stateSet = (scope: string, key: string, value: unknown) =>
  iii.trigger({ function_id: 'state::set', payload: { scope, key, value } });

const stateGet = async <T>(scope: string, key: string): Promise<T | null> =>
  ((await iii.trigger({ function_id: 'state::get', payload: { scope, key } })) as T | null) ?? null;

const callShell = (payload: Record<string, unknown>) =>
  iii.trigger({ function_id: 'shell::exec', payload }) as Promise<ShellResult>;

iii.registerFunction(
  'agent::providers_detect',
  async (_input: { runtime_id?: string }) => {
    const r = (await iii.trigger({
      function_id: 'shell::detect_clis',
      payload: {},
    })) as { clis: string[] };
    return { providers: r.clis };
  },
);

iii.registerFunction(
  'agent::register',
  async (input: {
    workspace_id: string;
    name: string;
    provider: string;
    runtime_id?: string;
    capabilities?: string[];
    model_policy?: string;
    budget_id?: string;
  }) => {
    const id = crypto.randomUUID();
    const def: AgentDef = {
      id,
      name: input.name,
      provider: input.provider,
      runtime_id: input.runtime_id,
      capabilities: input.capabilities ?? [],
      model_policy: input.model_policy,
      budget_id: input.budget_id,
      workspace_id: input.workspace_id,
      created_at: Date.now(),
    };
    await stateSet(SCOPE, `agent:${id}`, def);
    log.info('agent registered', { id, name: input.name, provider: input.provider });
    return { agent_id: id };
  },
);

iii.registerFunction(
  'agent::run_start',
  async (input: { agent_id: string; issue_id: string }) => {
    const agent = await stateGet<AgentDef>(SCOPE, `agent:${input.agent_id}`);
    if (!agent) throw new Error(`agent not found: ${input.agent_id}`);

    const runId = crypto.randomUUID();
    const run: Run = {
      id: runId,
      agent_id: input.agent_id,
      issue_id: input.issue_id,
      started_at: Date.now(),
      status: 'running',
      turns: [],
      budget_used_usd: 0,
    };
    await stateSet(SCOPE, `agent_run:${runId}`, run);

    void executeRun(run, agent).catch(async (err) => {
      run.status = 'failed';
      run.ended_at = Date.now();
      await stateSet(SCOPE, `agent_run:${runId}`, run);
      log.error('run failed', { run_id: runId, error: String(err) });
    });

    return { run_id: runId };
  },
);

iii.registerFunction('agent::run_status', async (input: { run_id: string }) => {
  return { run: await stateGet<Run>(SCOPE, `agent_run:${input.run_id}`) };
});

iii.registerFunction('agent::run_cancel', async (input: { run_id: string }) => {
  const run = await stateGet<Run>(SCOPE, `agent_run:${input.run_id}`);
  if (!run) throw new Error(`run not found: ${input.run_id}`);
  if (run.status === 'running') {
    run.status = 'cancelled';
    run.ended_at = Date.now();
    await stateSet(SCOPE, `agent_run:${input.run_id}`, run);
  }
  return { ok: true, status: run.status };
});

async function executeRun(run: Run, agent: AgentDef) {
  const issue = (await iii.trigger({
    function_id: 'issues::get',
    payload: { issue_id: run.issue_id },
  })) as { issue: { id: string; title: string; body: string; workspace_id: string } | null };
  if (!issue?.issue) throw new Error(`issue missing: ${run.issue_id}`);

  const thread = (await iii.trigger({
    function_id: 'thread::open',
    payload: { parent_type: 'agent_run', parent_id: run.id },
  })) as { thread_id: string };

  await iii.trigger({
    function_id: 'thread::system_msg',
    payload: {
      thread_id: thread.thread_id,
      body: `agent ${agent.name} (${agent.provider}) starting on issue ${issue.issue.title}`,
    },
  });

  const prompt =
    `You are an AI agent working on an issue.\n\n` +
    `Issue: ${issue.issue.title}\n\n${issue.issue.body}\n\n` +
    `Respond concisely with what you would do. No tool use in this phase.`;

  // router is unopinionated: policies + catalog live in runtime state. If it
  // isn't available, fall back to the agent's declared provider.
  let decision: { model?: string; reason?: string; policy_id?: string } | null = null;
  try {
    decision = (await iii.trigger({
      function_id: 'router::decide',
      payload: {
        tenant: agent.workspace_id,
        feature: 'roster.agent.run',
        user: agent.id,
        prompt,
        tags: [agent.provider, ...(agent.capabilities ?? [])],
      },
    })) as typeof decision;
  } catch (err) {
    log.warn('router::decide skipped', { error: String(err) });
  }

  // Model ids look like "<provider>/<slug>" (e.g. "echo/tiny", "openrouter/openai/gpt-4o-mini").
  const effectiveProvider = decision?.model?.split('/')[0] ?? agent.provider;
  const turnStart = Date.now();
  const result = await callProvider(effectiveProvider, prompt, decision?.model).catch(
    (err): ProviderResult => ({
      ok: false,
      error: String(err),
      stdout: '',
      stderr: String(err),
      code: -1,
    }),
  );

  const answer = result.ok ? result.stdout : `[provider error] ${result.stderr}`;

  if (decision?.model) {
    iii
      .trigger({
        function_id: 'router::health_update',
        payload: {
          model: decision.model,
          available: result.ok,
          latency_p99_ms: Date.now() - turnStart,
        },
      })
      .catch((err) => log.warn('router::health_update failed', { error: String(err) }));
  }

  const turn: Turn = {
    n: 1,
    role: 'assistant',
    content: answer,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    ms: Date.now() - turnStart,
  };
  run.turns.push(turn);
  await stateSet(SCOPE, `agent_run:${run.id}`, run);

  await iii.trigger({
    function_id: 'thread::post',
    payload: {
      thread_id: thread.thread_id,
      author_type: 'agent',
      author_id: agent.id,
      body: answer,
      markdown: true,
    },
  });

  run.status = 'completed';
  run.ended_at = Date.now();
  await stateSet(SCOPE, `agent_run:${run.id}`, run);
}

type ProviderResult =
  | { ok: true; stdout: string; stderr: string; code: number }
  | { ok: false; stdout: string; stderr: string; code: number; error: string };

type ProviderFn = (prompt: string, model?: string) => Promise<ProviderResult>;

// A CLI-backed provider just runs a binary via shell::exec. Each entry lists
// the bin and its argv factory for the single-prompt form.
const CLI_PROVIDERS: Record<string, { bin: string; args: (prompt: string) => string[] }> = {
  claude: { bin: 'claude', args: (p) => ['--print', p] },
  codex: { bin: 'codex', args: (p) => ['exec', p] },
  opencode: { bin: 'opencode', args: (p) => ['run', p] },
};

async function cliAdapter(bin: string, args: string[]): Promise<ProviderResult> {
  const { path } = (await iii.trigger({
    function_id: 'shell::which',
    payload: { bin },
  })) as { path: string | null };
  if (!path) {
    return { ok: false, error: `${bin} CLI not found`, stdout: '', stderr: 'not installed', code: 127 };
  }
  const res = await callShell({ cmd: bin, args, timeout_ms: 120_000 });
  return { ok: res.code === 0, stdout: res.stdout, stderr: res.stderr, code: res.code };
}

async function openrouterAdapter(prompt: string, model?: string): Promise<ProviderResult> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return { ok: false, error: 'OPENROUTER_API_KEY not set', stdout: '', stderr: 'missing key', code: 1 };
  }
  const slug = (model ?? 'openrouter/openai/gpt-4o-mini').replace(/^openrouter\//, '');
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/iii-experimental/roster',
        'X-Title': 'roster',
      },
      body: JSON.stringify({
        model: slug,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512,
      }),
    });
    if (!resp.ok) {
      return { ok: false, error: `http ${resp.status}`, stdout: '', stderr: await resp.text(), code: resp.status };
    }
    const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    return { ok: true, stdout: data.choices?.[0]?.message?.content ?? '', stderr: '', code: 0 };
  } catch (err) {
    return { ok: false, error: String(err), stdout: '', stderr: String(err), code: 1 };
  }
}

const PROVIDERS: Record<string, ProviderFn> = {
  openrouter: openrouterAdapter,
  echo: async (prompt) => ({ ok: true, stdout: `[echo] ${prompt.slice(0, 280)}`, stderr: '', code: 0 }),
  ...Object.fromEntries(
    Object.entries(CLI_PROVIDERS).map(
      ([name, { bin, args }]): [string, ProviderFn] => [name, (p) => cliAdapter(bin, args(p))],
    ),
  ),
};

async function callProvider(provider: string, prompt: string, model?: string): Promise<ProviderResult> {
  const fn = PROVIDERS[provider];
  if (!fn) throw new Error(`unknown provider: ${provider}`);
  return await fn(prompt, model);
}

log.info('agent worker registered', { providers: Object.keys(PROVIDERS) });
