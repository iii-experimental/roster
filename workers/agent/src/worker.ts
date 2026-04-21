import 'dotenv/config';
import { registerWorker, Logger } from 'iii-sdk';
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';

// Fallback: dotenv/config reads ./.env relative to cwd. When the worker runs
// inside a microVM with the project mounted at /workspace, .env lives there.
// Try a few common locations so secrets reach the process regardless of cwd.
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
const MAX_ITERATIONS = 25;
const SUMMARIZE_THRESHOLD = 40;

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

async function stateSet(scope: string, key: string, value: unknown) {
  await iii.trigger({ function_id: 'state::set', payload: { scope, key, value } });
}

async function stateGet<T>(scope: string, key: string): Promise<T | null> {
  const v = (await iii.trigger({ function_id: 'state::get', payload: { scope, key } })) as T | null;
  return v ?? null;
}

async function callShell(payload: Record<string, unknown>): Promise<{
  stdout: string;
  stderr: string;
  code: number;
  elapsed_ms: number;
}> {
  return (await iii.trigger({
    function_id: 'shell::exec',
    payload,
  })) as { stdout: string; stderr: string; code: number; elapsed_ms: number };
}

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

  // Ask the registry-owned llm-router to pick a model for this request. Router
  // is unopinionated: catalog + policies come from runtime state, not hardcoded
  // in roster. If router is unavailable, fall back to the agent's declared
  // provider without blocking the run.
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
    })) as { model?: string; reason?: string; policy_id?: string };
  } catch (err) {
    log.warn('router::decide skipped', { error: String(err) });
  }

  // Convention: model ids carry provider as a prefix ("claude/opus", "echo/tiny").
  // When the router returns a model, use its provider half; otherwise fall back
  // to the agent's declared provider.
  const modelProvider =
    decision?.model && decision.model.includes('/')
      ? decision.model.split('/')[0]
      : agent.provider;
  const effectiveProvider = modelProvider ?? agent.provider;
  const turnStart = Date.now();
  const result = await callProvider(effectiveProvider, prompt, decision?.model).catch((err) => ({
    ok: false as const,
    error: String(err),
    stdout: '',
    stderr: String(err),
    code: -1,
  }));

  const answer = 'ok' in result && result.ok ? result.stdout : `[provider error] ${result.stderr}`;

  if (decision?.model) {
    iii
      .trigger({
        function_id: 'router::health_update',
        payload: {
          model: decision.model,
          available: 'ok' in result && result.ok,
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

async function callProvider(provider: string, prompt: string, model?: string): Promise<ProviderResult> {
  const providers: Record<string, (p: string, m?: string) => Promise<ProviderResult>> = {
    claude: claudeAdapter,
    codex: codexAdapter,
    opencode: opencodeAdapter,
    openrouter: openrouterAdapter,
    echo: echoAdapter,
  };
  const fn = providers[provider];
  if (!fn) throw new Error(`unknown provider: ${provider}`);
  return await fn(prompt, model);
}

async function openrouterAdapter(prompt: string, model?: string): Promise<ProviderResult> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return {
      ok: false,
      error: 'OPENROUTER_API_KEY not set',
      stdout: '',
      stderr: 'missing key',
      code: 1,
    };
  }
  // Model convention: router returns "openrouter/anthropic/claude-sonnet-4". Strip
  // the leading "openrouter/" to get the provider/model slug OpenRouter expects.
  const modelSlug = (model ?? 'openrouter/openai/gpt-4o-mini').replace(/^openrouter\//, '');
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
        model: modelSlug,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `http ${resp.status}`, stdout: '', stderr: text, code: resp.status };
    }
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_cost?: number };
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    return { ok: true, stdout: content, stderr: '', code: 0 };
  } catch (err) {
    return { ok: false, error: String(err), stdout: '', stderr: String(err), code: 1 };
  }
}

async function claudeAdapter(prompt: string): Promise<ProviderResult> {
  const which = (await iii.trigger({
    function_id: 'shell::which',
    payload: { bin: 'claude' },
  })) as { path: string | null };
  if (!which.path) {
    return { ok: false, error: 'claude CLI not found', stdout: '', stderr: 'not installed', code: 127 };
  }
  const res = await callShell({
    cmd: 'claude',
    args: ['--print', prompt],
    timeout_ms: 120_000,
  });
  return { ok: res.code === 0, stdout: res.stdout, stderr: res.stderr, code: res.code };
}

async function codexAdapter(prompt: string): Promise<ProviderResult> {
  const res = await callShell({
    cmd: 'codex',
    args: ['exec', prompt],
    timeout_ms: 120_000,
  });
  return { ok: res.code === 0, stdout: res.stdout, stderr: res.stderr, code: res.code };
}

async function opencodeAdapter(prompt: string): Promise<ProviderResult> {
  const res = await callShell({
    cmd: 'opencode',
    args: ['run', prompt],
    timeout_ms: 120_000,
  });
  return { ok: res.code === 0, stdout: res.stdout, stderr: res.stderr, code: res.code };
}

async function echoAdapter(prompt: string): Promise<ProviderResult> {
  return { ok: true, stdout: `[echo] ${prompt.slice(0, 280)}`, stderr: '', code: 0 };
}

log.info('agent worker registered', {
  max_iterations: MAX_ITERATIONS,
  summarize_threshold: SUMMARIZE_THRESHOLD,
});
