export type MentionType = 'agent' | 'user' | 'issue' | 'run';

export type Mention = {
  type: MentionType;
  id: string;
  span: [number, number];
  raw: string;
};

// One combined regex with named groups. Alternation runs left-to-right per
// position, so spans never overlap. `g` so matchAll yields every hit.
const MENTION_RE =
  /@agent:(?<agent>[A-Za-z0-9_-]{1,64})|@user:(?<user>[A-Za-z0-9_-]{1,64})|@issue#(?<issue>\d+)|@run#(?<run>[A-Za-z0-9_-]{1,64})/g;

// Group names double as MentionType values — one lookup replaces a 4-way if/else.
const GROUP_TYPES: readonly MentionType[] = ['agent', 'user', 'issue', 'run'];

export function parseMentions(body: string): Mention[] {
  if (typeof body !== 'string' || body.length === 0) return [];
  const out: Mention[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    const groups = m.groups;
    if (!groups) continue;
    for (const type of GROUP_TYPES) {
      const id = groups[type];
      if (!id) continue;
      const start = m.index ?? 0;
      const raw = m[0];
      out.push({ type, id, span: [start, start + raw.length], raw });
      break;
    }
  }
  return out;
}
