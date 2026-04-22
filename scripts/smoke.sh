#!/usr/bin/env bash
# End-to-end smoke test using the inline `echo/` provider.
# No API keys needed. Exercises: policy → agent → issue → assign → status flip.
# Requires: `iii` engine already running (see README quickstart).

set -euo pipefail

WORKSPACE_ID="${WORKSPACE_ID:-default}"
POLICY_ID="smoke-echo-$(date +%s)"
AGENT_NAME="smoke-echo-bot-$$"

say() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

command -v iii >/dev/null || die "iii CLI not found. Install: curl -fsSL https://install.iii.dev/iii/main/install.sh | sh"
command -v jq  >/dev/null || die "jq required. Install: brew install jq  (macOS)  or  apt-get install jq"

# 1. make sure the engine is reachable
say "ping engine"
iii trigger --function-id 'state::list' --payload '{"scope":"issues","limit":1}' >/dev/null \
  || die "engine not reachable on default port. start with: iii"

# 2. register an echo agent
say "register echo agent: $AGENT_NAME"
AGENT_ID=$(iii trigger --function-id 'agent::register' --payload "$(jq -n \
  --arg ws "$WORKSPACE_ID" --arg n "$AGENT_NAME" \
  '{workspace_id:$ws, name:$n, provider:"echo", capabilities:["echo"]}')" \
  | jq -r '.agent_id // .id')
[ -n "$AGENT_ID" ] && [ "$AGENT_ID" != "null" ] || die "agent::register returned no id"

# 3. policy: feature=roster.agent.run + tag=echo → model=echo/tiny
say "create policy: $POLICY_ID"
iii trigger --function-id 'router::policy_create' --payload "$(jq -n \
  --arg id "$POLICY_ID" \
  '{id:$id, name:"smoke echo",
    match:{feature:"roster.agent.run", tags:["echo"]},
    action:{model:"echo/tiny"},
    priority:100, enabled:true}')" >/dev/null

# 4. grab a runtime_id to pin the issue to
say "pick a runtime"
RUNTIME_ID=$(iii trigger --function-id 'runtimes::list' --payload '{}' \
  | jq -r '[.runtimes[]? | select(.status=="online")][0].id // .runtimes[0].id // empty')
[ -n "$RUNTIME_ID" ] || die "no runtimes registered. is agent-daemon worker running?"

# 5. create an issue
say "create issue"
ISSUE_ID=$(iii trigger --function-id 'issues::create' --payload "$(jq -n \
  --arg ws "$WORKSPACE_ID" \
  '{workspace_id:$ws, title:"smoke: ping", body:"smoke test via echo provider"}')" \
  | jq -r '.issue_id // .id')
[ -n "$ISSUE_ID" ] && [ "$ISSUE_ID" != "null" ] || die "issues::create returned no id"
printf '  issue_id=%s\n' "$ISSUE_ID"

# 6. assign the issue — agent-daemon should claim it, agent run should fire
say "assign"
iii trigger --function-id 'issues::assign' --payload "$(jq -n \
  --arg iid "$ISSUE_ID" --arg aid "$AGENT_ID" --arg rid "$RUNTIME_ID" \
  '{issue_id:$iid, agent_id:$aid, runtime_id:$rid}')" >/dev/null

# 7. poll issues::get until terminal
say "watch issue status"
for i in $(seq 1 30); do
  STATUS=$(iii trigger --function-id 'issues::get' --payload "$(jq -n --arg iid "$ISSUE_ID" '{issue_id:$iid}')" \
    | jq -r '.issue.status // .status')
  printf '  [%02d] status=%s\n' "$i" "$STATUS"
  case "$STATUS" in
    review)  say "DONE — issue reached review"; exit 0 ;;
    blocked) die "issue blocked. check: iii worker logs agent-daemon && iii worker logs agent" ;;
    done|closed) say "DONE — issue $STATUS"; exit 0 ;;
  esac
  sleep 1
done

die "timeout — issue never reached terminal status. check: iii worker logs agent-daemon && iii worker logs agent"
