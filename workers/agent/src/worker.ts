import { registerWorker, Logger } from 'iii-sdk';

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'agent' },
);
const log = new Logger();

process.on('unhandledRejection', (reason) => {
  log.error('agent unhandled rejection', { reason: String(reason) });
});

const SCOPE = 'agents';
const EVENTS_SCOPE = 'agent_events';

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

type AgentEvent = {
  ts: number;
  run_id: string;
  issue_id: string;
  agent_id: string;
  phase:
    | 'run_started'
    | 'thread_opened'
    | 'routing'
    | 'provider_call'
    | 'turn_saved'
    | 'thread_posted'
    | 'run_terminal'
    | 'run_cancelled';
  level?: 'info' | 'warn' | 'error';
  summary: string;
  detail?: string;
};

type CompleteResult = {
  ok: boolean;
  text: string;
  model: string;
  error?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost_usd?: number };
};

type RouterDecision = {
  model?: string;
  reason?: string;
  policy_id?: string;
};

const stateSet = (scope: string, key: string, value: unknown) =>
  iii.trigger({ function_id: 'state::set', payload: { scope, key, value } });

const stateGet = async <T>(scope: string, key: string): Promise<T | null> =>
  ((await iii.trigger({ function_id: 'state::get', payload: { scope, key } })) as T | null) ?? null;

async function emitEvent(event: AgentEvent): Promise<void> {
  await iii.trigger({ function_id: 'agent::event_emit', payload: event });
}

async function emitEventSafe(event: AgentEvent, context: string): Promise<void> {
  await emitEvent(event).catch((err) =>
    log.warn('agent event emit failed', {
      error: String(err),
      context,
      run_id: event.run_id,
      phase: event.phase,
    }),
  );
}

// Any model id whose prefix is one of these lands on provider-cli. Every
// other prefix resolves to provider-<prefix>. Echo is an inline test hook.
const CLI_PREFIXES = new Set([
  'claude-cli',
  'codex-cli',
  'opencode-cli',
  'openclaw-cli',
  'hermes-cli',
  'pi-cli',
  'gemini-cli',
  'cursor-agent-cli',
]);

function providerWorkerFor(model: string): string | 'echo' | 'cli' {
  const prefix = model.split('/')[0] ?? '';
  if (prefix === 'echo') return 'echo';
  if (CLI_PREFIXES.has(prefix)) return 'cli';
  return prefix;
}

async function complete(model: string, prompt: string): Promise<CompleteResult> {
  const kind = providerWorkerFor(model);
  if (kind === 'echo') {
    return { ok: true, text: `[echo] ${prompt.slice(0, 280)}`, model };
  }
  const fn = kind === 'cli' ? 'provider-cli::complete' : `provider-${kind}::complete`;
  return (await iii.trigger({ function_id: fn, payload: { model, prompt } })) as CompleteResult;
}

iii.registerFunction('agent::providers_detect', async (_input: { runtime_id?: string }) => {
  const r = (await iii.trigger({ function_id: 'shell::detect_clis', payload: {} })) as { clis: string[] };
  return { providers: r.clis };
});

