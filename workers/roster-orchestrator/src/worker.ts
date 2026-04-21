import { registerWorker, Logger } from 'iii-sdk';

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'roster-orchestrator' },
);
const log = new Logger();

const UI_SCOPE = 'roster';

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

const generations = new Map<string, number>();

async function publishView(view: 'board' | 'agents' | 'runtimes' | 'settings' | 'runs', ops: Op[]) {
  const key = `ui::${view}`;
  const gen = (generations.get(key) ?? 0) + 1;
  generations.set(key, gen);
  await iii.trigger({
    function_id: 'state::set',
    payload: { scope: UI_SCOPE, key, value: { generation: gen, ops, ts: Date.now() } },
  });
}

async function listScope<T>(scope: string, prefix: string): Promise<T[]> {
  const v = await iii.trigger({ function_id: 'state::list', payload: { scope, prefix } });
  return Array.isArray(v) ? (v as T[]) : [];
}

const listIssues = () => listScope<Issue>('issues', 'issue:');
const listRuntimes = () => listScope<Runtime>('runtimes', 'runtime:');

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

function buildBoardOps(issues: Issue[]): Op[] {
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
    }
  }

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
  await publishView('board', buildBoardOps(await listIssues()));
}

async function renderRuntimes() {
  await publishView('runtimes', buildRuntimesOps(await listRuntimes()));
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

iii.registerFunction('roster-orchestrator::rehydrate', async (input: { tab_id?: string; view: string }) => {
  switch (input.view) {
    case 'board':
      await renderBoard();
      break;
    case 'runtimes':
      await renderRuntimes();
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
});

iii.registerFunction('roster-orchestrator::on_issue_change', async () => {
  await renderBoard();
  return { ok: true };
});

iii.registerFunction('roster-orchestrator::on_runtime_change', async () => {
  await renderRuntimes();
  return { ok: true };
});

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

(async () => {
  await renderBoard();
  await renderRuntimes();
  log.info('roster-orchestrator registered, initial snapshots published');
})();
