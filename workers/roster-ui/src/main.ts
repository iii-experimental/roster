import { registerWorker } from 'iii-browser-sdk';
import './styles.css';

const III = (import.meta as any).env.VITE_III_URL ?? 'ws://localhost:49134';
const iii = registerWorker(III);

const tabId = crypto.randomUUID();
const PREFIX = `browser::tab::${tabId}`;
const DEFAULT_MAX_TURN_CHARS = 800;

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`element not found: ${id}`);
  return el;
};

type Op = { fn: string; payload: Record<string, unknown> };

const PRIMS: Record<string, (p: Record<string, unknown>) => void | Promise<void>> = {
  setText: (p) => {
    $(p.id as string).textContent = p.text as string;
  },
  appendText: (p) => {
    $(p.id as string).appendChild(document.createTextNode(p.text as string));
  },
  clearChildren: (p) => {
    $(p.id as string).replaceChildren();
  },
  createElement: (p) => {
    const el = document.createElement(p.tag as string);
    if (p.id) el.id = p.id as string;
    if (p.className) el.className = p.className as string;
    if (p.text != null) el.textContent = p.text as string;
    const attrs = p.attributes as Record<string, string> | undefined;
    if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    const data = p.dataset as Record<string, string> | undefined;
    if (data) for (const [k, v] of Object.entries(data)) el.dataset[k] = v;
    $(p.parentId as string).appendChild(el);
  },
  removeElement: (p) => {
    $(p.id as string).remove();
  },
  setAttribute: (p) => {
    $(p.id as string).setAttribute(p.name as string, p.value as string);
  },
  setProperty: (p) => {
    (($(p.id as string) as unknown) as Record<string, unknown>)[p.name as string] = p.value;
  },
  setStyle: (p) => {
    ($(p.id as string) as HTMLElement).style.setProperty(p.name as string, p.value as string);
  },
  setCssVariable: (p) => {
    document.documentElement.style.setProperty(p.name as string, p.value as string);
  },
  setTitle: (p) => {
    document.title = p.title as string;
  },
  setClass: (p) => {
    const el = $(p.id as string);
    const add = (p.add as string[]) ?? [];
    const remove = (p.remove as string[]) ?? [];
    for (const c of remove) el.classList.remove(c);
    for (const c of add) el.classList.add(c);
  },
  beep: async (p) => {
    const ctx = new AudioContext();
    await ctx.resume();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = (p.freq as number) ?? 660;
    g.gain.value = 0.05;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    window.setTimeout(() => {
      o.stop();
      void ctx.close();
    }, (p.ms as number) ?? 120);
  },
  toast: (p) => {
    const layer = $('toastLayer');
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const el = document.createElement('div');
    el.id = id;
    el.className = `toast ${(p.level as string) ?? 'info'}`;
    el.textContent = p.text as string;
    layer.appendChild(el);
    window.setTimeout(() => el.remove(), (p.ms as number) ?? 3500);
  },
};

for (const [fn, impl] of Object.entries(PRIMS)) {
  iii.registerFunction(`${PREFIX}::dom::${fn}`, async (p: Record<string, unknown>) => {
    await impl(p);
    return { ok: true };
  });
}

iii.registerFunction(
  `${PREFIX}::dom::getProperty`,
  async (p: { id: string; name: string }) => ({
    value: (($(p.id) as unknown) as Record<string, unknown>)[p.name],
  }),
);

// Track listeners per (element, event, trigger.function_id) so replays don't
// stack duplicates. Keyed on the element via WeakMap so we can't leak nodes.
const listeners = new WeakMap<Element, Map<string, EventListener>>();

iii.registerFunction(
  `${PREFIX}::dom::addEventListener`,
  async (p: {
    id: string;
    event: string;
    trigger: { function_id: string; payload?: Record<string, unknown> };
  }) => {
    const el = $(p.id);
    const key = `${p.event}::${p.trigger.function_id}`;
    const bucket = listeners.get(el) ?? new Map<string, EventListener>();
    const existing = bucket.get(key);
    if (existing) el.removeEventListener(p.event, existing);

    const listener: EventListener = (e) => {
      const target = e.target as
        | (HTMLInputElement & { checked?: boolean; value?: string; dataset: DOMStringMap })
        | null;
      const payload = {
        ...(p.trigger.payload ?? {}),
        ...(target && 'checked' in target ? { checked: target.checked } : {}),
        ...(target && 'value' in target ? { value: target.value } : {}),
        ...(target?.dataset ? { dataset: { ...target.dataset } } : {}),
      };
      void iii.trigger({ function_id: p.trigger.function_id, payload });
    };
    el.addEventListener(p.event, listener);
    bucket.set(key, listener);
    listeners.set(el, bucket);
    return { ok: true };
  },
);

