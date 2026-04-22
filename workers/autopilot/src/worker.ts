import { registerWorker, Logger } from 'iii-sdk';
import {
  Agent,
  Issue,
  MatchBy,
  MemoryRecallResult,
  Runtime,
  RuntimesListResult,
  Suggestion,
  buildSuggestion,
  sortSuggestions,
} from './score.js';

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'autopilot' },
);
const log = new Logger();

const SCOPE = 'autopilot';
const AGENTS_SCOPE = 'agents';
const ONE_HOUR_MS = 3_600_000;

type Policy = {
  confidence_threshold: number;
  max_auto_assigns_per_hour: number;
  match_by: MatchBy[];
};

type Config = {
  workspace_id: string;
  enabled: boolean;
  policy: Policy;
  updated_at: number;
};

type AssignmentLogEntry = {
  issue_id: string;
  agent_id: string;
  confidence: number;
  reasons: string[];
  at: number;
};

const DEFAULT_POLICY: Policy = {
  confidence_threshold: 0.8,
  max_auto_assigns_per_hour: 10,
  match_by: ['labels', 'capabilities', 'memory'],
};

process.on('unhandledRejection', (reason) => {
  log.error('autopilot unhandled rejection', { reason: String(reason) });
});

const stateSet = (scope: string, key: string, value: unknown) =>
  iii.trigger({ function_id: 'state::set', payload: { scope, key, value } });

const stateGet = async <T>(scope: string, key: string): Promise<T | null> =>
  ((await iii.trigger({ function_id: 'state::get', payload: { scope, key } })) as T | null) ?? null;

const stateList = async <T>(scope: string, prefix: string): Promise<T[]> => {
  const v = await iii.trigger({ function_id: 'state::list', payload: { scope, prefix } });
  return Array.isArray(v) ? (v as T[]) : [];
};

function mergePolicy(partial?: Partial<Policy>): Policy {
  if (!partial) return { ...DEFAULT_POLICY, match_by: [...DEFAULT_POLICY.match_by] };
  return {
    confidence_threshold:
      typeof partial.confidence_threshold === 'number'
        ? partial.confidence_threshold
        : DEFAULT_POLICY.confidence_threshold,
    max_auto_assigns_per_hour:
      typeof partial.max_auto_assigns_per_hour === 'number'
        ? partial.max_auto_assigns_per_hour
        : DEFAULT_POLICY.max_auto_assigns_per_hour,
    match_by:
      Array.isArray(partial.match_by) && partial.match_by.length > 0
        ? [...partial.match_by]
        : [...DEFAULT_POLICY.match_by],
  };
}

async function loadConfig(workspace_id: string): Promise<Config | null> {
  return await stateGet<Config>(SCOPE, `config:${workspace_id}`);
}

async function listEnabledConfigs(): Promise<Config[]> {
  const all = await stateList<Config>(SCOPE, 'config:');
  return all.filter((c) => c?.enabled === true);
}

async function listAssignmentsWithin(workspace_id: string, sinceMs: number): Promise<AssignmentLogEntry[]> {
  const all = await stateList<AssignmentLogEntry>(SCOPE, `assignment_log:${workspace_id}:`);
  const cutoff = Date.now() - sinceMs;
  return all.filter((e) => typeof e?.at === 'number' && e.at > cutoff);
}

// Best-effort cross-worker calls. A missing worker (memory, runtimes) must not
// crash scoring — contribute 0 for that component and move on.
async function safeTrigger<T>(function_id: string, payload: unknown): Promise<T | null> {
  try {
    return (await iii.trigger({ function_id, payload })) as T;
  } catch (err) {
    log.warn('cross-worker trigger failed', { function_id, error: String(err) });
    return null;
  }
}

async function fetchIssue(issue_id: string): Promise<Issue | null> {
  const res = await safeTrigger<{ issue: Issue | null }>('issues::get', { issue_id });
  return res?.issue ?? null;
}