iii.registerFunction('agent::event_emit', async (input: AgentEvent) => {
  const id = crypto.randomUUID().slice(0, 8);
  const key = `run_event:${input.run_id}:${input.ts}:${id}`;
  await stateSet(EVENTS_SCOPE, key, input);
  return { ok: true, key };
});

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
    await emitEvent({
      ts: Date.now(),
      run_id: runId,
      issue_id: input.issue_id,
      agent_id: input.agent_id,
      phase: 'run_started',
      level: 'info',
      summary: 'Run started',
      detail: `Agent ${agent.name} picked up issue ${input.issue_id.slice(0, 8)}`,
    });

    void executeRun(run, agent).catch(async (err) => {
      log.error('run failed', { run_id: runId, error: String(err) });
      const latest = await stateGet<Run>(SCOPE, `agent_run:${runId}`);
      if (latest?.status === 'cancelled') return;
      run.status = 'failed';
      run.ended_at = Date.now();
      await stateSet(SCOPE, `agent_run:${runId}`, run);
      await emitEventSafe({
        ts: Date.now(),
        run_id: runId,
        issue_id: run.issue_id,
        agent_id: run.agent_id,
        phase: 'run_terminal',
        level: 'error',
        summary: 'Run failed',
        detail: String(err),
      }, 'run-failure');
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
    await emitEvent({
      ts: Date.now(),
      run_id: run.id,
      issue_id: run.issue_id,
      agent_id: run.agent_id,
      phase: 'run_cancelled',
      level: 'warn',
      summary: 'Run cancelled',
      detail: 'Cancelled by user request',
    });
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
  await emitEvent({
    ts: Date.now(),
    run_id: run.id,
    issue_id: run.issue_id,
    agent_id: run.agent_id,
    phase: 'thread_opened',
    level: 'info',
    summary: 'Discussion thread opened',
    detail: `thread ${thread.thread_id.slice(0, 8)}`,
  });

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

  // router is unopinionated: policies + catalog live in runtime state. Falls
  // back to the agent's declared provider when no policy matches.
  let decision: RouterDecision | null = null;
  await emitEvent({
    ts: Date.now(),
    run_id: run.id,
    issue_id: run.issue_id,
    agent_id: run.agent_id,
    phase: 'routing',
    level: 'info',
    summary: 'Routing model for task',
  });
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
    })) as RouterDecision;
  } catch (err) {
    log.warn('router::decide skipped', { error: String(err) });
  }

  const model = decision?.model || `${agent.provider}/default`;
  await emitEvent({
    ts: Date.now(),
    run_id: run.id,
    issue_id: run.issue_id,
    agent_id: run.agent_id,
    phase: 'routing',
    level: 'info',
    summary: 'Model selected',
    detail: `${model}${decision?.reason ? ` (${decision.reason})` : ''}`,
  });
  const turnStart = Date.now();
  await emitEvent({
    ts: Date.now(),
    run_id: run.id,
    issue_id: run.issue_id,
    agent_id: run.agent_id,
    phase: 'provider_call',
    level: 'info',
    summary: 'Calling provider',
    detail: model,
  });
  const result = await complete(model, prompt).catch(
    (err): CompleteResult => ({ ok: false, text: '', model, error: String(err) }),
  );
  await emitEvent({
    ts: Date.now(),
    run_id: run.id,
    issue_id: run.issue_id,
    agent_id: run.agent_id,
    phase: 'provider_call',
    level: result.ok ? 'info' : 'error',
    summary: result.ok ? 'Provider responded' : 'Provider call failed',
    detail: result.ok ? `${Date.now() - turnStart}ms` : (result.error ?? 'unknown error'),
  });

  const answer = result.ok ? result.text : `[provider error] ${result.error ?? 'unknown'}`;

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
    tokens_in: result.usage?.prompt_tokens ?? 0,
    tokens_out: result.usage?.completion_tokens ?? 0,
    cost_usd: result.usage?.cost_usd ?? 0,
    ms: Date.now() - turnStart,
  };
  run.turns.push(turn);
  run.budget_used_usd += turn.cost_usd;
  await stateSet(SCOPE, `agent_run:${run.id}`, run);
  await emitEventSafe({
    ts: Date.now(),
    run_id: run.id,
    issue_id: run.issue_id,
    agent_id: run.agent_id,
    phase: 'turn_saved',
    level: 'info',
    summary: 'Turn saved',
    detail: `#${turn.n} ${turn.role} · ${turn.ms}ms`,
  }, 'turn-saved');

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
  await emitEventSafe({
    ts: Date.now(),
    run_id: run.id,
    issue_id: run.issue_id,
    agent_id: run.agent_id,
    phase: 'thread_posted',
    level: 'info',
    summary: 'Posted agent response',
    detail: `thread ${thread.thread_id.slice(0, 8)}`,
  }, 'thread-posted');

  // Re-read before writing the terminal state so a concurrent cancel isn't
  // overwritten. Provider failures end as 'failed', success as 'completed'.
  const latest = await stateGet<Run>(SCOPE, `agent_run:${run.id}`);
  if (latest?.status === 'cancelled') return;
  run.status = result.ok ? 'completed' : 'failed';
  run.ended_at = Date.now();
  await stateSet(SCOPE, `agent_run:${run.id}`, run);
  await emitEventSafe({
    ts: Date.now(),
    run_id: run.id,
    issue_id: run.issue_id,
    agent_id: run.agent_id,
    phase: 'run_terminal',
    level: result.ok ? 'info' : 'error',
    summary: result.ok ? 'Run completed' : 'Run failed',
    detail: result.ok ? 'Result ready for review' : (result.error ?? 'provider returned error'),
  }, 'run-terminal');
}

log.info('agent worker registered');
