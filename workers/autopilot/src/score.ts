export type Agent = {
  id: string;
  workspace_id: string;
  name?: string;
  capabilities?: string[];
  runtime_id?: string;
};

export type Issue = {
  id: string;
  workspace_id: string;
  title: string;
  body: string;
  labels: string[];
  assignee_id?: string;
};

export type Runtime = {
  id: string;
  status: 'online' | 'offline' | 'revoked';
};

export type MemoryRecallHit = { score?: number };
export type MemoryRecallResult = { results?: MemoryRecallHit[] };
export type RuntimesListResult = { runtimes?: Runtime[] };

export type Suggestion = {
  agent_id: string;
  confidence: number;
  reasons: string[];
};

export type MatchBy = 'labels' | 'capabilities' | 'memory';

export const WEIGHT_LABELS = 0.4;
export const WEIGHT_MEMORY = 0.4;
export const WEIGHT_RUNTIME = 0.2;

export function labelOverlapScore(issueLabels: string[], capabilities: string[]): {
  score: number;
  matched: number;
  total: number;
} {
  const caps = new Set(capabilities.map((c) => c.toLowerCase()));
  const labels = issueLabels.map((l) => l.toLowerCase());
  let matched = 0;
  for (const l of labels) if (caps.has(l)) matched += 1;
  const total = Math.max(labels.length, 1);
  return { score: matched / total, matched, total: labels.length };
}

export function memoryAffinityScore(recall: MemoryRecallResult | null | undefined): {
  score: number;
  avg: number;
  n: number;
} {
  const hits = recall?.results ?? [];
  if (hits.length === 0) return { score: 0, avg: 0, n: 0 };
  let sum = 0;
  let n = 0;
  for (const h of hits) {
    if (typeof h.score === 'number' && Number.isFinite(h.score)) {
      sum += h.score;
      n += 1;
    }
  }
  if (n === 0) return { score: 0, avg: 0, n: 0 };
  const avg = sum / n;
  // memory::recall returns raw BM25-ish scores that are unbounded. Clamp into
  // [0, 1] so it stays on the same scale as the other components.
  const clamped = Math.max(0, Math.min(1, avg));
  return { score: clamped, avg, n };
}

export function runtimeAvailabilityScore(
  agent: Agent,
  runtimes: Runtime[],
): { score: number; online: boolean; known: boolean } {
  if (!agent.runtime_id) return { score: 0, online: false, known: false };
  const rt = runtimes.find((r) => r.id === agent.runtime_id);
  if (!rt) return { score: 0, online: false, known: false };
  const online = rt.status === 'online';
  return { score: online ? 1 : 0, online, known: true };
}

export function buildSuggestion(params: {
  agent: Agent;
  issue: Issue;
  memoryRecall: MemoryRecallResult | null;
  runtimes: Runtime[];
  matchBy: MatchBy[];
}): Suggestion {
  const { agent, issue, memoryRecall, runtimes, matchBy } = params;
  const reasons: string[] = [];

  const useLabels = matchBy.includes('labels') || matchBy.includes('capabilities');
  const useMemory = matchBy.includes('memory');

  const labelRes = useLabels
    ? labelOverlapScore(issue.labels, agent.capabilities ?? [])
    : { score: 0, matched: 0, total: issue.labels.length };
  const memRes = useMemory
    ? memoryAffinityScore(memoryRecall)
    : { score: 0, avg: 0, n: 0 };
  const rtRes = runtimeAvailabilityScore(agent, runtimes);

  const confidence =
    WEIGHT_LABELS * labelRes.score +
    WEIGHT_MEMORY * memRes.score +
    WEIGHT_RUNTIME * rtRes.score;

  if (useLabels && labelRes.total > 0) {
    reasons.push(`${labelRes.matched}/${labelRes.total} labels matched capabilities`);
  } else if (useLabels && labelRes.total === 0) {
    reasons.push('issue has no labels');
  }
  if (useMemory) {
    if (memRes.n > 0) {
      reasons.push(`memory recall avg ${memRes.avg.toFixed(2)} over ${memRes.n} hit(s)`);
    } else {
      reasons.push('no memory hits for this agent');
    }
  }
  if (rtRes.known) {
    reasons.push(rtRes.online ? 'runtime online' : 'runtime offline');
  } else if (agent.runtime_id) {
    reasons.push('runtime unknown');
  } else {
    reasons.push('no runtime bound');
  }

  return {
    agent_id: agent.id,
    confidence: Math.max(0, Math.min(1, confidence)),
    reasons,
  };
}

export function sortSuggestions(suggestions: Suggestion[]): Suggestion[] {
  return [...suggestions].sort((a, b) => b.confidence - a.confidence);
}
