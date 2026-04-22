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

  const statsText =
    issues.length === 0
      ? 'no tasks yet — click + New task to hand something to an agent'
      : `${issues.length} issue${issues.length === 1 ? '' : 's'}`;

  const ops: Op[] = [
    { fn: 'setTitle', payload: { title: 'roster · board' } },
    { fn: 'setText', payload: { id: 'viewTitle', text: 'Board' } },
    { fn: 'setText', payload: { id: 'viewStats', text: statsText } },
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
          attributes: { draggable: 'true' },
          dataset: { issueId: issue.id, status: issue.status },
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
      if (issue.status === 'open' || issue.status === 'claimed') {
        ops.push({
          fn: 'createElement',
          payload: {
            parentId: metaId,
            tag: 'a',
            className: 'cardLink mono',
            text: issue.status === 'open' ? 'assign →' : 'reassign',
            attributes: {
              href: '#',
              'data-action': 'assign',
              'data-issue-id': issue.id,
              'data-issue-title': issue.title,
            },
          },
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

const RUNTIME_STATUS_PILL: Record<string, string> = {
  online: 'pill ok',
  offline: 'pill warn',
  revoked: 'pill err',
};

function buildRuntimesOps(runtimes: Runtime[]): Op[] {
  const sorted = [...runtimes].sort((a, b) => {
    const rank = (s: string) => (s === 'online' ? 0 : s === 'offline' ? 1 : 2);
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    return (b.last_heartbeat ?? 0) - (a.last_heartbeat ?? 0);
  });
  const online = sorted.filter((r) => r.status === 'online').length;
  const offline = sorted.length - online;

  const ops: Op[] = [
    { fn: 'setTitle', payload: { title: 'roster · runtimes' } },
    { fn: 'setText', payload: { id: 'viewTitle', text: 'Runtimes' } },
    {
      fn: 'setText',
      payload: {
        id: 'viewStats',
        text: `${online} online · ${offline} offline · ${runtimes.length} total`,
      },
    },
    { fn: 'clearChildren', payload: { id: 'runtimes' } },
  ];
  if (runtimes.length === 0) {
    ops.push({
      fn: 'createElement',
      payload: { parentId: 'runtimes', tag: 'div', className: 'emptyState', text: 'No runtimes registered. Start the agent-daemon worker.' },
    });
    return ops;
  }
  for (const rt of sorted) {
    const id = `rt-${rt.id}`;
    ops.push({
      fn: 'createElement',
      payload: { parentId: 'runtimes', tag: 'div', id, className: `card${rt.status !== 'online' ? ' subtle' : ''}` },
    });
    const headerId = `${id}-header`;
    ops.push({
      fn: 'createElement',
      payload: { parentId: id, tag: 'div', id: headerId, className: 'agentHeader' },
    });
    ops.push({
      fn: 'createElement',
      payload: { parentId: headerId, tag: 'div', className: 'cardTitle', text: `${rt.host || 'libkrun-vm'} · ${rt.os}/${rt.arch}` },
    });
    ops.push({
      fn: 'createElement',
      payload: { parentId: headerId, tag: 'span', className: RUNTIME_STATUS_PILL[rt.status] ?? 'pill', text: rt.status },
    });

    const metaId = `${id}-meta`;
    ops.push({ fn: 'createElement', payload: { parentId: id, tag: 'div', id: metaId, className: 'cardMeta' } });
    ops.push({
      fn: 'createElement',
      payload: { parentId: metaId, tag: 'span', className: 'mono', text: rt.id.slice(0, 8) },
    });
    if (rt.clis_available?.length) {
      for (const cli of rt.clis_available) {
        ops.push({
          fn: 'createElement',
          payload: { parentId: metaId, tag: 'span', className: 'pill', text: cli },
        });
      }
    } else {
      ops.push({
        fn: 'createElement',
        payload: { parentId: metaId, tag: 'span', className: 'subtle', text: 'no CLIs detected' },
      });
    }
    if (rt.last_heartbeat) {
      const ago = Math.round((Date.now() - rt.last_heartbeat) / 1000);
      ops.push({
        fn: 'createElement',
        payload: { parentId: metaId, tag: 'span', className: 'mono subtle', text: `last seen ${ago}s ago` },
      });
    }
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

type Agent = {
  id: string;
  workspace_id: string;
  name: string;
  provider?: string;
  runtime_id?: string;
  capabilities?: string[];
};

async function listAgents(): Promise<Agent[]> {
  const items = await listScope<Agent>(AGENTS_SCOPE, 'agent:');
  return items
    .filter((a) => a && typeof a === 'object' && 'id' in a && 'name' in a)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const RUN_STATUS_PILL: Record<string, string> = {
  running: 'pill info',
  completed: 'pill ok',
  failed: 'pill err',
  cancelled: 'pill warn',
};

function buildAgentsOps(agents: Agent[], runs: Run[], issues: Issue[]): Op[] {
  // Group runs by agent, newest first. Pick up-to-3 recent per agent.
  const runsByAgent = new Map<string, Run[]>();
  for (const r of runs) {
    const arr = runsByAgent.get(r.agent_id) ?? [];
    arr.push(r);
    runsByAgent.set(r.agent_id, arr);
  }
  for (const arr of runsByAgent.values()) arr.sort((a, b) => b.started_at - a.started_at);
  const issueById = new Map(issues.map((i) => [i.id, i]));

  const activeAgents = agents.filter((a) => (runsByAgent.get(a.id) ?? []).some((r) => r.status === 'running')).length;

  const ops: Op[] = [
    { fn: 'setTitle', payload: { title: 'roster · agents' } },
    { fn: 'setText', payload: { id: 'viewTitle', text: 'Agents' } },
    {
      fn: 'setText',
      payload: {
        id: 'viewStats',
        text: `${agents.length} registered · ${activeAgents} running now`,
      },
    },
    { fn: 'clearChildren', payload: { id: 'agents' } },
  ];
  if (agents.length === 0) {
    ops.push({
      fn: 'createElement',
      payload: { parentId: 'agents', tag: 'div', className: 'emptyState', text: 'No agents yet. Register one with iii trigger agent::register.' },
    });
    return ops;
  }
  for (const a of agents) {
    const agentRuns = runsByAgent.get(a.id) ?? [];
    const activeRun = agentRuns.find((r) => r.status === 'running') ?? null;
    const recent = agentRuns.slice(0, 3);
    const totalSpend = agentRuns.reduce((acc, r) => acc + (r.budget_used_usd ?? 0), 0);
    const tokensTotal = agentRuns.reduce(
      (acc, r) =>
        acc + (r.turns?.reduce((t, x) => t + (x.tokens_in ?? 0) + (x.tokens_out ?? 0), 0) ?? 0),
      0,
    );

    const id = `agent-${a.id}`;
    ops.push({ fn: 'createElement', payload: { parentId: 'agents', tag: 'div', id, className: 'card agentCard' } });

    // Header: name + live indicator
    const headerId = `${id}-header`;
    ops.push({ fn: 'createElement', payload: { parentId: id, tag: 'div', id: headerId, className: 'agentHeader' } });
    ops.push({
      fn: 'createElement',
      payload: { parentId: headerId, tag: 'div', className: 'cardTitle', text: a.name },
    });
    if (activeRun) {
      ops.push({
        fn: 'createElement',
        payload: { parentId: headerId, tag: 'span', className: 'livePill', text: '● live' },
      });
    }

    // Meta row
    const metaId = `${id}-meta`;
    ops.push({ fn: 'createElement', payload: { parentId: id, tag: 'div', id: metaId, className: 'cardMeta' } });
    ops.push({ fn: 'createElement', payload: { parentId: metaId, tag: 'span', className: 'mono', text: a.id.slice(0, 8) } });
    if (a.provider) ops.push({ fn: 'createElement', payload: { parentId: metaId, tag: 'span', className: 'pill', text: a.provider } });
    if (a.capabilities?.length) {
      for (const c of a.capabilities) {
        ops.push({ fn: 'createElement', payload: { parentId: metaId, tag: 'span', className: 'pill', text: c } });
      }
    }
    if (a.runtime_id) {
      ops.push({ fn: 'createElement', payload: { parentId: metaId, tag: 'span', className: 'mono subtle', text: `runtime ${a.runtime_id.slice(0, 8)}` } });
    }

    // Current activity block
    if (activeRun) {
      const activeId = `${id}-active`;
      ops.push({
        fn: 'createElement',
        payload: { parentId: id, tag: 'div', id: activeId, className: 'agentActivity' },
      });
      const issue = issueById.get(activeRun.issue_id);
      const lastTurn = activeRun.turns?.[activeRun.turns.length - 1];
      const snippet = lastTurn?.content
        ? lastTurn.content.slice(0, 160) + (lastTurn.content.length > 160 ? '…' : '')
        : 'waiting for first turn…';
      ops.push({
        fn: 'createElement',
        payload: { parentId: activeId, tag: 'div', className: 'activityLine', text: `▸ working on: ${issue?.title ?? activeRun.issue_id.slice(0, 8)}` },
      });
      ops.push({
        fn: 'createElement',
        payload: { parentId: activeId, tag: 'div', className: 'activitySnippet', text: snippet },
      });
      const runMetaId = `${activeId}-meta`;
      ops.push({
        fn: 'createElement',
        payload: { parentId: activeId, tag: 'div', id: runMetaId, className: 'cardMeta' },
      });
      ops.push({
        fn: 'createElement',
        payload: { parentId: runMetaId, tag: 'span', className: 'mono', text: `${activeRun.turns?.length ?? 0} turn${activeRun.turns?.length === 1 ? '' : 's'}` },
      });
      ops.push({
        fn: 'createElement',
        payload: { parentId: runMetaId, tag: 'span', className: 'mono', text: `$${(activeRun.budget_used_usd ?? 0).toFixed(4)}` },
      });
      ops.push({
        fn: 'createElement',
        payload: {
          parentId: runMetaId,
          tag: 'a',
          className: 'cardLink mono',
          text: 'open run →',
          attributes: { href: `/runs/${activeRun.id}` },
        },
      });
    }

    // Recent runs (non-active)
    const historical = recent.filter((r) => r.id !== activeRun?.id).slice(0, 3);
    if (historical.length > 0) {
      const histId = `${id}-history`;
      ops.push({ fn: 'createElement', payload: { parentId: id, tag: 'div', id: histId, className: 'runHistory' } });
      ops.push({
        fn: 'createElement',
        payload: { parentId: histId, tag: 'div', className: 'uppercase-label', text: 'recent runs' },
      });
      for (const r of historical) {
        const rowId = `${histId}-${r.id}`;
        ops.push({
          fn: 'createElement',
          payload: { parentId: histId, tag: 'div', id: rowId, className: 'runRow' },
        });
        const issue = issueById.get(r.issue_id);
        const title = issue?.title ?? r.issue_id.slice(0, 8);
        ops.push({
          fn: 'createElement',
          payload: { parentId: rowId, tag: 'span', className: 'runRowTitle', text: title },
        });
        ops.push({
          fn: 'createElement',
          payload: { parentId: rowId, tag: 'span', className: RUN_STATUS_PILL[r.status] ?? 'pill', text: r.status },
        });
        ops.push({
          fn: 'createElement',
          payload: { parentId: rowId, tag: 'span', className: 'mono subtle', text: `$${(r.budget_used_usd ?? 0).toFixed(4)}` },
        });
        ops.push({
          fn: 'createElement',
          payload: {
            parentId: rowId,
            tag: 'a',
            className: 'cardLink mono',
            text: 'view',
            attributes: { href: `/runs/${r.id}` },
          },
        });
      }
    }

    // Totals footer
    if (agentRuns.length > 0) {
      const totalsId = `${id}-totals`;
      ops.push({ fn: 'createElement', payload: { parentId: id, tag: 'div', id: totalsId, className: 'agentTotals mono' } });
      ops.push({
        fn: 'createElement',
        payload: { parentId: totalsId, tag: 'span', text: `${agentRuns.length} run${agentRuns.length === 1 ? '' : 's'}` },
      });
      ops.push({
        fn: 'createElement',
        payload: { parentId: totalsId, tag: 'span', text: `$${totalSpend.toFixed(4)} total` },
      });
      ops.push({
        fn: 'createElement',
        payload: { parentId: totalsId, tag: 'span', text: `${tokensTotal.toLocaleString()} tokens` },
      });
    }
  }
  return ops;
}

async function renderAgents() {
  const [agents, runs, issues] = await Promise.all([listAgents(), listRuns(), listIssues()]);
  await publishView('agents', buildAgentsOps(agents, runs, issues));
}

function buildSettingsOps(): Op[] {
  const ops: Op[] = [
    { fn: 'setTitle', payload: { title: 'roster · settings' } },
    { fn: 'setText', payload: { id: 'viewTitle', text: 'Settings' } },
    { fn: 'setText', payload: { id: 'viewStats', text: 'workspace + budgets + autopilot' } },
    { fn: 'clearChildren', payload: { id: 'settings' } },
  ];
  const cards: Array<{ title: string; body: string; fn: string }> = [
    { title: 'Workspaces', body: 'Create + manage workspaces. RBAC grants + HMAC API keys.', fn: 'auth::workspace_create' },
    { title: 'Budgets', body: 'Daily / weekly / monthly spend caps. Alerts at threshold, forecast on rate.', fn: 'budget::list' },
    { title: 'Autopilot', body: 'Auto-triage open issues to agents by memory + label affinity. Off by default per workspace.', fn: 'autopilot::status' },
    { title: 'Guardrails', body: 'PII + key-leak + jailbreak detection on agent input/output.', fn: 'guardrails::classify' },
    { title: 'Memory', body: 'Skill storage + BM25 recall. Tag with skill / episodic.', fn: 'memory::list' },
  ];
  for (const c of cards) {
    const id = `setting-${c.title.toLowerCase()}`;
    ops.push({ fn: 'createElement', payload: { parentId: 'settings', tag: 'div', id, className: 'card' } });
    ops.push({ fn: 'createElement', payload: { parentId: id, tag: 'div', className: 'cardTitle', text: c.title } });
    ops.push({ fn: 'createElement', payload: { parentId: id, tag: 'div', className: 'cardMeta', text: c.body } });
    ops.push({ fn: 'createElement', payload: { parentId: id, tag: 'div', className: 'cardMeta mono', text: `iii trigger --function-id '${c.fn}'` } });
  }
  return ops;
}

async function renderSettings() {
  await publishView('settings', buildSettingsOps());
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
        await renderAgents();
        break;
      case 'settings':
        await renderSettings();
        break;
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
    new_value?: Run | Agent | null;
    old_value?: Run | Agent | null;
  }) => {
    const key = event?.key ?? '';
    // Agent registrations / updates — refresh the Agents view.
    if (key.startsWith('agent:')) {
      await renderAgents().catch((err) => log.warn('agents refresh failed', { error: String(err) }));
      return { ok: true, kind: 'agent' };
    }
    if (!key.startsWith('agent_run:')) return { skipped: 'not-a-run' };
    const run = (event.new_value as Run | null) ?? null;
    if (!run) return { skipped: 'no-value' };
    const prev = (event.old_value as Run | null)?.status;
    const becameTerminal =
      TERMINAL_RUN_STATUSES.includes(run.status) && run.status !== prev;
    await Promise.all([
      renderRunDetail(run.id, run),
      // Every run write (new turn, status change, cost tick) refreshes the
      // Agents view so its live activity snippet stays current.
      renderAgents().catch((err) => log.warn('agents refresh failed', { error: String(err) })),
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
  await Promise.all([renderBoard(), renderRuntimes()]);
  log.info('roster-orchestrator registered, initial snapshots published');
})();
