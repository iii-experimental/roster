import { registerWorker, Logger } from 'iii-sdk';

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'roster-orchestrator' },
);
const log = new Logger();

const UI_SCOPE = 'roster';
const AGENTS_SCOPE = 'agents';

type Op = { fn: string; payload: Record<string, unknown> };
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
  created_at: number;
  updated_at: number;
};
type Runtime = {
  id: string;
  host: string;
  os: string;
  arch: string;
  clis_available: string[];
  last_heartbeat: number;
  status: string;
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
type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
type Run = {
  id: string;
  agent_id: string;
  issue_id: string;
  started_at: number;
  ended_at?: number;
  status: RunStatus;
  turns: Turn[];
  budget_used_usd: number;
};

const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

const generations = new Map<string, number>();

async function publishKey(key: string, ops: Op[]) {
  const gen = (generations.get(key) ?? 0) + 1;
  generations.set(key, gen);
  await iii.trigger({
    function_id: 'state::set',
    payload: { scope: UI_SCOPE, key, value: { generation: gen, ops, ts: Date.now() } },
  });
}

const publishView = (
  view: 'board' | 'agents' | 'runtimes' | 'settings' | 'runs',
  ops: Op[],
) => publishKey(`ui::${view}`, ops);

async function listScope<T>(scope: string, prefix: string): Promise<T[]> {
  const v = await iii.trigger({ function_id: 'state::list', payload: { scope, prefix } });
  return Array.isArray(v) ? (v as T[]) : [];
}

async function stateGet<T>(scope: string, key: string): Promise<T | null> {
  return ((await iii.trigger({ function_id: 'state::get', payload: { scope, key } })) as T | null) ?? null;
}

const listIssues = () => listScope<Issue>('issues', 'issue:');
const listRuntimes = () => listScope<Runtime>('runtimes', 'runtime:');
const listRuns = () => listScope<Run>(AGENTS_SCOPE, 'agent_run:');
const getIssue = (id: string) => stateGet<Issue>('issues', `issue:${id}`);
const getRun = (id: string) => stateGet<Run>(AGENTS_SCOPE, `agent_run:${id}`);

// Map each issue to its most recent run_id, so board cards can link to the
// live run-detail view. Older runs for the same issue are silently dropped.
function issueToLatestRun(runs: Run[]): Map<string, string> {
  const out = new Map<string, string>();
  const latest = new Map<string, number>();
  for (const r of runs) {
    const prev = latest.get(r.issue_id) ?? -Infinity;
    if (r.started_at >= prev) {
      latest.set(r.issue_id, r.started_at);
      out.set(r.issue_id, r.id);
    }
  }
  return out;
}

// The UI only renders 5 columns today. `blocked` surfaces as a review card
// (needs attention), `abandoned` as a done card (terminal). Remapping here so
// no issue is silently dropped from the board regardless of status.
const STATUS_TO_COLUMN: Record<string, string> = {
  open: 'open',
  claimed: 'claimed',
  running: 'running',
  blocked: 'review',
  review: 'review',
  done: 'done',
  abandoned: 'done',
};

function buildBoardOps(issues: Issue[], issueRuns: Map<string, string>): Op[] {
  const columns: Record<string, Issue[]> = {
    open: [], claimed: [], running: [], review: [], done: [],
  };
  for (const i of issues) {
    const col = STATUS_TO_COLUMN[i.status];
    if (col && columns[col]) columns[col].push(i);
  }

  const ops: Op[] = [
    { fn: 'setTitle', payload: { title: 'roster · board' } },
    { fn: 'setText', payload: { id: 'viewTitle', text: 'Board' } },
    {
      fn: 'setText',
      payload: { id: 'viewStats', text: `${issues.length} issue${issues.length === 1 ? '' : 's'}` },
    },
  ];

  for (const [status, list] of Object.entries(columns)) {
    const cap = status.charAt(0).toUpperCase() + status.slice(1);
    ops.push({ fn: 'setText', payload: { id: `count${cap}`, text: String(list.length) } });
    ops.push({ fn: 'clearChildren', payload: { id: `col${cap}` } });
    for (const issue of list) {
      const cardId = `card-${issue.id}`;
      ops.push({
        fn: 'createElement',
        payload: {
          parentId: `col${cap}`,
          tag: 'div',
          id: cardId,
          className: 'card',
          dataset: { issueId: issue.id },
        },
      });
      ops.push({
        fn: 'createElement',
        payload: { parentId: cardId, tag: 'div', className: 'cardTitle', text: issue.title },
      });
      const metaId = `meta-${issue.id}`;
      ops.push({
        fn: 'createElement',
        payload: { parentId: cardId, tag: 'div', id: metaId, className: 'cardMeta' },
      });
      ops.push({
        fn: 'createElement',
        payload: { parentId: metaId, tag: 'span', text: issue.id.slice(0, 8) },
      });
      if (issue.assignee_id) {
        ops.push({
          fn: 'createElement',
          payload: { parentId: metaId, tag: 'span', className: 'pill', text: `@${issue.assignee_id.slice(0, 8)}` },
        });
      }
      const runId = issueRuns.get(issue.id);
      if (runId) {
        ops.push({
          fn: 'createElement',
          payload: {
            parentId: metaId,
            tag: 'a',
            className: 'cardLink mono',
            text: 'view run',
            attributes: { href: `/runs/${runId}`, 'data-run-id': runId },
          },
        });
      }
    }
  }

  return ops;
}

const STATUS_PILL_CLASS: Record<RunStatus, string> = {
  running: 'pill info',
  completed: 'pill ok',
  failed: 'pill err',
  cancelled: 'pill warn',
};

const MAX_TURN_CHARS = 800;

function truncate(s: string, limit = MAX_TURN_CHARS): { text: string; truncated: boolean } {
  if (s.length <= limit) return { text: s, truncated: false };
  return { text: `${s.slice(0, limit)}…`, truncated: true };
}

function buildRunOps(run: Run, issue: Issue | null): Op[] {
  const shortId = run.id.slice(0, 8);
  const startedIso = new Date(run.started_at).toISOString();
  const updatedTs = run.ended_at ?? Date.now();
  const updatedIso = new Date(updatedTs).toISOString();
  const issueTitle = issue?.title ?? run.issue_id;
  const statsLine =
    `agent ${run.agent_id.slice(0, 8)} · ` +
    `issue ${run.issue_id.slice(0, 8)} · ` +
    `status ${run.status} · ` +
    `started ${startedIso} · ` +
    `budget $${run.budget_used_usd.toFixed(4)}`;

  const ops: Op[] = [
    { fn: 'setTitle', payload: { title: `roster · run/${shortId}` } },
    { fn: 'setText', payload: { id: 'viewTitle', text: `run/${shortId}` } },
    { fn: 'setText', payload: { id: 'viewStats', text: statsLine } },
    { fn: 'clearChildren', payload: { id: 'runTurns' } },
  ];

  const headerId = `run-header-${run.id}`;
  ops.push({
    fn: 'createElement',
    payload: { parentId: 'runTurns', tag: 'div', id: headerId, className: 'card runHeader' },
  });
  ops.push({
    fn: 'createElement',
    payload: { parentId: headerId, tag: 'div', className: 'cardTitle', text: issueTitle },
  });
  const headerMetaId = `${headerId}-meta`;
  ops.push({
    fn: 'createElement',
    payload: { parentId: headerId, tag: 'div', id: headerMetaId, className: 'cardMeta' },
  });
  ops.push({
    fn: 'createElement',
    payload: { parentId: headerMetaId, tag: 'span', text: `run ${shortId}` },
  });
  ops.push({
    fn: 'createElement',
    payload: {
      parentId: headerMetaId,
      tag: 'span',
      className: STATUS_PILL_CLASS[run.status],
      text: run.status,
    },
  });
  ops.push({
    fn: 'createElement',
    payload: { parentId: headerMetaId, tag: 'span', text: `started ${startedIso}` },
  });
  ops.push({
    fn: 'createElement',
    payload: {
      parentId: headerMetaId,
      tag: 'span',
      className: 'mono',
      text: `$${run.budget_used_usd.toFixed(4)}`,
    },
  });

  for (const turn of run.turns) {
    const turnId = `turn-${run.id}-${turn.n}`;
    ops.push({
      fn: 'createElement',
      payload: {
        parentId: 'runTurns',
        tag: 'div',
        id: turnId,
        className: `turn role-${turn.role}`,
        dataset: { runId: run.id, turnN: String(turn.n) },
      },
    });
    const headId = `${turnId}-head`;
    ops.push({
      fn: 'createElement',
      payload: { parentId: turnId, tag: 'div', id: headId, className: 'turnHead mono' },
    });
    ops.push({
      fn: 'createElement',
      payload: { parentId: headId, tag: 'span', text: `#${turn.n} · ${turn.role}` },
    });
    ops.push({
      fn: 'createElement',
      payload: {
        parentId: headId,
        tag: 'span',
        text:
          `in:${turn.tokens_in} · out:${turn.tokens_out} · ` +
          `$${turn.cost_usd.toFixed(4)} · ${turn.ms}ms`,
      },
    });

    const raw = turn.content ?? '';
    const { text, truncated } = truncate(raw);
    const bodyPayload: Record<string, unknown> = {
      parentId: turnId,
      tag: 'div',
      className: 'turnBody sans',
      text,
    };
    if (truncated) {
      bodyPayload.dataset = { truncated: '1', fullLength: String(raw.length) };
    }
    ops.push({ fn: 'createElement', payload: bodyPayload });

    const calls = Array.isArray(turn.tool_calls) ? turn.tool_calls : [];
    if (calls.length > 0) {
      const toolsId = `${turnId}-tools`;
      ops.push({
        fn: 'createElement',
        payload: { parentId: turnId, tag: 'pre', id: toolsId, className: 'turnBody mono' },
      });
      ops.push({
        fn: 'appendText',
        payload: { id: toolsId, text: JSON.stringify(calls, null, 2) },
      });
    }
  }

  const statusLine =
    `status ${run.status} · ` +
    `${run.turns.length} turn${run.turns.length === 1 ? '' : 's'} · ` +
    `updated ${updatedIso}`;
  const statusId = `run-status-${run.id}`;
  ops.push({
    fn: 'createElement',
    payload: { parentId: 'runTurns', tag: 'div', id: statusId, className: 'runStatus mono' },
  });
  ops.push({
    fn: 'appendText',
    payload: { id: statusId, text: statusLine },
  });

  ops.push({
    fn: 'setText',
    payload: {
      id: 'runCost',
      text: `$${run.budget_used_usd.toFixed(4)}`,
    },
  });
  ops.push({
    fn: 'setStyle',
    payload: {
      id: 'budgetBar',
      name: 'width',
      value: run.status === 'running' ? '50%' : '100%',
    },
  });

  return ops;
}

function buildRuntimesOps(runtimes: Runtime[]): Op[] {
  const ops: Op[] = [
    { fn: 'setTitle', payload: { title: 'roster · runtimes' } },
    { fn: 'setText', payload: { id: 'viewTitle', text: 'Runtimes' } },
    {
      fn: 'setText',
      payload: { id: 'viewStats', text: `${runtimes.length} registered` },
    },
    { fn: 'clearChildren', payload: { id: 'runtimes' } },
  ];
  for (const rt of runtimes) {
    const id = `rt-${rt.id}`;
    ops.push({
      fn: 'createElement',
      payload: { parentId: 'runtimes', tag: 'div', id, className: 'card' },
    });
    ops.push({
      fn: 'createElement',
      payload: { parentId: id, tag: 'div', className: 'cardTitle', text: `${rt.host} · ${rt.os}/${rt.arch}` },
    });
    ops.push({
      fn: 'createElement',
      payload: {
        parentId: id,
        tag: 'div',
        className: 'cardMeta',
        text: `clis: ${rt.clis_available.join(', ') || '—'} · ${rt.status}`,
      },
    });
  }
  return ops;
}

async function renderBoard() {
  const [issues, runs] = await Promise.all([listIssues(), listRuns()]);
  await publishView('board', buildBoardOps(issues, issueToLatestRun(runs)));
}

async function renderRuntimes() {
  await publishView('runtimes', buildRuntimesOps(await listRuntimes()));
}

async function renderRunDetail(runId: string, runHint?: Run | null) {
  const run = runHint ?? (await getRun(runId));
  if (!run) {
    await publishKey(`ui::run::${runId}`, [
      { fn: 'setTitle', payload: { title: `roster · run/${runId.slice(0, 8)}` } },
      { fn: 'setText', payload: { id: 'viewTitle', text: `run/${runId.slice(0, 8)}` } },
      { fn: 'setText', payload: { id: 'viewStats', text: 'run not found' } },
      { fn: 'clearChildren', payload: { id: 'runTurns' } },
    ]);
    return;
  }
  const issue = await getIssue(run.issue_id).catch(() => null);
  await publishKey(`ui::run::${runId}`, buildRunOps(run, issue));
}

async function renderPlaceholder(view: string) {
  const label = view.charAt(0).toUpperCase() + view.slice(1);
  await publishView(view as 'agents' | 'runs' | 'settings', [
    { fn: 'setTitle', payload: { title: `roster · ${view}` } },
    { fn: 'setText', payload: { id: 'viewTitle', text: label } },
    { fn: 'setText', payload: { id: 'viewStats', text: '(placeholder view)' } },
    { fn: 'clearChildren', payload: { id: view } },
  ]);
}

iii.registerFunction(
  'roster-orchestrator::rehydrate',
  async (input: { tab_id?: string; view: string; run_id?: string }) => {
    switch (input.view) {
      case 'board':
        await renderBoard();
        break;
      case 'runtimes':
        await renderRuntimes();
        break;
      case 'run':
        if (input.run_id) await renderRunDetail(input.run_id);
        break;
      case 'agents':
      case 'settings':
      case 'runs':
        await renderPlaceholder(input.view);
        break;
      default:
        await renderPlaceholder(input.view);
        break;
    }
    return { ok: true };
  },
);

iii.registerFunction('roster-orchestrator::on_issue_change', async () => {
  await renderBoard();
  return { ok: true };
});

iii.registerFunction('roster-orchestrator::on_runtime_change', async () => {
  await renderRuntimes();
  return { ok: true };
});

// State-reaction on the agents scope. Fires on every agent_run:* write (and
// therefore every turn append, since turns live inside the run object). For
// each write, republish the run-detail snapshot at ui::run::<id>. The board
// also re-renders when a run transitions to terminal so the "view run" link
// is always present even when the issue row hasn't itself changed.
iii.registerFunction(
  'roster-orchestrator::on_agents_change',
  async (event: {
    key?: string;
    new_value?: Run | null;
    old_value?: Run | null;
  }) => {
    const key = event?.key ?? '';
    if (!key.startsWith('agent_run:')) return { skipped: 'not-a-run' };
    const run = event.new_value ?? null;
    if (!run) return { skipped: 'no-value' };
    const prev = event.old_value?.status;
    const becameTerminal =
      TERMINAL_RUN_STATUSES.includes(run.status) && run.status !== prev;
    await Promise.all([
      renderRunDetail(run.id, run),
      becameTerminal
        ? renderBoard().catch((err) => log.warn('board refresh failed', { error: String(err) }))
        : Promise.resolve(),
    ]);
    return { ok: true, run_id: run.id };
  },
);

iii.registerTrigger({
  type: 'state',
  function_id: 'roster-orchestrator::on_issue_change',
  config: { scope: 'issues' },
});

iii.registerTrigger({
  type: 'state',
  function_id: 'roster-orchestrator::on_runtime_change',
  config: { scope: 'runtimes' },
});

iii.registerTrigger({
  type: 'state',
  function_id: 'roster-orchestrator::on_agents_change',
  config: { scope: AGENTS_SCOPE },
});

(async () => {
  await renderBoard();
  await renderRuntimes();
  log.info('roster-orchestrator registered, initial snapshots published');
})();
