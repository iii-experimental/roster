import { registerWorker } from 'iii-browser-sdk';
import './styles.css';

const III = (import.meta as any).env.VITE_III_URL ?? 'ws://localhost:49134';
const iii = registerWorker(III);

const tabId = crypto.randomUUID();
const PREFIX = `browser::tab::${tabId}`;

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

(async () => {
  await applyRoute(parseLocation());
  const dot = $('connDot');
  dot.classList.add('ok');
  $('connLabel').textContent = `tab ${tabId.slice(0, 8)}`;
})();
