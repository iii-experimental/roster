# Design System — roster

Visual language for roster. Inherits the iii console design system verbatim and adds roster-specific page and component primitives on top. If a token or rule appears here and also in the console `DESIGN.md`, the console is the source of truth — sync in that direction, not this one.

## Product Context

- **What this is:** Reference app for building an agent platform on the iii engine. Board of issues, agents-as-teammates, live run viewer.
- **Who it's for:** Backend developers running agents on their own infrastructure via iii.
- **Space:** Developer infrastructure. Same aesthetic family as the iii console.
- **Project type:** Data-heavy dashboard with live streaming.

## Aesthetic Direction

- **Direction:** Industrial / Utilitarian.
- **Decoration level:** Minimal. Typography and color do the work. No gradients, no glow effects, no atmospheric backgrounds.
- **Mood:** Engine-room control panel. Every element earns its place. Raw, functional, serious.
- **Reference:** iii console (`iii-hq/iii`, `packages/console-frontend/`). Peer references: Vercel, Linear, Neon, Resend.

## Typography

- **Display / Hero:** Geist Sans 700, `-0.02em` tracking at large sizes.
- **Body / UI:** Geist Sans 400–500.
- **UI Labels:** Geist Sans 600 uppercase, `0.04em` tracking.
- **Data / Tables / Logs:** JetBrains Mono 400–500 with `tabular-nums`. Used for issue IDs, run IDs, timestamps, cost values, token counts, tool output, diff content, log lines.
- **Code:** JetBrains Mono 400.
- **Loading:** `https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap`.

**Scale:**

| Role | Size | Weight |
|---|---|---|
| Page heading | 18px | Geist 600 |
| Section title | 24px | Geist 700 / `-0.01em` |
| Card heading | 18px | Geist 600 |
| Body | 14px | Geist 400 |
| Small body | 13px | Geist 400 |
| Label | 12px | Geist 600 uppercase `0.04em` |
| Mono display (cost, token count) | 20px | JBM 600 tabular-nums |
| Mono body (IDs, timestamps) | 13px | JBM 400 |
| Mono small | 11px | JBM 400 |

**Assignment rule:** Geist Sans for "interface" (nav, headings, button labels, column headers). JetBrains Mono for "data" (IDs, timestamps, metrics, JSON, log lines, tool input/output).

## Color

**Approach:** Restrained. Yellow is rare and meaningful. Most of the UI is grayscale. Color carries semantics.

**Tokens:**

```css
:root {
  --background: #000000;
  --foreground: #F4F4F4;
  --sidebar: #0A0A0A;
  --elevated: #111111;
  --hover: #1A1A1A;
  --border: #2D2D2D;
  --border-subtle: #1D1D1D;
  --muted: #5B5B5B;
  --secondary: #9CA3AF;
  --accent: #F3F724;          /* electric yellow */
  --accent-hover: #D4D820;
  --accent-subtle: rgba(243, 247, 36, 0.08);
  --accent-text: #000000;
  --success: #22C55E;
  --warning: #F3F724;
  --error: #EF4444;
  --info: #3B82F6;
}
```

**Accent use:** CTAs, active nav item, focused input outline, logo mark, accent pills, budget bar fill, `.caret` thinking indicator. Nothing else.

**Semantic subtle backgrounds:**

- `success` → `rgba(34,197,94,0.12)`
- `error` → `rgba(239,68,68,0.12)`
- `warning` → `rgba(243,247,36,0.10)`
- `info` → `rgba(59,130,246,0.12)`

**Dark mode is default.** Light mode tokens live in `console.css` for future use but are not required for v1.

## Spacing

Base unit: 4px. Density: comfortable.

| Alias | px |
|---|---|
| `2xs` | 2 |
| `xs` | 4 |
| `sm` | 8 |
| `md` | 16 |
| `lg` | 24 |
| `xl` | 32 |
| `2xl` | 48 |
| `3xl` | 64 |

## Layout

- **Sidebar:** fixed 224px, collapsible on mobile. Matches console.
- **Max content width:** 1100px for settings/config pages. Data tables are full-width.
- **Border radius:** `sm:4px · md:6px · lg:10px · full:9999px`.
  - Cards / panels: `lg` (10px).
  - Buttons / inputs: `md` (6px).
  - Status badges / pills: `full`.
  - Small elements (log line hover): `sm`.

## Motion