async function fetchAgentsForWorkspace(workspace_id: string): Promise<Agent[]> {
  const all = await stateList<Agent>(AGENTS_SCOPE, 'agent:');
  return all.filter((a) => a?.workspace_id === workspace_id);
}

async function fetchRuntimes(): Promise<Runtime[]> {
  const res = await safeTrigger<RuntimesListResult>('runtimes::list', {});
  return res?.runtimes ?? [];
}

async function fetchMemoryRecall(agent: Agent, issue: Issue): Promise<MemoryRecallResult | null> {
  return await safeTrigger<MemoryRecallResult>('memory::recall', {
    workspace_id: issue.workspace_id,
    query: `${issue.title}\n${issue.body}`,
    k: 5,
    tags: [`agent:${agent.id}`],
  });
}

async function scoreIssue(
  issue: Issue,
  policy: Policy,
  agents: Agent[],
  runtimes: Runtime[],
): Promise<Suggestion[]> {
  if (agents.length === 0) return [];
  const useMemory = policy.match_by.includes('memory');
  const suggestions = await Promise.all(
    agents.map(async (agent) => {
      const memoryRecall = useMemory ? await fetchMemoryRecall(agent, issue) : null;
      return buildSuggestion({ agent, issue, memoryRecall, runtimes, matchBy: policy.match_by });
    }),
  );
  return sortSuggestions(suggestions);
}

iii.registerFunction(
  'autopilot::enable',
  async (input: { workspace_id: string; policy?: Partial<Policy> }) => {
    if (!input?.workspace_id) throw new Error('workspace_id required');
    const existing = await loadConfig(input.workspace_id);
    const policy = mergePolicy({ ...existing?.policy, ...input.policy });
    const config: Config = {
      workspace_id: input.workspace_id,
      enabled: true,
      policy,
      updated_at: Date.now(),
    };
    await stateSet(SCOPE, `config:${input.workspace_id}`, config);
    log.info('autopilot enabled', { workspace_id: input.workspace_id, policy });
    return { ok: true };
  },
);

iii.registerFunction('autopilot::disable', async (input: { workspace_id: string }) => {
  if (!input?.workspace_id) throw new Error('workspace_id required');
  const existing = await loadConfig(input.workspace_id);
  const config: Config = {
    workspace_id: input.workspace_id,
    enabled: false,
    policy: existing?.policy ?? mergePolicy(),
    updated_at: Date.now(),
  };
  await stateSet(SCOPE, `config:${input.workspace_id}`, config);
  log.info('autopilot disabled', { workspace_id: input.workspace_id });
  return { ok: true };
});

// Pure read: safe to call regardless of enabled state. Never writes anything.
iii.registerFunction('autopilot::suggest', async (input: { issue_id: string }) => {
  if (!input?.issue_id) throw new Error('issue_id required');
  const issue = await fetchIssue(input.issue_id);
  if (!issue) return { suggestions: [] };
  const config = await loadConfig(issue.workspace_id);
  const policy = config?.policy ?? mergePolicy();
  const [agents, runtimes] = await Promise.all([
    fetchAgentsForWorkspace(issue.workspace_id),
    fetchRuntimes(),
  ]);
  const suggestions = await scoreIssue(issue, policy, agents, runtimes);
  return { suggestions };
});

iii.registerFunction('autopilot::status', async (input: { workspace_id: string }) => {
  if (!input?.workspace_id) throw new Error('workspace_id required');
  const config = await loadConfig(input.workspace_id);
  const policy = config?.policy ?? mergePolicy();
  const recent = await listAssignmentsWithin(input.workspace_id, ONE_HOUR_MS);
  recent.sort((a, b) => b.at - a.at);
  return {
    enabled: config?.enabled === true,
    policy,
    recent_assignments: recent.map((e) => ({
      issue_id: e.issue_id,
      agent_id: e.agent_id,
      confidence: e.confidence,
      at: e.at,
    })),
    rate: {
      hour_count: recent.length,
      remaining: Math.max(0, policy.max_auto_assigns_per_hour - recent.length),
    },
  };
});