iii.registerFunction(
  `${PREFIX}::ui::prompt_approval`,
  async (p: { title: string; body: string; tool_call?: unknown }) => {
    return new Promise<{ approved: boolean; reason?: string }>((resolve) => {
      const layer = $('modalLayer');
      const wrap = document.createElement('div');
      wrap.className = 'modalWrap';
      wrap.innerHTML = `
        <div class="modal">
          <h3 class="modalTitle"></h3>
          <p class="modalBody"></p>
          <pre class="modalPayload mono"></pre>
          <textarea class="modalReason" placeholder="Reason (optional)"></textarea>
          <div class="modalActions">
            <button class="btn deny">Deny</button>
            <button class="btn approve accent">Approve</button>
          </div>
        </div>`;
      (wrap.querySelector('.modalTitle') as HTMLElement).textContent = p.title;
      (wrap.querySelector('.modalBody') as HTMLElement).textContent = p.body;
      (wrap.querySelector('.modalPayload') as HTMLElement).textContent = JSON.stringify(
        p.tool_call ?? {},
        null,
        2,
      );
      const reason = wrap.querySelector('.modalReason') as HTMLTextAreaElement;
      (wrap.querySelector('.approve') as HTMLButtonElement).onclick = () => {
        wrap.remove();
        resolve({ approved: true, reason: reason.value || undefined });
      };
      (wrap.querySelector('.deny') as HTMLButtonElement).onclick = () => {
        wrap.remove();
        resolve({ approved: false, reason: reason.value || undefined });
      };
      layer.appendChild(wrap);
    });
  },
);

type Snapshot = { generation: number; ops: Op[] } | null;
type StateEvent = {
  new_value?: Snapshot;
  old_value?: Snapshot;
  key?: string;
  event_type?: string;
};

// Track the last generation applied per scope key so stale snapshots (arriving
// late due to network reorder or replay) don't clobber a newer state.
const appliedGenerations = new Map<string, number>();

iii.registerFunction(`${PREFIX}::ui::apply`, async (event: StateEvent | Snapshot) => {
  const snap: Snapshot =
    event && typeof event === 'object' && 'new_value' in event
      ? (event.new_value ?? null)
      : (event as Snapshot);
  if (!snap || !Array.isArray(snap.ops)) return { ok: true, applied: 0 };
  const scopeKey = event && typeof event === 'object' && 'key' in event
    ? (event.key ?? '') : '';
  // Engine subscriptions from previous views stay registered, so their
  // snapshots keep arriving after the user navigates away. Apply only ops
  // that target the currently active scope key — otherwise a stale
  // /runs/:id snapshot would clobber the board's shared DOM elements
  // (viewTitle, viewStats, runTurns).
  if (scopeKey && currentScope && scopeKey !== currentScope.key) {
    return { ok: true, applied: 0, skipped_inactive: true };
  }
  const gen = typeof snap.generation === 'number' ? snap.generation : 0;
  const last = appliedGenerations.get(scopeKey) ?? -1;
  if (gen <= last) return { ok: true, applied: 0, skipped_stale: true };
  appliedGenerations.set(scopeKey, gen);
  let applied = 0;
  for (const op of snap.ops) {
    const impl = PRIMS[op.fn];
    if (!impl) continue;
    try {
      await impl(op.payload);
      applied += 1;
    } catch {
      // idempotent best-effort; skip ops whose target nodes aren't mounted yet
    }
  }
  return { ok: true, applied };
});

type Route =
  | { view: 'board' | 'agents' | 'runtimes' | 'settings' }
  | { view: 'run'; runId: string };

