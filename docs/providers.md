# Providers

Roster dispatches LLM calls via narrow provider workers. Router picks the model, agent reads the prefix, routes to the right worker. Adding a new provider = one new worker + one policy row. No edits to `workers/agent/`.

## Model id convention

```
<provider>/<slug>
```

Examples:

| Model id | Routes to | Notes |
|---|---|---|
| `openrouter/openai/gpt-4o-mini` | `provider-openrouter` | OpenRouter passes the slug through to upstream |
| `anthropic/claude-sonnet-4-6` | `provider-anthropic` | direct Anthropic Messages API |
| `openai/gpt-4o` | `provider-openai` | direct OpenAI Chat Completions |
| `openai/gpt-4o-azure` | `provider-openai` | same worker, `OPENAI_BASE_URL` switches to Azure |
| `claude-cli/default` | `provider-cli` | wraps local `claude` binary via `shell::exec` |
| `codex-cli/default` | `provider-cli` | `codex` binary |
| `opencode-cli/default` | `provider-cli` | `opencode` binary |
| `openclaw-cli/default`, `hermes-cli/default`, `pi-cli/default`, `gemini-cli/default`, `cursor-agent-cli/default` | `provider-cli` | each binary must be on `$PATH` inside the agent runtime |
| `echo/tiny` | inline test hook in `workers/agent/` | echoes prompt back. no credentials, no network. for smoke tests. |

## Credentials

Each provider worker loads its own `.env` via dotenv. Never in YAML.

| Worker | Env var(s) | Get it |
|---|---|---|
| `provider-openrouter` | `OPENROUTER_API_KEY` | openrouter.ai/keys — one key unlocks 200+ models |
| `provider-anthropic` | `ANTHROPIC_API_KEY` | console.anthropic.com |
| `provider-openai` | `OPENAI_API_KEY`, `OPENAI_BASE_URL` (optional) | platform.openai.com. `OPENAI_BASE_URL` for Azure / OpenAI-compat endpoints. |
| `provider-cli` | none. CLI binaries must be on `$PATH`. | install the CLI you want (`claude`, `codex`, …) |

Setup:

```bash
cp workers/provider-openrouter/.env.example workers/provider-openrouter/.env
$EDITOR workers/provider-openrouter/.env
# same for provider-anthropic, provider-openai if you need them
```

## Contract

Every provider worker exposes one function:

```ts
`provider-${name}::complete`

// input
{ model: string, prompt: string, max_tokens?: number, system?: string, ... }

// output
{ ok: true, text: string, usage?: { prompt_tokens, completion_tokens, total_tokens }, model?: string }
// or
{ ok: false, error: string }
```

Agent never branches on provider name. It reads the prefix from the router's model id and dispatches to `provider-<prefix>::complete`. Add a provider, agent picks it up with zero code changes.

## Routing flow

```
issues::assign
    │
    ▼
agent-daemon (watches issues scope, claims for its runtime_id)
    │
    ▼
agent::run_start
    │
    ├── router::decide({ feature: "roster.agent.run", tags: [...] })
    │       │
    │       ▼
    │   picks highest-priority enabled policy → returns { model: "<provider>/<slug>" }
    │
    ├── provider-<prefix>::complete({ model, prompt, max_tokens })
    │
    └── router::health_update({ model, ok, latency_ms })
```

## Adding a new provider

Example: `provider-groq`.

1. **Copy an existing narrow worker.** `cp -r workers/provider-openai workers/provider-groq` — it's the shortest one that hits a real HTTP API.

2. **Update `package.json`** — name → `@roster/provider-groq`.

3. **Update `iii.worker.yaml`** — name → `provider-groq`.

4. **Rewrite `src/worker.ts`** — register one function, `provider-groq::complete`. Read `GROQ_API_KEY` from `process.env`. Match the contract above. Use `AbortController` with a timeout (120s on complete, 10s on list). Return `{ ok: false, error }` on failures, don't throw.

5. **Add `.env.example`:**
   ```
   GROQ_API_KEY=gsk_xxx
   ```

6. **Register in `config.yaml`:**
   ```yaml
   - name: provider-groq
     worker_path: ./workers/provider-groq
   ```

7. **Add a router policy that returns `groq/<model>`:**
   ```bash
   iii trigger --function-id 'router::policy_create' --payload '{
     "id":"groq-default","name":"Groq default",
     "match":{"feature":"roster.agent.run","tags":["groq"]},
     "action":{"model":"groq/llama-3.3-70b-versatile"},
     "priority":60,"enabled":true
   }'
   ```

8. **Register an agent that matches the policy:**
   ```bash
   iii trigger --function-id 'agent::register' --payload '{
     "workspace_id":"default","name":"groq-bot",
     "provider":"groq","capabilities":["groq"]
   }'
   ```

9. **Restart:** `iii worker restart agent` (picks up the new prefix), `iii worker restart provider-groq`. Smoke test with `issues::create` → `issues::assign`.

That's it. No changes in `workers/agent/`. No changes in `llm-router`. One new narrow worker + one policy row.

## Graduating a provider to the registry

Once `provider-groq` is stable and useful beyond roster, it moves to `iii-hq/workers`:

1. Delete `workers/provider-groq/` from roster.
2. In `config.yaml`, drop `worker_path`:
   ```yaml
   - name: provider-groq
   ```
3. Commit with `iii v<version>` bump note.

Another project runs `iii worker add provider-groq` and gets the same worker.