- **Approach:** Minimal-functional. Only transitions that aid comprehension.
- **Easing:** enter `cubic-bezier(0.16, 1, 0.3, 1)`, exit `ease-in`, move `ease-in-out`.
- **Duration:** micro 80ms · short 150ms · medium 300ms · long 500ms.
- **Usage:** panel slides, state transitions on health indicators, tab switches, hover feedback. No decorative animation.

Reuse the existing keyframes from `console.css`:

- `blink` — placeholder / pending state.
- `thinking-pulse` — active agent turn indicator.
- `slide-in-right` — new row insertion in log views.
- `flash-in` — state change highlight.
- `caret-blink` — streaming text caret.

Do not introduce new keyframes without proposing them to the console team first.

## Component Primitives

All of these live in `console.css`. Vendor `console.css` into `workers/roster-ui/src/styles/` or (preferred) consume it from the shared `@iii-hq/console-ui` package once extracted.

| Primitive | Classes | Use |
|---|---|---|
| Card | `.card` | Issues, runs, agent cards, setting groups |
| Pill | `.pill.{neutral,outline,ok,warn,err,info,accent}` | Status labels, tags |
| Status dot | `.status-dot.{ok,warn,err,idle}` | Runtime health, issue state, budget warning |
| Divider | `.hr`, `.vr` | Section separators |
| Mono / sans toggle | `.mono`, `.sans` | Force font family on inline elements |
| Label | `.uppercase-label` | Column headers, section titles |
| Bar chart | `.bar-track`, `.bar-fill` | Budget usage, progress |
| Caret | `.caret` | Streaming text cursor in run view |
| Thinking dots | `.thinking-dot` x3 | Agent is reasoning |
| Slide-in | `.slide-in` | New rows in live lists |
| Flash-in | `.flash-in` | Briefly highlight a row that changed |

If roster needs a new primitive, propose it to the console first so both stay in sync.

## Pages

| Route | Purpose | Key primitives |
|---|---|---|
| `/` | **Board.** Columns by status: open · claimed · running · blocked · review · done. | `.card`, `.pill.{ok,warn,err,info}`, `.status-dot` |
| `/runs/:id` | **Run detail.** Live turn feed, cost bar, tool-call log, diff panel. | `.mono` for IDs and output, `.bar-track`/`.bar-fill` for budget, `.caret` while streaming, `.thinking-dot` between turns |
| `/agents` | **Agents list.** Provider, runtime, budget, policy. | `.pill.accent` for active, mono for model IDs |
| `/runtimes` | **Runtimes.** Host, OS/arch, CLIs detected, heartbeat. | `.status-dot`, mono timestamps |
| `/settings` | Workspaces, budgets, autopilot toggle, providers. | standard form inputs |

Navigation sidebar matches console's 224px fixed layout. Logo: `iii-white.svg` mark plus `roster` wordmark in Geist 700. The wordmark is never yellow — yellow is reserved for active state.

## Branded elements specific to roster

- **Run status dots:** `ok` (done / review), `warn` (blocked / budget low), `err` (failed), `idle` (not started).
- **Cost ribbon:** shown in run header. Mono 20px, accent yellow when within budget, error red when budget exhausted.
- **Issue labels:** rendered as outline pills, no fill colors — labels are semantic metadata, they should not compete with status.
- **Agent avatar:** single-character monogram in a 24px square. Background `#1A1A1A`, foreground Geist 600 in `--secondary`. No photos, no illustrations.
- **Diff viewer:** JetBrains Mono 13px. Added lines on `rgba(34,197,94,0.10)` background, removed on `rgba(239,68,68,0.10)`. No syntax highlight in v1 — plain text only. Syntax highlighting is a phase-4 upgrade if it doesn't conflict with the zero-decoration policy.

## Non-goals

- No marketing page embedded in the app. The app is the product; the landing page lives at `iii.dev`.
- No theme switcher in v1. Dark-first, one theme.
- No illustrated empty states, no mascot characters, no stock icons beyond the Lucide set used by the console.
- No emojis in the UI copy. Same rule as commit messages and READMEs.

## Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-20 | Adopt iii console design system for roster | One aesthetic across the iii ecosystem. Devs moving between console and roster feel continuity. |
| 2026-04-20 | Vite + React + TanStack Router for roster-ui | Matches console stack exactly. No framework drift. iii-browser-sdk handles data layer, SSR adds nothing. |
| 2026-04-20 | No competing design system, no Tailwind preset | Tokens from `console.css` cover the full surface. Adding Tailwind would duplicate decisions already made. |
| 2026-04-20 | Diff viewer plain text in v1 | Syntax highlighting risks conflict with the zero-decoration rule. Revisit in phase 4. |
