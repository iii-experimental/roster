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

async function registerSelf() {
  const { runtime_id } = (await iii.trigger({
    function_id: 'runtimes::register',
    payload: {
      host: os.hostname(),
      os: process.platform,
      arch: process.arch,
      clis_available: detectClis(),
    },
  })) as { runtime_id: string };
  runtimeId = runtime_id;
  log.info('runtime registered', { runtime_id });
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

    const deadline = Date.now() + 180_000;
    let run: { status: string } | null = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const res = (await iii.trigger({
        function_id: 'agent::run_status',
        payload: { run_id: start.run_id },
      })) as { run: { status: string } | null };
      run = res.run;
      if (!run) break;
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') break;
    }

    const nextStatus = run?.status === 'completed' ? 'review' : 'blocked';
    await iii.trigger({
      function_id: 'issues::status_set',
      payload: {
        issue_id: input.issue_id,
        status: nextStatus,
        reason: run?.status ?? 'unknown',
      },
    });
  } catch (err) {
    log.error('run_claimed failed', { error: String(err) });
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

iii.registerTrigger({
  type: 'state',
  function_id: 'agent-daemon::on_issue_claimed',
  config: { scope: 'issues' },
});

async function registerWithRetry() {
  for (let i = 0; i < 30; i++) {
    try {
      await registerSelf();
      return;
    } catch (err) {
      log.warn('registerSelf retry', { attempt: i + 1, error: String(err) });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  log.error('registerSelf failed after 30 attempts, giving up');
}

process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { reason: String(reason) });
});

(async () => {
  await registerWithRetry();
  setInterval(() => {
    heartbeat().catch((err) => log.warn('heartbeat err', { error: String(err) }));
  }, HEARTBEAT_MS);
  log.info('agent-daemon ready');
})();