// Plain pathname router. `/` → board, `/runs/:id` → run detail. Also tolerates
// hash-style legacy links (`#/board`) in case something still bookmarks them.
function parseLocation(): Route {
  const pathParts = location.pathname.split('/').filter(Boolean);
  if (pathParts[0] === 'runs' && pathParts[1]) {
    return { view: 'run', runId: pathParts[1] };
  }
  if (pathParts[0] && ['agents', 'runtimes', 'settings', 'board'].includes(pathParts[0])) {
    return { view: pathParts[0] as 'board' | 'agents' | 'runtimes' | 'settings' };
  }
  const hash = location.hash.replace(/^#\//, '').split('/')[0];
  if (hash === 'agents' || hash === 'runtimes' || hash === 'settings') {
    return { view: hash };
  }
  return { view: 'board' };
}

function scopeKeyFor(route: Route): string {
  return route.view === 'run' ? `ui::run::${route.runId}` : `ui::${route.view}`;
}

function viewElementId(route: Route): string {
  return route.view === 'run' ? 'runDetail' : route.view;
}

let currentScope: { scope: string; key: string } | null = null;
// Keys we've already asked the engine to subscribe us to. Re-registering the
// same trigger wastes work and duplicates state-reaction fan-out.
const registeredRosterKeys = new Set<string>();

function subscribeKey(key: string) {
  if (registeredRosterKeys.has(key)) return;
  iii.registerTrigger({
    type: 'state',
    function_id: `${PREFIX}::ui::apply`,
    config: { scope: 'roster', key },
  });
  registeredRosterKeys.add(key);
}

async function applyRoute(route: Route) {
  const key = scopeKeyFor(route);
  if (currentScope?.scope === 'roster' && currentScope.key === key) return;
  // Reset applied generations for the new scope so the incoming snapshot is
  // always applied even if its generation is lower than the previous view's.
  appliedGenerations.delete(key);
  currentScope = { scope: 'roster', key };
  subscribeKey(key);

  const rehydratePayload: Record<string, unknown> = { tab_id: tabId, view: route.view };
  if (route.view === 'run') rehydratePayload.run_id = route.runId;
  await iii.trigger({
    function_id: 'roster-orchestrator::rehydrate',
    payload: rehydratePayload,
  }).catch(() => {});

  for (const n of ['board', 'agents', 'runtimes', 'settings']) {
    const el = document.getElementById(`nav-${n}`);
    if (el) el.classList.toggle('active', route.view === n);
  }
  for (const v of document.querySelectorAll('.view')) v.classList.remove('active');
  const viewEl = document.getElementById(viewElementId(route));
  if (viewEl) viewEl.classList.add('active');

  const newTask = document.getElementById('btnNewTask') as HTMLButtonElement | null;
  const newAgent = document.getElementById('btnNewAgent') as HTMLButtonElement | null;
  if (newTask) newTask.hidden = route.view !== 'board';
  if (newAgent) newAgent.hidden = route.view !== 'agents';
}

function navigate(url: string) {
  if (url === location.pathname + location.search + location.hash) return;
  history.pushState(null, '', url);
  void applyRoute(parseLocation());
}

window.addEventListener('popstate', () => void applyRoute(parseLocation()));
window.addEventListener('hashchange', () => void applyRoute(parseLocation()));

// Intercept same-origin clicks on anchors that resolve to a route we own, so
// the board's "view run" link routes without a full page reload.
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const anchor = (e.target as Element | null)?.closest?.('a');
  if (!anchor) return;
  const href = anchor.getAttribute('href');
  if (!href || href.startsWith('http') || href.startsWith('mailto:')) return;
  if (anchor.target && anchor.target !== '' && anchor.target !== '_self') return;
  if (!href.startsWith('/')) return;
  e.preventDefault();
  navigate(href);
});

