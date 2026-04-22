# roster

Agent platform on [iii](https://iii.dev). Every worker runs in its own libkrun microVM. No REST, no HTTP, no framework. The browser is a worker too — a thin DOM renderer the backend drives by publishing ops into iii state.

**Status:** experimental, first repo in `iii-experimental/`. Pins iii v0.11.3.

## What you do with it

A kanban board for AI agents. File a task, hand it to an agent, watch it run.

1. `+ New task` → task lands in **OPEN**
2. `+ Register agent` → pick provider (anthropic / openai / openrouter / cli)
3. `assign →` on the card → pick agent + runtime → task flips to **CLAIMED**
4. `agent-daemon` on that runtime picks it up → **RUNNING** → LLM streams turns into the run view
5. Terminal status flips the card to **REVIEW** (completed) or **BLOCKED** (failed)

You can drag cards between columns to force a status. Click a card's `view run` link for the full reasoning trace with per-turn tokens + cost.

## Why microVMs

`iii worker add <name>` and `iii worker add ./local-path` both boot the worker inside a libkrun microVM (KVM on Linux, HVF on macOS ARM). Per-worker isolated rootfs, vCPU, RAM. Zero shared process space. Write arbitrary agent code, run it, tear it down — not a container, not a subprocess, not a chroot.

## What's in the box

21 workers wired today. Browser UI ships the full handover loop — **+ New task**, **+ Register agent**, per-card **assign →** / **reassign**, drag-between-columns, live run view with per-turn tokens + cost.

| Worker | Language | Role |
|---|---|---|
| `roster-ui` | Vite + vanilla TS + `iii-browser-sdk` | Browser worker. Registers ~15 `browser::tab::<id>::dom::*` primitives and one `ui::apply` reactive renderer subscribed to `roster:ui::*` state scope. |
| `roster-orchestrator` | TypeScript | Reads `issues` / `runtimes` state, builds per-view ops lists, publishes `{generation, ops}` snapshots. |
| `issues` | TypeScript | `create`, `assign`, `status_set`, `list`, `get`, `close`. Status log appended on every transition. |
| `thread` | TypeScript | `open`, `post`, `list`, `system_msg`. Generic discussion thread for issues or agent runs. |
| `runtimes` | TypeScript | `register`, `heartbeat`, `list`, `revoke`. Cron `gc` marks stale runtimes offline after 90s. |
| `agent-daemon` | TypeScript | Registers a runtime, heartbeats, watches `issues` scope, claims `claimed` issues for its own runtime_id, kicks off `agent::run_start`. |
| `agent` | TypeScript | Run lifecycle + reasoning loop. Calls `router::decide` → dispatches by model-id prefix to a `provider-*::complete` worker → `router::health_update`. No inline provider code. |
| `memory` | TypeScript | `store`, `recall`, `get`, `forget`, `list`, `consolidate`. BM25-only v1. |
| `shell` | TypeScript | `exec`, `which`, `detect_clis`. Denylist for `rm/sudo/mkfs/...`. |
| `sandbox` | TypeScript | `create`, `write_files`, `exec`, `read_files`, `destroy`. v1 = host-scoped dir per sandbox (each worker is already its own microVM). Nested per-sandbox microVM needs the engine to expose `workers::add`/`exec`/`remove` as iii functions; the CLI path shipped in iii#1514 doesn't reach worker context. |
| `provider-openrouter` ★ | TypeScript (registry) | `provider-openrouter::complete` — OpenRouter Chat Completions. One key unlocks 200+ models (OpenAI, Anthropic, Google, Meta, Mistral, ...). |
| `provider-anthropic` ★ | TypeScript (registry) | `provider-anthropic::complete` — Anthropic Messages API direct. `ANTHROPIC_API_KEY`. |
| `provider-openai` ★ | TypeScript (registry) | `provider-openai::complete` — OpenAI Chat Completions direct. `OPENAI_API_KEY`, `OPENAI_BASE_URL` for Azure/compat endpoints. |
| `provider-cli` ★ | TypeScript (registry) | `provider-cli::complete` — wraps CLI tools via `shell::exec`: `claude`, `codex`, `opencode`, `openclaw`, `hermes`, `pi`, `gemini`, `cursor-agent`. |
| `llm-router` ★ | Rust (registry) | `router::decide`, `policy_*`, `classify`, `ab_*`, `health_*`, `model_*`, `stats`. Unopinionated — no baked-in catalog. |
| `meter` ☆ | TypeScript | Atomic counters + windows + threshold alerts. Replaces every `state::get → increment → set` pattern. Used by `llm-budget` + usage tracking. |
| `guardrails` ☆ | TypeScript | `check_input`, `check_output`, `classify`. Local heuristics: PII, leaked API keys, jailbreak keywords, toxicity scoring. |
| `llm-budget` ☆ | TypeScript | 14 functions: spend caps + alerts + forecast + period rollover. Per-workspace / per-agent ceilings. Per-budget mutex, UTC boundaries. |
| `auth` ☆ | TypeScript | HMAC API keys + workspace RBAC (owner/admin/member/viewer). Full-hash lookup, timing-safe compare, dotenv secret. |
| `repocache` ☆ | TypeScript | Git clone cache keyed by `(url, ref)`. State-backed mutex per key. Hourly cron prune. Strict URL/ref validation. |
| `mention` ☆ | TypeScript | `mention::parse` + state-reaction `notify`. Parses `@agent:<id>`, `@user:<id>`, `@issue#N`, `@run#<id>`. |
| `autopilot` ☆ | TypeScript | Auto-triage open issues to matching agents. Off by default. Memory + label + runtime-health weighted scoring with renormalization. |

★ = registry-owned, pulled in by name. ☆ = local, graduates to registry when stable.

### Provider routing

Model ids look like `<provider>/<slug>`. Router returns a model id; agent dispatches:

| Model id prefix | Provider worker | Credentials |
|---|---|---|
| `openrouter/...` | `provider-openrouter` | `OPENROUTER_API_KEY` |
| `anthropic/...` | `provider-anthropic` | `ANTHROPIC_API_KEY` |
| `openai/...` | `provider-openai` | `OPENAI_API_KEY` |
| `claude-cli/...` `codex-cli/...` `opencode-cli/...` `openclaw-cli/...` `hermes-cli/...` `pi-cli/...` `gemini-cli/...` `cursor-agent-cli/...` | `provider-cli` | CLI must be installed inside the runtime |
| `echo/...` | inline test hook | none |

Add a new provider = one new narrow worker with `provider-<name>::complete({model, prompt, ...}) -> {ok, text, usage?}`. Register a policy in `llm-router` that returns `<name>/<slug>`. Agent picks it up with zero code changes.


## Ports

- `49134` — backend workers ↔ engine bridge. Workers connect here by default. CLI `iii trigger` defaults here. Browser connects here in dev.
- `49135` — optional `iii-worker-manager` RBAC port for browsers in prod. Not enabled in current config (see `config.yaml` — add an `iii-worker-manager` entry when you want it).

## Quickstart

```bash
# 1. install iii (>= 0.11.3)
curl -fsSL https://iii.dev/install | bash
iii update                     # if you already have it

# 2. clone + install worker deps
git clone https://github.com/iii-experimental/roster
cd roster
npm install --workspaces       # installs deps for each worker

# 3. pick at least one provider and set its key
#    skip this if you only want to try the inline `echo/` model
cp workers/provider-openrouter/.env.example workers/provider-openrouter/.env
$EDITOR workers/provider-openrouter/.env     # set OPENROUTER_API_KEY

# 4. set the auth worker secret (one-time)
echo "AUTH_HMAC_SECRET=$(openssl rand -hex 32)" > workers/auth/.env

# 5. boot the engine — starts every worker as a local-path microVM
iii
```

**First boot:** 2–3 min per worker (libkrun VM setup + `npm install` inside each VM). Subsequent boots: ~5 s.

Once `iii worker list` shows everything running, open:

| URL | What |
|-----|------|
| `http://localhost:5173` | roster board (vite serves the UI worker) |
| `http://localhost:3113` | iii developer console (workers, functions, traces, state) |

### Hand a task to an agent

From the board at `http://localhost:5173`:

1. Click **+ New task** (top-right). Fill title + details + labels → **Create task**. Card lands in **OPEN**.
2. Navigate to **Agents**. Click **+ Register agent**. Fill name + provider + capabilities → **Register**.
3. Back on the board, click **assign →** on the card you filed. Pick your agent + the runtime that's online → **Hand over**.
4. Card moves to **CLAIMED**. `agent-daemon` on that runtime picks it up, flips to **RUNNING**, and starts streaming turns.
5. Click **view run** on a **RUNNING** card to watch the reasoning trace live.

### Smoke test (no API key)

One command runs the whole pipe end-to-end using the inline `echo/` provider.

```bash
npm run smoke
```

If you prefer raw `iii trigger` calls, see `scripts/smoke.sh`.

See [`docs/providers.md`](./docs/providers.md) for model-id prefixes, env vars per provider, and how to add a new provider worker.

### Real LLM run via OpenRouter

```bash
# workers/provider-openrouter/.env
OPENROUTER_API_KEY=sk-or-v1-...

# policy + model routed through llm-router
iii trigger --function-id 'router::policy_create' --payload '{
  "id":"openrouter-default","name":"OpenRouter default",
  "match":{"feature":"roster.agent.run","tags":["openrouter"]},
  "action":{"model":"openrouter/openai/gpt-4o-mini"},
  "priority":50,"enabled":true
}'

iii trigger --function-id 'agent::register' \
  --payload '{"workspace_id":"default","name":"or-bot","provider":"openrouter","capabilities":["openrouter"]}'
# create → assign → real completion comes back as a turn
```

## Architecture

```
┌────────────────────────────────────────────────────┐
│  browser  (roster-ui, iii-browser-sdk on 49134)    │
│  registers browser::tab::<id>::dom::* primitives   │
│  subscribes to state:roster:ui::<view>             │
└──────────────┬─────────────────────────────────────┘
               │ state-reactions
┌──────────────▼─────────────────────────────────────┐
│                    iii engine                      │
│  state · queues · triggers · pub/sub · streams     │
│  libkrun microVM manager · OTel                    │
└──┬─────────────────────────────────────────────────┘
   │ ws://localhost:49134
   ▼
backend workers, each in its own libkrun microVM:

  issues · thread · runtimes · agent-daemon · agent
  memory · shell · sandbox · roster-orchestrator
  llm-router  (registry)
```

Everything else is `iii.trigger({ function_id, payload })` or `state::set` / `state::list` / state-reactions. No HTTP between workers. No REST. No shared database.

### UI pattern (browser renders, backend drives)

Backend workers own UI state. The browser is a renderer:

1. `roster-orchestrator` listens on `state:issues` / `state:runtimes`. On change it rebuilds an ops list and writes `{generation, ops}` to `state:roster:ui::board` (or any other view key).
2. Each browser tab opens a WebSocket to the engine via `iii-browser-sdk`, registers `browser::tab::<uuid>::dom::{setText,createElement,setStyle,addEventListener,toast,beep,...}` and one `ui::apply` handler, and subscribes to the ui scope it cares about.
3. When ops land, `ui::apply` walks the list and calls the primitive for each op. Late-joining tabs reapply the whole snapshot and converge to the same DOM. Multi-tab sync is free.

No React, no TanStack, no JSX. The whole frontend is ~400 LOC: one vanilla TS file + a CSS file + a static HTML template.

### Reusable workers

Two kinds of workers in `config.yaml`:

**Domain workers** — only roster needs them. Stay in this repo. `issues`, `thread`, `runtimes`, `agent`, `agent-daemon`, `roster-orchestrator`, `roster-ui`.

**Reusable workers** — every agent platform needs them. Pulled in by name from the registry:

```yaml
- name: llm-router
```

`iii worker add llm-router` works anywhere. Another project drops the same worker in and builds something different on top.

Some of the reusable workers currently live inside `workers/` (`shell`, `sandbox`, `memory`) because we're iterating on them alongside roster. They graduate to the registry once stable — at that point the directory is deleted and `config.yaml` just names them. No code changes in the orchestration layer. That's the whole exercise: find the shared thing, pull it out, drop it into the registry, stop carrying it.

## Development

```bash
npm install --workspaces       # install per-worker node_modules
iii                            # boots engine + every worker, reads config.yaml

# useful CLI in another shell
iii worker list                # what's running
iii worker logs <name>         # stream stdout/stderr
iii worker restart <name>      # kick one worker
iii worker reinstall <name>    # wipe managed artifacts, rebuild
iii worker clear --yes         # nuke every managed dir
```

Source edits to TypeScript workers hot-reload via tsx watch inside the microVM. Rust workers (llm-router) need `iii worker reinstall <name>` to pick up a code change (cargo rebuild ~1-2 min).

Pinned SDKs — exact, no ranges:

- Rust: `iii-sdk = "0.11.3"`
- Node backend: `"iii-sdk": "0.11.3"`
- Node browser: `"iii-browser-sdk": "0.11.3"`
- Python: `iii-sdk==0.11.3`

## Secrets

Every secret loads via dotenv inside the worker. No inline keys in YAML, source, or config.

```bash
# workers/agent/.env  (already in .gitignore via **/.env)
OPENROUTER_API_KEY=sk-or-v1-...
ANTHROPIC_API_KEY=sk-ant-...
```

Worker entry point reads them through `dotenv/config`. `iii.worker.yaml` does not contain secret values — ever.

## Known limitations

- `iii-worker-manager` RBAC port (49135) is not wired into the demo config; current setup connects the browser straight to 49134. Add an `iii-worker-manager` entry before exposing publicly.
- `sandbox` v1 is a host-scoped directory per sandbox. Nested-microVM spawn (full per-run isolation) waits for the planned engine-level sandbox worker that exposes `workers::add` / `workers::exec` / `workers::remove` as iii functions.
- `autopilot` worker is commented out in `config.yaml` pending stability work on auto-claim loops.
- The `roster-ui` worker in `config.yaml` expects port 5173; run vite on the host (`cd workers/roster-ui && npx vite --port 5173`) during dev since the worker's own VM will clash if the host port is already bound.

## Design

See [`DESIGN.md`](./DESIGN.md). Visual language comes from the iii console verbatim: black background, electric yellow (`#F3F724`) used only on active nav and CTAs, Geist Sans for interface, JetBrains Mono for data. Dark-first. Zero decoration, no gradients, no glow.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
