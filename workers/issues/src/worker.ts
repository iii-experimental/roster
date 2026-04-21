import { registerWorker, Logger } from 'iii-sdk';

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'issues' },
);
const log = new Logger();

const STATE_SCOPE = 'issues';

type Status = 'open' | 'claimed' | 'running' | 'blocked' | 'review' | 'done' | 'abandoned';

type Issue = {
  id: string;
  workspace_id: string;
  title: string;
  body: string;
  status: Status;
  labels: string[];
  assignee_id?: string;
  runtime_id?: string;
  creator_id: string;
  created_at: number;
  updated_at: number;
};

const now = () => Date.now();

async function stateSet(key: string, value: unknown) {
  await iii.trigger({
    function_id: 'state::set',
    payload: { scope: STATE_SCOPE, key, value },
  });
}

async function stateGet<T>(key: string): Promise<T | null> {
  const v = (await iii.trigger({
    function_id: 'state::get',
    payload: { scope: STATE_SCOPE, key },
  })) as T | null;
  return v ?? null;
}

async function stateList<T>(prefix: string): Promise<T[]> {
  const v = (await iii.trigger({
    function_id: 'state::list',
    payload: { scope: STATE_SCOPE, prefix },
  })) as { values?: T[] } | T[] | null;
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return v.values ?? [];
}

async function logStatus(issue_id: string, from: Status, to: Status, reason?: string) {
  const ts = now();
  await stateSet(`issue_status_log:${issue_id}:${ts}`, { issue_id, from, to, reason, ts });
}

iii.registerFunction(
  'issues::create',
  async (input: {
    workspace_id: string;
    title: string;
    body?: string;
    labels?: string[];
    creator_id?: string;
  }) => {
    const id = crypto.randomUUID();
    const issue: Issue = {
      id,
      workspace_id: input.workspace_id,
      title: input.title,
      body: input.body ?? '',
      status: 'open',
      labels: input.labels ?? [],
      creator_id: input.creator_id ?? 'user',
      created_at: now(),
      updated_at: now(),
    };
    await stateSet(`issue:${id}`, issue);
    log.info('issue created', { id, title: input.title });
    return { issue_id: id };
  },
);

iii.registerFunction(
  'issues::assign',
  async (input: { issue_id: string; agent_id: string; runtime_id: string }) => {
    const issue = await stateGet<Issue>(`issue:${input.issue_id}`);
    if (!issue) throw new Error(`issue not found: ${input.issue_id}`);
    const prev = issue.status;
    issue.assignee_id = input.agent_id;
    issue.runtime_id = input.runtime_id;
    issue.status = 'claimed';
    issue.updated_at = now();
    await stateSet(`issue:${input.issue_id}`, issue);
    await logStatus(input.issue_id, prev, 'claimed');
    return { ok: true };
  },
);

iii.registerFunction(
  'issues::status_set',
  async (input: { issue_id: string; status: Status; reason?: string }) => {
    const issue = await stateGet<Issue>(`issue:${input.issue_id}`);
    if (!issue) throw new Error(`issue not found: ${input.issue_id}`);
    const prev = issue.status;
    issue.status = input.status;
    issue.updated_at = now();
    await stateSet(`issue:${input.issue_id}`, issue);
    await logStatus(input.issue_id, prev, input.status, input.reason);
    return { ok: true, prev, next: input.status };
  },
);

iii.registerFunction(
  'issues::list',
  async (input: { workspace_id?: string; status?: Status; assignee_id?: string }) => {
    const all = await stateList<Issue>('issue:');
    const filtered = all.filter((i) => {
      if (input.workspace_id && i.workspace_id !== input.workspace_id) return false;
      if (input.status && i.status !== input.status) return false;
      if (input.assignee_id && i.assignee_id !== input.assignee_id) return false;
      return true;
    });
    return { issues: filtered };
  },
);

iii.registerFunction('issues::get', async (input: { issue_id: string }) => {
  const issue = await stateGet<Issue>(`issue:${input.issue_id}`);
  return { issue };
});

iii.registerFunction(
  'issues::close',
  async (input: { issue_id: string; reason?: string }) => {
    return await iii.trigger({
      function_id: 'issues::status_set',
      payload: { issue_id: input.issue_id, status: 'done', reason: input.reason },
    });
  },
);

log.info('issues worker registered');
