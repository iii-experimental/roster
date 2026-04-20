# roster

Reference app for building an agent platform on [iii](https://iii.dev) using narrow workers.

Assign issues to agents. Agents run in sandboxed runtimes, write code, post diffs, update status. Skills compound. Everything is a worker — the frontend, the daemon, the agent loop, the router, the sandbox. No custom framework, no REST layer. The engine is the backbone, workers are the parts.

**Status:** experimental. First project in `iii-experimental/`. Expect breakage.

## What's in the box

| Worker | Language | Role |
|---|---|---|
| `roster-ui` | Vite + React + TanStack Router + `iii-browser-sdk` | Board, run viewer, settings. Browser worker. |
| `agent` | Node | ReAct loop. Provider adapters for Claude Code, Codex, OpenClaw, OpenCode, Gemini, Cursor Agent, Hermes, Pi. |
| `agent-daemon` | Node | Local runtime. Registers a machine, heartbeats, claims runs. |
| `issues` · `thread` · `runtimes` · `memory` · `mention` · `repocache` · `autopilot` | Node | Domain workers. Thin. |
| `shell` · `sandbox-docker` · `guardrails` · `meter` · `auth` · `introspect` | Rust | Perf-critical primitives. |
| `llm-router` · `llm-budget` | Rust | Unopinionated model selection + cost enforcement. No baked-in catalog. |
| `eval` | Python | Benchmark suites for agent regressions. |

## Ports

- `49134` — backend worker ↔ engine (`iii` / `iii-sdk`)
- `49135` — browser worker ↔ engine (`iii-browser-sdk`, RBAC-gated)

## Quickstart

```bash
# 1. install iii
curl -fsSL https://iii.dev/install | bash

# 2. scaffold + add workers
iii init
iii worker add agent agent-daemon issues thread runtimes memory mention repocache \
  shell sandbox-docker guardrails llm-router llm-budget meter auth introspect \
  eval autopilot roster-ui

# 3. run
iii start
```

Then open `http://localhost:5173`. Create an issue, assign it to an agent, watch the run stream live.

## Architecture

```
┌───────────────────────────────┐
│  roster-ui  (browser worker)  │ ── ws://localhost:49135
└──────────────┬────────────────┘
               │
┌──────────────▼────────────────┐
│          iii engine           │ state · queues · triggers · pub/sub · streams · OTel
└──┬──────────────────────────┬─┘
   │ ws://localhost:49134
   ▼
 backend workers (Rust / TS / Python)
```

All inter-worker calls are `iii.trigger({ function_id, payload })` or state subscriptions. No HTTP, no REST, no shared database. The engine's Worker Manager enforces RBAC per function ID.

## Design

Visual language and component tokens come from the iii console — see [`DESIGN.md`](./DESIGN.md). Black background, electric yellow accent (`#F3F724`), Geist Sans for interface, JetBrains Mono for data. Dark-first. Zero decoration.

## Development

```bash
pnpm install
pnpm dev          # starts engine + all workers + roster-ui
pnpm test         # unit tests per worker
pnpm e2e          # Playwright against a running stack
```

Every worker has its own `package.json` or `Cargo.toml`. SDK versions are pinned exact:

- Rust: `iii-sdk = "0.11.1"`
- Node (backend): `"iii": "0.11.1"`
- Node (browser): `"iii-browser-sdk": "0.11.1"`
- Python: `iii-sdk==0.11.1`

## License

Apache-2.0.