// Kanban drag + drop. Delegated at the board level so cards created later
// by ops pick up behavior without re-wiring. Drop target reads its column's
// data-status attribute; on drop we optimistically move the card DOM, then
// fire issues::status_set so the backend state change republishes the
// board snapshot (which reconciles). If the trigger fails, we restore the
// card to its origin column.
const boardEl = document.getElementById('board');
if (boardEl) {
  let draggingCard: HTMLElement | null = null;
  let originColumn: HTMLElement | null = null;

  boardEl.addEventListener('dragstart', (e) => {
    const card = (e.target as HTMLElement | null)?.closest?.('.card') as HTMLElement | null;
    if (!card || !card.dataset.issueId) return;
    draggingCard = card;
    originColumn = card.parentElement as HTMLElement | null;
    card.classList.add('dragging');
    e.dataTransfer?.setData('text/plain', card.dataset.issueId);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });

  boardEl.addEventListener('dragend', () => {
    draggingCard?.classList.remove('dragging');
    for (const c of boardEl.querySelectorAll('.column.dropTarget')) {
      c.classList.remove('dropTarget');
    }
    draggingCard = null;
    originColumn = null;
  });

  boardEl.addEventListener('dragover', (e) => {
    const column = (e.target as HTMLElement | null)?.closest?.('.column') as HTMLElement | null;
    if (!column) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    for (const c of boardEl.querySelectorAll('.column.dropTarget')) {
      if (c !== column) c.classList.remove('dropTarget');
    }
    column.classList.add('dropTarget');
  });

  boardEl.addEventListener('dragleave', (e) => {
    const column = (e.target as HTMLElement | null)?.closest?.('.column') as HTMLElement | null;
    if (!column) return;
    const related = e.relatedTarget as Node | null;
    if (related && column.contains(related)) return;
    column.classList.remove('dropTarget');
  });

  boardEl.addEventListener('drop', (e) => {
    const column = (e.target as HTMLElement | null)?.closest?.('.column') as HTMLElement | null;
    if (!column || !draggingCard) return;
    e.preventDefault();
    column.classList.remove('dropTarget');
    const issueId = draggingCard.dataset.issueId;
    const nextStatus = column.dataset.status;
    if (!issueId || !nextStatus) return;
    if (originColumn && originColumn === column) return;

    const body = column.querySelector('.columnBody');
    if (body) body.appendChild(draggingCard);

    const cardToRestore = draggingCard;
    const restoreTarget = originColumn;

    void iii
      .trigger({
        function_id: 'issues::status_set',
        payload: { issue_id: issueId, status: nextStatus },
      })
      .catch((err) => {
        const restoreBody = restoreTarget?.querySelector('.columnBody');
        if (restoreBody && cardToRestore) restoreBody.appendChild(cardToRestore);
        console.warn('[kanban] status_set failed', err);
      });
  });
}

type ToastLevel = 'info' | 'success' | 'warn' | 'error';
const showToast = (text: string, level: ToastLevel = 'info', ms = 3500) =>
  void PRIMS.toast({ text, level, ms });

function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/function_not_found|Function .* not found/i.test(raw)) {
    return `${raw} → check \`iii worker list\`, the backing worker is down`;
  }
  return raw;
}

type FormField = { name: string; label: string; type?: 'text' | 'textarea'; placeholder?: string; required?: boolean };

function openFormModal(opts: {
  title: string;
  body?: string;
  fields: FormField[];
  submitLabel: string;
  onSubmit: (values: Record<string, string>) => Promise<void>;
}) {
  const layer = $('modalLayer');
  const wrap = document.createElement('div');
  wrap.className = 'modalWrap';

  const form = document.createElement('form');
  form.className = 'modal';
  form.noValidate = true;

  const titleEl = document.createElement('h3');
  titleEl.className = 'modalTitle';
  titleEl.textContent = opts.title;
  form.appendChild(titleEl);

  if (opts.body) {
    const bodyEl = document.createElement('p');
    bodyEl.className = 'modalBody';
    bodyEl.textContent = opts.body;
    form.appendChild(bodyEl);
  }

  for (const f of opts.fields) {
    const fieldWrap = document.createElement('div');
    fieldWrap.className = 'modalField';
    const label = document.createElement('label');
    label.className = 'modalLabel';
    label.textContent = f.label;
    fieldWrap.appendChild(label);
    const ctl = f.type === 'textarea'
      ? document.createElement('textarea')
      : document.createElement('input');
    ctl.className = f.type === 'textarea' ? 'modalTextarea' : 'modalInput';
    ctl.name = f.name;
    if (f.placeholder) ctl.placeholder = f.placeholder;
    if (f.required) ctl.required = true;
    if (f.type !== 'textarea') (ctl as HTMLInputElement).type = 'text';
    fieldWrap.appendChild(ctl);
    form.appendChild(fieldWrap);
  }

  const actions = document.createElement('div');
  actions.className = 'modalActions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn cancelBtn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => wrap.remove();
  actions.appendChild(cancelBtn);
  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn accent submitBtn';
  submitBtn.textContent = opts.submitLabel;
  actions.appendChild(submitBtn);
  form.appendChild(actions);

  wrap.appendChild(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const values: Record<string, string> = {};
    for (const f of opts.fields) values[f.name] = String(data.get(f.name) ?? '').trim();
    const missing = opts.fields.find((f) => f.required && !values[f.name]);
    if (missing) {
      showToast(`${missing.label} is required`, 'warn');
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Working…';
    try {
      await opts.onSubmit(values);
      wrap.remove();
    } catch (err) {
      showToast(`Failed: ${describeError(err)}`, 'error', 5000);
      submitBtn.disabled = false;
      submitBtn.textContent = opts.submitLabel;
    }
  });
  layer.appendChild(wrap);
  const firstInput = form.querySelector('input, textarea') as HTMLElement | null;
  firstInput?.focus();
}

