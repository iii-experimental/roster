export type Category =
  | 'pii:email'
  | 'pii:ssn'
  | 'pii:credit_card'
  | 'pii:phone'
  | 'keys:openai'
  | 'keys:github'
  | 'keys:aws'
  | 'keys:slack'
  | 'jailbreak'
  | 'toxicity';

export type Pattern = { category: Category; regex: RegExp };

export const PII_PATTERNS: Pattern[] = [
  // what this matches: RFC-ish email (local@domain.tld)
  { category: 'pii:email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // what this matches: US SSN in NNN-NN-NNNN form
  { category: 'pii:ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  // what this matches: 13–19 digit runs (separators allowed); Luhn-checked downstream
  { category: 'pii:credit_card', regex: /\b(?:\d[ -]?){13,19}\b/g },
  // what this matches: North-American-style phone with optional country code and separators
  { category: 'pii:phone', regex: /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g },
];

export const KEY_PATTERNS: Pattern[] = [
  // what this matches: OpenAI / OpenRouter / Anthropic style `sk-...` keys
  { category: 'keys:openai', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  // what this matches: GitHub personal access token
  { category: 'keys:github', regex: /\bghp_[A-Za-z0-9]{36}\b/g },
  // what this matches: AWS access key id
  { category: 'keys:aws', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  // what this matches: Slack bot/app/user/refresh tokens
  { category: 'keys:slack', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
];

export const JAILBREAK_KEYWORDS: string[] = [
  'ignore previous instructions',
  'ignore all previous instructions',
  'ignore the above',
  'disregard above',
  'disregard previous',
  'pretend you are',
  'pretend to be',
  'act as if',
  'dan mode',
  'developer mode enabled',
  'system prompt',
  'reveal your prompt',
  'leak your instructions',
  'jailbreak',
  'bypass safety',
];

// Tiny keyword-based toxicity scorer. Intentionally short — a real classifier
// is a future swap via `classifier::score`.
export const TOXICITY_TERMS: string[] = [
  'kill yourself',
  'kys',
  'idiot',
  'moron',
  'stupid',
  'retard',
  'scum',
  'trash',
  'hate you',
  'shut up',
  'die',
  'worthless',
  'pathetic',
  'loser',
  'bastard',
  'damn you',
  'screw you',
  'go die',
  'asshole',
  'bitch',
];

export function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i -= 1) {
    let n = d.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}
