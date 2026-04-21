import { registerWorker, Logger } from 'iii-sdk';

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'memory' },
);
const log = new Logger();

const SCOPE = 'memories';

type Mem = {
  id: string;
  workspace_id: string;
  author_id: string;
  tags: string[];
  body: string;
  metadata?: Record<string, unknown>;
  created_at: number;
};

process.on('unhandledRejection', (reason) => {
  log.error('memory unhandled rejection', { reason: String(reason) });
});

const stateSet = (key: string, value: unknown) =>
  iii.trigger({ function_id: 'state::set', payload: { scope: SCOPE, key, value } });

const stateGet = async <T>(key: string): Promise<T | null> =>
  ((await iii.trigger({ function_id: 'state::get', payload: { scope: SCOPE, key } })) as T | null) ?? null;

const stateList = async <T>(): Promise<T[]> => {
  const v = await iii.trigger({ function_id: 'state::list', payload: { scope: SCOPE } });
  return Array.isArray(v) ? (v as T[]) : [];
};

const stateDelete = (key: string) =>
  iii.trigger({ function_id: 'state::delete', payload: { scope: SCOPE, key } });

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in', 'into',
  'is', 'it', 'its', 'no', 'not', 'of', 'on', 'or', 'that', 'the', 'their', 'then',
  'there', 'these', 'they', 'this', 'to', 'was', 'will', 'with',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function bm25Score(
  queryTerms: string[],
  docTerms: string[],
  avgDocLen: number,
  docFreq: Map<string, number>,
  totalDocs: number,
): number {
  const k1 = 1.5;
  const b = 0.75;
  const docLen = docTerms.length;
  const termCounts = new Map<string, number>();
  for (const t of docTerms) termCounts.set(t, (termCounts.get(t) ?? 0) + 1);
  let score = 0;
  for (const qt of queryTerms) {
    const tf = termCounts.get(qt) ?? 0;
    if (tf === 0) continue;
    const df = docFreq.get(qt) ?? 0;
    if (df === 0) continue;
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
    const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + (b * docLen) / avgDocLen));
    score += idf * norm;
  }
  return score;
}

iii.registerFunction(
  'memory::store',
  async (input: {
    workspace_id: string;
    author_id?: string;
    body: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }) => {
    const id = crypto.randomUUID();
    const mem: Mem = {
      id,
      workspace_id: input.workspace_id,
      author_id: input.author_id ?? 'unknown',
      tags: input.tags ?? [],
      body: input.body,
      metadata: input.metadata,
      created_at: Date.now(),
    };
    await stateSet(`mem:${id}`, mem);
    return { mem_id: id };
  },
);

iii.registerFunction(
  'memory::recall',
  async (input: { workspace_id: string; query: string; k?: number; tags?: string[] }) => {
    const all = await stateList<Mem>();
    const scoped = all.filter((m) => {
      if (m.workspace_id !== input.workspace_id) return false;
      if (input.tags && input.tags.length > 0) {
        if (!input.tags.every((t) => m.tags.includes(t))) return false;
      }
      return true;
    });

    const queryTerms = tokenize(input.query);
    if (queryTerms.length === 0 || scoped.length === 0) {
      return { results: [] };
    }

    const docs = scoped.map((m) => ({ mem: m, terms: tokenize(m.body) }));
    const docFreq = new Map<string, number>();
    for (const d of docs) {
      const seen = new Set(d.terms);
      for (const t of seen) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    }
    const avgLen = docs.reduce((a, d) => a + d.terms.length, 0) / Math.max(1, docs.length);
    const k = input.k ?? 10;

    const scored = docs
      .map((d) => ({
        mem_id: d.mem.id,
        body: d.mem.body,
        tags: d.mem.tags,
        score: bm25Score(queryTerms, d.terms, avgLen, docFreq, docs.length),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    return { results: scored };
  },
);

iii.registerFunction('memory::get', async (input: { mem_id: string }) => {
  return { mem: await stateGet<Mem>(`mem:${input.mem_id}`) };
});

iii.registerFunction('memory::forget', async (input: { mem_id: string }) => {
  await stateDelete(`mem:${input.mem_id}`);
  return { ok: true };
});

iii.registerFunction(
  'memory::list',
  async (input: { workspace_id: string; tags?: string[] }) => {
    const all = await stateList<Mem>();
    const out = all.filter((m) => {
      if (m.workspace_id !== input.workspace_id) return false;
      if (input.tags && input.tags.length > 0) {
        if (!input.tags.every((t) => m.tags.includes(t))) return false;
      }
      return true;
    });
    out.sort((a, b) => b.created_at - a.created_at);
    return { memories: out };
  },
);

iii.registerFunction(
  'memory::consolidate',
  async (input: { workspace_id: string }) => {
    const all = await stateList<Mem>();
    const scoped = all.filter((m) => m.workspace_id === input.workspace_id);
    // Deterministic dedup: keep the oldest record per body, discard the rest.
    // Tie-break on id so two memories written in the same ms still order.
    scoped.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    const seen = new Map<string, string>();
    let dropped = 0;
    for (const m of scoped) {
      const key = m.body.trim().toLowerCase();
      if (seen.has(key)) {
        await stateDelete(`mem:${m.id}`);
        dropped += 1;
      } else {
        seen.set(key, m.id);
      }
    }
    return { kept: seen.size, dropped };
  },
);

log.info('memory worker registered');