async function runForWorkspace(config: Config): Promise<{ considered: number; assigned: number; skipped_rate: number }> {
  const policy = config.policy;
  const [issuesRes, agents, runtimes, recent] = await Promise.all([
    safeTrigger<{ issues: Issue[] }>('issues::list', {
      workspace_id: config.workspace_id,
      status: 'open',
    }),
    fetchAgentsForWorkspace(config.workspace_id),
    fetchRuntimes(),
    listAssignmentsWithin(config.workspace_id, ONE_HOUR_MS),
  ]);
  const issues = (issuesRes?.issues ?? []).filter((i) => !i.assignee_id);
  const agentById = new Map(agents.map((a) => [a.id, a]));
  let assigned = 0;
  let rateLimitedAt = -1;
  // Rate count is maintained locally after the initial fetch so a single cron
  // tick can't exceed the cap even with many candidate issues in one pass.
  let hourCount = recent.length;

  for (let idx = 0; idx < issues.length; idx++) {
    const issue = issues[idx]!;
    if (hourCount >= policy.max_auto_assigns_per_hour) {
      log.info('autopilot rate limit reached', {
        workspace_id: config.workspace_id,
        hour_count: hourCount,
        cap: policy.max_auto_assigns_per_hour,
      });
      rateLimitedAt = idx;
      break;
    }

    const suggestions = await scoreIssue(issue, policy, agents, runtimes);
    const top = suggestions[0];
    if (!top || top.confidence < policy.confidence_threshold) continue;

    const agent = agentById.get(top.agent_id);
    if (!agent?.runtime_id) {
      log.info('autopilot skip: agent has no runtime_id', { agent_id: top.agent_id });
      continue;
    }

    const assignRes = await safeTrigger<{ ok: boolean; error?: string }>('issues::assign', {
      issue_id: issue.id,
      agent_id: top.agent_id,
      runtime_id: agent.runtime_id,
    });
    if (!assignRes?.ok) {
      log.info('autopilot assign rejected', {
        issue_id: issue.id,
        reason: assignRes?.error ?? 'unknown',
      });
      continue;
    }

    const at = Date.now();
    const entry: AssignmentLogEntry = {
      issue_id: issue.id,
      agent_id: top.agent_id,
      confidence: top.confidence,
      reasons: top.reasons,
      at,
    };
    await stateSet(SCOPE, `assignment_log:${config.workspace_id}:${at}`, entry);
    assigned += 1;
    hourCount += 1;
    log.info('autopilot assigned', {
      workspace_id: config.workspace_id,
      issue_id: issue.id,
      agent_id: top.agent_id,
      confidence: top.confidence,
    });
  }

  const skipped_rate = rateLimitedAt >= 0 ? issues.length - rateLimitedAt : 0;
  return { considered: issues.length, assigned, skipped_rate };
}

iii.registerFunction('autopilot::run', async () => {
  const configs = await listEnabledConfigs();
  const results: Array<{ workspace_id: string; considered: number; assigned: number; skipped_rate: number }> = [];
  for (const config of configs) {
    try {
      const res = await runForWorkspace(config);
      results.push({ workspace_id: config.workspace_id, ...res });
    } catch (err) {
      log.warn('autopilot::run workspace failed', {
        workspace_id: config.workspace_id,
        error: String(err),
      });
    }
  }
  return { workspaces: results.length, results };
});

try {
  iii.registerTrigger({
    type: 'cron',
    function_id: 'autopilot::run',
    config: { schedule: '*/1 * * * *' },
  });
} catch (err) {
  log.warn('cron trigger failed', { error: String(err) });
}

log.info('autopilot worker registered');