type AgentRef = { id: string; name: string; provider?: string; runtime_id?: string };
type RuntimeRef = { id: string; host: string; os: string; arch: string; status: string; clis_available?: string[] };

async function stateList<T>(scope: string, prefix: string): Promise<T[]> {
  const v = await iii.trigger({ function_id: 'state::list', payload: { scope, prefix } });
  return Array.isArray(v) ? (v as T[]) : [];
}

function openAssignModal(issueId: string, issueTitle: string) {
  const layer = $('modalLayer');
  const wrap = document.createElement('div');
  wrap.className = 'modalWrap';
  wrap.innerHTML = `
    <form class="modal" novalidate>
      <h3 class="modalTitle">Assign task</h3>
      <p class="modalBody"></p>
      <div class="modalField">
        <label class="modalLabel">Agent</label>
        <select class="modalSelect" name="agent_id" required>
          <option value="">loading…</option>
        </select>
      </div>
      <div class="modalField">
        <label class="modalLabel">Runtime</label>
        <select class="modalSelect" name="runtime_id" required>
          <option value="">loading…</option>
        </select>
      </div>
      <div class="modalActions">
        <button type="button" class="btn cancelBtn">Cancel</button>
        <button type="submit" class="btn accent submitBtn">Hand over</button>
      </div>
    </form>`;
  (wrap.querySelector('.modalBody') as HTMLElement).textContent = `"${issueTitle}"`;
  const form = wrap.querySelector('form') as HTMLFormElement;
  const agentSel = form.querySelector('select[name="agent_id"]') as HTMLSelectElement;
  const runtimeSel = form.querySelector('select[name="runtime_id"]') as HTMLSelectElement;
  const submitBtn = form.querySelector('.submitBtn') as HTMLButtonElement;
  (form.querySelector('.cancelBtn') as HTMLButtonElement).onclick = () => wrap.remove();

  layer.appendChild(wrap);

  let loadedAgents: AgentRef[] = [];

  void (async () => {
    try {
      const [agents, runtimes] = await Promise.all([
        stateList<AgentRef>('agents', 'agent:'),
        stateList<RuntimeRef>('runtimes', 'runtime:'),
      ]);
      loadedAgents = agents;
      agentSel.innerHTML = '';
      if (agents.length === 0) {
        agentSel.innerHTML = '<option value="">no agents registered — register one first</option>';
        agentSel.disabled = true;
      } else {
        for (const a of agents) {
          const opt = document.createElement('option');
          opt.value = a.id;
          opt.textContent = `${a.name}${a.provider ? ` (${a.provider})` : ''} · ${a.id.slice(0, 8)}`;
          agentSel.appendChild(opt);
        }
      }
      runtimeSel.innerHTML = '';
      const online = runtimes.filter((r) => r.status === 'online');
      if (online.length === 0) {
        runtimeSel.innerHTML = '<option value="">no online runtimes — start agent-daemon</option>';
        runtimeSel.disabled = true;
      } else {
        for (const r of online) {
          const opt = document.createElement('option');
          opt.value = r.id;
          const clis = r.clis_available?.length ? ` [${r.clis_available.join(',')}]` : '';
          opt.textContent = `${r.host} · ${r.os}/${r.arch}${clis} · ${r.id.slice(0, 8)}`;
          runtimeSel.appendChild(opt);
        }
      }
    } catch (err) {
      showToast(`Failed to load agents/runtimes: ${describeError(err)}`, 'error');
    }
  })();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const agent_id = String(data.get('agent_id') ?? '').trim();
    const runtime_id = String(data.get('runtime_id') ?? '').trim();
    if (!agent_id || !runtime_id) {
      showToast('Pick an agent and a runtime', 'warn');
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Handing over…';
    try {
      const res = (await iii.trigger({
        function_id: 'issues::assign',
        payload: { issue_id: issueId, agent_id, runtime_id },
      })) as { ok?: boolean; error?: string; status?: string };
      if (res?.ok === false) {
        showToast(`Cannot assign: ${res.error ?? 'already claimed'}`, 'warn');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Hand over';
        return;
      }
      const agentName = loadedAgents.find((a) => a.id === agent_id)?.name ?? 'agent';
      showToast(`Handed over to ${agentName}`, 'success');
      wrap.remove();
    } catch (err) {
      showToast(`Hand-over failed: ${describeError(err)}`, 'error', 5000);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Hand over';
    }
  });
}

