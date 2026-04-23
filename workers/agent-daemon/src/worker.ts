import { registerWorker, Logger } from 'iii-sdk';
import os from 'node:os';
import { execSync } from 'node:child_process';

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'agent-daemon' },
);
const log = new Logger();

const PROVIDER_CLIS = ['claude', 'codex', 'openclaw', 'opencode', 'gemini', 'cursor-agent', 'hermes', 'pi'];
const HEARTBEAT_MS = 30_000;

function detectClis(): string[] {
  const found: string[] = [];
  for (const bin of PROVIDER_CLIS) {
    try {
      execSync(`command -v ${bin}`, { stdio: 'ignore' });
      found.push(bin);
    } catch {
      // not installed
    }
  }
  return found;
}

let runtimeId: string | null = null;

type AgentDef = {
  id: string;
  workspace_id: string;
  name: string;
  provider: string;
};

function resolveHost(): string {
  // os.hostname() inside a libkrun microVM usually returns the empty string
  // or "(none)". Fall back to explicit env override, then a stable default.
  const envHost = process.env.ROSTER_HOST || process.env.HOST || '';
  const systemHost = os.hostname() || '';
  const host = envHost || systemHost;
  return host && host !== '(none)' ? host : 'libkrun-vm';
}

async function registerSelf() {
  const { runtime_id } = (await iii.trigger({
    function_id: 'runtimes::register',
    payload: {
      host: resolveHost(),
      os: process.platform,
      arch: process.arch,
      clis_available: detectClis(),
    },
  })) as { runtime_id: string };
  runtimeId = runtime_id;
  log.info('runtime registered', { runtime_id });
}

async function ensureDefaultAgent() {
  const list = (await iii.trigger({
    function_id: 'state::list',
    payload: { scope: 'agents', prefix: 'agent:' },
  })) as AgentDef[];

  const hasDefault = Array.isArray(list) && list.some((a) => a?.workspace_id === 'default');
  if (hasDefault) return;

  const nameSuffix = runtimeId ? runtimeId.slice(0, 6) : 'local';
  await iii.trigger({
    function_id: 'agent::register',
    payload: {
      workspace_id: 'default',
      name: `default-agent-${nameSuffix}`,
      provider: 'echo',
      runtime_id: runtimeId ?? undefined,
      capabilities: ['general'],
    },
  });
  log.info('default agent auto-registered', { runtime_id: runtimeId });
}

async function heartbeat() {
  if (!runtimeId) return;
  try {
    await iii.trigger({
      function_id: 'runtimes::heartbeat',
      payload: { runtime_id: runtimeId },
    });
  } catch (err) {
    log.warn('heartbeat failed', { error: String(err) });
  }
}

// Fire-and-forget: kick off the run, flip issue to running. Terminal status
// flows back via on_run_change (state-reaction on the agents scope), so the
// daemon never polls or holds an open invocation waiting for the agent.
iii.registerFunction('agent-daemon::run_claimed', async (input: { issue_id: string; agent_id: string }) => {
  log.info('claiming run', input);
  await iii.trigger({
    function_id: 'issues::status_set',
    payload: { issue_id: input.issue_id, status: 'running' },
  });
  try {
    const start = (await iii.trigger({
      function_id: 'agent::run_start',
      payload: { agent_id: input.agent_id, issue_id: input.issue_id },
    })) as { run_id: string };
    log.info('agent run started', { run_id: start.run_id });
  } catch (err) {
    log.error('run_claimed failed to start', { error: String(err) });
    await iii.trigger({
      function_id: 'issues::status_set',
      payload: { issue_id: input.issue_id, status: 'blocked', reason: String(err) },
    });
  }
  return { ok: true };
});

iii.registerFunction('agent-daemon::on_issue_claimed', async (event: { new_value?: { id: string; status: string; assignee_id?: string; runtime_id?: string } }) => {
  const issue = event?.new_value;
  if (!issue || issue.status !== 'claimed') return { skipped: true };
  if (!issue.assignee_id) return { skipped: true };
  // Require an explicit runtime_id match. A missing runtime_id on the issue
  // is treated as "not mine" so it can't be claimed by every daemon at once.
  if (!issue.runtime_id || issue.runtime_id !== runtimeId) return { skipped: true };
  return await iii.trigger({
    function_id: 'agent-daemon::run_claimed',
    payload: { issue_id: issue.id, agent_id: issue.assignee_id },
  });
});

// State-reaction on the agents scope. Fires on every agent_run:* write. When
// the run's status becomes terminal, reflect that into the linked issue.
// Replaces the polling loop; engine delivers the event synchronously with the
// write, so no loop, no deadline, no wasted round-trips.
iii.registerFunction('agent-daemon::on_run_change', async (event: {
  key?: string;
  new_value?: { id?: string; issue_id?: string; status?: string };
}) => {
  if (!event?.key?.startsWith('agent_run:')) return { skipped: 'not-a-run' };
  const run = event.new_value;
  if (!run?.issue_id || !run.status) return { skipped: 'missing-fields' };
  if (run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled') {
    return { skipped: 'non-terminal' };
  }
  const nextStatus = run.status === 'completed' ? 'review' : 'blocked';
  await iii.trigger({
    function_id: 'issues::status_set',
    payload: { issue_id: run.issue_id, status: nextStatus, reason: run.status },
  });
  return { ok: true, run_id: run.id, status: run.status };
});

iii.registerTrigger({
  type: 'state',
  function_id: 'agent-daemon::on_issue_claimed',
  config: { scope: 'issues' },
});

iii.registerTrigger({
  type: 'state',
  function_id: 'agent-daemon::on_run_change',
  config: { scope: 'agents' },
});

async function registerWithRetry(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      await registerSelf();
      return;
    } catch (err) {
      log.warn('registerSelf retry', { attempt: i + 1, error: String(err) });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('registerSelf failed after 30 attempts');
}

process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { reason: String(reason) });
});

(async () => {
  try {
    await registerWithRetry();
    await ensureDefaultAgent();
  } catch (err) {
    log.error('agent-daemon startup failed, exiting for supervisor restart', { error: String(err) });
    process.exit(1);
  }
  setInterval(() => {
    heartbeat().catch((err) => log.warn('heartbeat err', { error: String(err) }));
  }, HEARTBEAT_MS);
  log.info('agent-daemon ready');
})();
