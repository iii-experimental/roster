# roster

Agent platform on [iii](https://iii.dev). Every worker = hardware-isolated libkrun microVM. No REST, no HTTP, no framework. The browser is a worker too — a dumb DOM renderer that backend workers drive by publishing ops lists into iii state.

**Status:** experimental, first repo in `iii-experimental/`. Pins iii v0.11.2.

## What it does

Assign an issue to an agent. Agent claims it, runs inside its own microVM, calls `router::decide` to pick a model, streams the answer back, posts a diff / comment, and flips the issue to review. All state lives in iii. All UI comes from reactive state snapshots. Reusable pieces (llm-router, shell, sandbox, memory, etc.) live in `iii-hq/workers` so another project installs them with `iii worker add`.

## Why microVMs

`iii worker add <name>` and `iii worker add ./local-path` both boot the worker inside a libkrun microVM (KVM on Linux, HVF on macOS ARM). Per-worker isolated rootfs, vCPU, RAM. Zero shared process space. Write arbitrary agent code, run it, tear it down — not a container, not a subprocess, not a chroot.

## What's in the box

Ten workers wired today. Eight more planned in `spec.md`.

| Worker | Language | Role |
|---|---|---|
| `roster-ui` | Vite + vanilla TS + `iii-browser-sdk` | Browser worker. Registers ~15 `browser::tab::<id>::dom::*` primitives and one `ui::apply` reactive renderer subscribed to `roster:ui::*` state scope. |
| `roster-orchestrator` | TypeScript | Reads `issues` / `runtimes` state, builds per-view ops lists, publishes `{generation, ops}` snapshots. |
| `issues` | TypeScript | `create`, `assign`, `status_set`, `list`, `get`, `close`. Status log appended on every transition. |
| `thread` | TypeScript | `open`, `post`, `list`, `system_msg`. Generic discussion thread for issues or agent runs. |
| `runtimes` | TypeScript | `register`, `heartbeat`, `list`, `revoke`. Cron `gc` marks stale runtimes offline after 90s. |
| `agent-daemon` | TypeScript | Registers a runtime, heartbeats, watches `issues` scope, claims `claimed` issues for its own runtime_id, kicks off `agent::run_start`. |
| `agent` | TypeScript | ReAct-style loop. Calls `router::decide` → provider adapter → `router::health_update`. Adapters: `claude`, `codex`, `opencode`, `openrouter`, `echo`. |
| `memory` | TypeScript | `store`, `recall`, `get`, `forget`, `list`, `consolidate`. BM25-only v1. |
| `shell` | TypeScript | `exec`, `which`, `detect_clis`. Denylist for `rm/sudo/mkfs/...`. |
| `sandbox` | TypeScript | `create`, `write_files`, `exec`, `read_files`, `destroy`. v1 = host-scoped dir (each worker already in its own microVM). Nested microVM spawn waits on engine public `VmBuilder` API. |
| `llm-router` ★ | Rust (registry) | `router::decide`, `policy_*`, `classify`, `ab_*`, `health_*`, `model_*`, `stats`. Unopinionated — no baked-in catalog. |

★ = not owned by roster. Lives in the workers repo, pulled in via config.

## Ports

- `49134` — backend workers ↔ engine bridge. Workers connect here by default. CLI `iii trigger` defaults here. Browser connects here in dev.
- `49135` — optional `iii-worker-manager` RBAC port for browsers in prod. Not enabled in current config (see `config.yaml` — add an `iii-worker-manager` entry when you want it).

## Quickstart

```bash
# 1. install iii (>= 0.11.2)
curl -fsSL https://iii.dev/install | bash
iii update                     # if you already have it

# 2. clone + install worker deps
git clone https://github.com/iii-experimental/roster
cd roster
npm install --workspaces       # installs deps for each worker

# 3. put any provider keys in workers/agent/.env (gitignored)
cp workers/agent/.env.example workers/agent/.env
$EDITOR workers/agent/.env     # set OPENROUTER_API_KEY, etc.

# 4. boot the engine (reads ./config.yaml, starts every worker as a local-path sandbox)
iii
```

Open `http://localhost:5173` in a second tab for the board. First boot takes 2–3 minutes per worker (npm install + libkrun VM warm-up); subsequent boots are ~5 seconds.

### Smoke test from the CLI

```bash
# register an echo agent + policy
iii trigger --function-id 'agent::register' \
  --payload '{"workspace_id":"default","name":"echo-bot","provider":"echo"}'

iii trigger --function-id 'router::policy_create' --payload '{
  "id":"echo-default","name":"Echo default",
  "match":{"feature":"roster.agent.run","tags":["echo"]},
  "action":{"model":"echo/tiny"},"priority":100,"enabled":true
}'

# create, assign, watch status flip claimed → running → review
iii trigger --function-id 'issues::create' \
  --payload '{"workspace_id":"default","title":"ping","body":"does it work?"}'

iii trigger --function-id 'runtimes::list' --payload '{}'   # grab runtime_id
iii trigger --function-id 'issues::assign' \
  --payload '{"issue_id":"<id>","agent_id":"<id>","runtime_id":"<id>"}'

iii trigger --function-id 'issues::get' --payload '{"issue_id":"<id>"}'
```

### Real LLM run via OpenRouter

```bash
# .env at workers/agent/.env
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

- Rust: `iii-sdk = "0.11.2"`
- Node backend: `"iii-sdk": "0.11.2"`
- Node browser: `"iii-browser-sdk": "0.11.2"`
- Python: `iii-sdk==0.11.2`

## Secrets

Every secret loads via dotenv inside the worker. No inline keys in YAML, source, or config.

```bash
# workers/agent/.env  (already in .gitignore via **/.env)
OPENROUTER_API_KEY=sk-or-v1-...
ANTHROPIC_API_KEY=sk-ant-...
```

Worker entry point reads them through `dotenv/config`. `iii.worker.yaml` does not contain secret values — ever.

## Known limitations

- `iii-worker-manager` RBAC port (49135) is not yet wired into the demo config; current setup connects the browser straight to 49134. Add an `iii-worker-manager` entry before exposing publicly.
- `sandbox` v1 is a host-scoped directory per sandbox. Nested-microVM spawn (full per-run isolation) waits for the engine to expose its `VmBuilder` API publicly.
- `llm-router` needs an upstream fix (state envelope shape changed in v0.11.2). Tracked; swap to the registry version once released.
- Workers still listed as "stopped" in `iii worker list` after config edits is cosmetic — functions stay registered. Run `iii worker restart <name>` to refresh the list.

## Design

See [`DESIGN.md`](./DESIGN.md). Visual language comes from the iii console verbatim: black background, electric yellow (`#F3F724`) used only on active nav and CTAs, Geist Sans for interface, JetBrains Mono for data. Dark-first. Zero decoration, no gradients, no glow.

## License

Apache-2.0.