async function updateIssueStatus(issueId: string, nextStatus: string, successText: string) {
  await iii.trigger({
    function_id: 'issues::status_set',
    payload: { issue_id: issueId, status: nextStatus },
  });
  showToast(successText, 'success');
}

// Intercept assign-link clicks before the generic anchor-routing handler picks them up.
document.addEventListener('click', (e) => {
  const target = (e.target as Element | null)?.closest?.('[data-action]') as HTMLElement | null;
  if (!target) return;
  const action = target.dataset.action;
  if (!action) return;
  e.preventDefault();
  e.stopPropagation();
  const issueId = target.dataset.issueId ?? '';
  const issueTitle = target.dataset.issueTitle ?? '';
  if (!issueId) return;

  if (action === 'assign') {
    openAssignModal(issueId, issueTitle);
    return;
  }
  if (action === 'approve') {
    void updateIssueStatus(issueId, 'done', `Marked "${issueTitle || issueId.slice(0, 8)}" as done`).catch(
      (err) => showToast(`Approve failed: ${describeError(err)}`, 'error', 5000),
    );
    return;
  }
  if (action === 'reopen') {
    void updateIssueStatus(issueId, 'open', `Moved "${issueTitle || issueId.slice(0, 8)}" back to open`).catch(
      (err) => showToast(`Reopen failed: ${describeError(err)}`, 'error', 5000),
    );
  }
}, true);

document.addEventListener('click', (e) => {
  const body = (e.target as Element | null)?.closest?.('.turn .turnBody[data-full-text]') as HTMLElement | null;
  if (!body) return;
  e.preventDefault();
  const full = body.dataset.fullText ?? '';
  const maxTurnChars = Number.parseInt(body.dataset.maxTurnChars ?? '', 10);
  const previewLimit = Number.isFinite(maxTurnChars) && maxTurnChars > 0
    ? maxTurnChars
    : DEFAULT_MAX_TURN_CHARS;
  const isExpanded = body.dataset.expanded === '1';
  if (isExpanded) {
    const short = full.length > previewLimit ? `${full.slice(0, previewLimit)}…` : full;
    body.textContent = short;
    body.dataset.expanded = '0';
    body.dataset.truncated = '1';
  } else {
    body.textContent = full;
    body.dataset.expanded = '1';
    body.dataset.truncated = '0';
  }
});

document.getElementById('btnNewTask')?.addEventListener('click', () => {
  openFormModal({
    title: 'New task',
    body: 'Files into the OPEN column. Any agent in this workspace can claim it.',
    submitLabel: 'Create task',
    fields: [
      { name: 'title', label: 'Title', required: true, placeholder: 'Fix login redirect loop' },
      { name: 'body', label: 'Details', type: 'textarea', placeholder: 'What should the agent do? Include links, repros, acceptance criteria.' },
      { name: 'labels', label: 'Labels (comma-separated)', placeholder: 'bug, backend' },
    ],
    onSubmit: async (v) => {
      const labels = v.labels ? v.labels.split(',').map((s) => s.trim()).filter(Boolean) : [];
      await iii.trigger({
        function_id: 'issues::create',
        payload: {
          workspace_id: 'default',
          title: v.title,
          body: v.body || '',
          labels,
          creator_id: 'user',
        },
      });
      showToast(`Task filed: "${v.title}"`, 'success');
    },
  });
});

document.getElementById('btnNewAgent')?.addEventListener('click', () => {
  openFormModal({
    title: 'Register agent',
    body: 'Register an LLM-backed agent. It will pick up issues assigned to this workspace.',
    submitLabel: 'Register',
    fields: [
      { name: 'name', label: 'Name', required: true, placeholder: 'coder-claude' },
      { name: 'provider', label: 'Provider', required: true, placeholder: 'anthropic | openai | openrouter | cli' },
      { name: 'capabilities', label: 'Capabilities (comma-separated)', placeholder: 'code, review' },
    ],
    onSubmit: async (v) => {
      const capabilities = v.capabilities ? v.capabilities.split(',').map((s) => s.trim()).filter(Boolean) : [];
      await iii.trigger({
        function_id: 'agent::register',
        payload: {
          workspace_id: 'default',
          name: v.name,
          provider: v.provider,
          capabilities,
        },
      });
      showToast(`Agent registered: ${v.name}`, 'success');
    },
  });
});

(async () => {
  await applyRoute(parseLocation());
  const dot = $('connDot');
  dot.classList.add('ok');
  $('connLabel').textContent = `tab ${tabId.slice(0, 8)}`;
})();
