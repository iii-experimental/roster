import { registerWorker, Logger } from 'iii-sdk';
import {
  JAILBREAK_KEYWORDS,
  KEY_PATTERNS,
  PII_PATTERNS,
  TOXICITY_TERMS,
  luhnValid,
} from './rules.js';
import type { Category } from './rules.js';

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'guardrails' },
);
const log = new Logger();

process.on('unhandledRejection', (reason) => {
  log.error('guardrails unhandled rejection', { reason: String(reason) });
});

type Rules = {
  pii?: boolean;
  keys?: boolean;
  jailbreak?: boolean;
  toxicity_threshold?: number;
  redact?: boolean;
};

type CheckResult = {
  allowed: boolean;
  reasons: string[];
  redacted?: string;
};

type Finding = { category: Category; index: number; length: number };

const DEFAULTS: Required<Rules> = {
  pii: true,
  keys: true,
  jailbreak: true,
  toxicity_threshold: 0.02,
  redact: false,
};

function scanRegex(text: string, patterns: typeof PII_PATTERNS): Finding[] {
  const findings: Finding[] = [];
  for (const { category, regex } of patterns) {
    for (const m of text.matchAll(regex)) {
      if (m.index === undefined) continue;
      if (category === 'pii:credit_card' && !luhnValid(m[0])) continue;
      findings.push({ category, index: m.index, length: m[0].length });
    }
  }
  return findings;
}

function findAllSubstrings(haystackLower: string, needleLower: string): number[] {
  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const i = haystackLower.indexOf(needleLower, from);
    if (i === -1) return hits;
    hits.push(i);
    from = i + needleLower.length;
  }
}

function scanJailbreak(text: string): Finding[] {
  const lower = text.toLowerCase();
  const findings: Finding[] = [];
  for (const kw of JAILBREAK_KEYWORDS) {
    for (const i of findAllSubstrings(lower, kw)) {
      findings.push({ category: 'jailbreak', index: i, length: kw.length });
    }
  }
  return findings;
}

// Keyword-hit ratio per token. Cheap proxy; swap for a classifier later.
function toxicityScore(text: string): number {
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const lower = text.toLowerCase();
  let count = 0;
  for (const term of TOXICITY_TERMS) {
    count += findAllSubstrings(lower, term.toLowerCase()).length;
  }
  return count / tokens.length;
}

function redactText(text: string, findings: Finding[]): string {
  if (findings.length === 0) return text;
  // Apply replacements back-to-front so earlier indices stay valid.
  const sorted = [...findings].sort((a, b) => b.index - a.index);
  let out = text;
  for (const f of sorted) {
    out = `${out.slice(0, f.index)}[REDACTED:${f.category}]${out.slice(f.index + f.length)}`;
  }
  return out;
}

function reasonsFrom(findings: Finding[]): string[] {
  const counts = new Map<Category, number>();
  for (const f of findings) counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
  return [...counts.entries()].map(([cat, n]) => (n > 1 ? `${cat} (x${n})` : cat));
}

function runChecks(text: string, rules?: Rules): CheckResult {
  const cfg = { ...DEFAULTS, ...(rules ?? {}) };
  const findings: Finding[] = [];
  if (cfg.pii) findings.push(...scanRegex(text, PII_PATTERNS));
  if (cfg.keys) findings.push(...scanRegex(text, KEY_PATTERNS));
  if (cfg.jailbreak) findings.push(...scanJailbreak(text));

  const reasons = reasonsFrom(findings);
  const tox = toxicityScore(text);
  if (tox > 0 && tox >= cfg.toxicity_threshold) {
    reasons.push(`toxicity: ${tox.toFixed(3)}`);
  }

  const result: CheckResult = { allowed: reasons.length === 0, reasons };
  if (cfg.redact && findings.length > 0) {
    result.redacted = redactText(text, findings);
  }
  return result;
}

iii.registerFunction(
  'guardrails::check_input',
  async (input: { text: string; rules?: Rules }): Promise<CheckResult> => {
    return runChecks(input.text ?? '', input.rules);
  },
);

iii.registerFunction(
  'guardrails::check_output',
  async (input: { text: string; rules?: Rules }): Promise<CheckResult> => {
    // Output lane enforces the same ruleset; leaked keys + PII are the first-class
    // concerns on the way out.
    return runChecks(input.text ?? '', input.rules);
  },
);

iii.registerFunction(
  'guardrails::classify',
  async (input: { text: string }): Promise<{
    pii: boolean;
    jailbreak: boolean;
    toxicity: number;
    keys_leaked: boolean;
  }> => {
    const text = input.text ?? '';
    return {
      pii: scanRegex(text, PII_PATTERNS).length > 0,
      keys_leaked: scanRegex(text, KEY_PATTERNS).length > 0,
      jailbreak: scanJailbreak(text).length > 0,
      toxicity: toxicityScore(text),
    };
  },
);

log.info('guardrails worker registered');
