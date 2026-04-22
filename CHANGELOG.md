# Changelog

Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Roster pins the underlying iii engine version exactly; each roster release names the iii version it was tested on.

## [Unreleased]

### Added
- Board UI handover loop: `+ New task`, `+ Register agent`, per-card `assign →` / `reassign` modals (no CLI required for the end-to-end flow)
- Board empty state: `no tasks yet — click + New task to hand something to an agent`
- `.env.example` in every provider worker and in `workers/auth/` so `cp *.example *.env` from the README actually works
- `iii-http` in `config.yaml` with CORS for the iii-console origin (`http://127.0.0.1:3113`)
- `iii-stream` on port 3112 (required by the console's `/ws/streams` proxy)
- `iii-pubsub` and `iii-cron` config workers (silences the cron-trigger warning every worker registration emitted)
- `runtimes::gc` second stage: long-offline runtimes get deleted after 10 min so the list doesn't grow unbounded across agent-daemon restarts
- `agent-daemon` `resolveHost()` fallback for libkrun VMs (where `os.hostname()` returns empty / `(none)`)

### Changed
- Pin bump: `iii-sdk` and `iii-browser-sdk` `0.11.2` → `0.11.3` across every worker (fixes iii#1524 tokio panic on libkrun boot)
- README rewritten around the 5-step handover flow: file task → register agent → assign → RUNNING → REVIEW
- README step 2 no longer asks for host-side `npm install --workspaces`; iii runs `npm install` inside each microVM on first boot. Host install is optional (editor autocomplete / typecheck only)
- `showToast` unified through the existing `PRIMS.toast` primitive (dedup)
- `runtimes::gc` parallelized (`Promise.all` over the state mutations)
- `roster-orchestrator` startup publishes `ui::board` + `ui::runtimes` concurrently

### Required
- iii engine `0.11.3` or newer. 0.11.2 is known-broken on local-path workers (see iii#1524). Install / upgrade with `curl -fsSL https://install.iii.dev/iii/main/install.sh | sh` or `iii update`.

---

## [0.1.0] — 2026-04 (pre-release)

First cut of the roster platform. 21 narrow workers, board/agents/runtimes/settings UI, `router::decide` → provider dispatch, libkrun per-worker isolation. See [README](./README.md) for the full worker inventory.
