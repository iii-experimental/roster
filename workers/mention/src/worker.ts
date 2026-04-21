import { registerWorker, Logger } from 'iii-sdk';
import { parseMentions, type Mention } from './parse.js';

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'mention' },
);
const log = new Logger();

process.on('unhandledRejection', (reason) => {
  log.error('mention unhandled rejection', { reason: String(reason) });
});

type MsgValue = {
  ts?: number;
  author_type?: 'user' | 'agent' | 'system';
  author_id?: string;
  body?: string;
};

// msg keys look like `msg:<thread_id>:<ts>:<uuid>`. Thread id can contain
// dashes but not colons, so splitting on `:` and taking index 1 is safe.
function threadIdFromKey(key: string): string | null {
  const parts = key.split(':');
  if (parts.length < 2 || parts[0] !== 'msg') return null;
  const tid = parts[1];
  return tid && tid.length > 0 ? tid : null;
}

// Downstream triggers are best-effort. A failing notify must not throw from
// the state-reaction handler — it would just retry forever on the same msg.
async function safeTrigger(function_id: string, payload: unknown, context: string): Promise<unknown | null> {
  try {
    return await iii.trigger({ function_id, payload });
  } catch (err) {
    log.warn('mention downstream failed', { function_id, context, error: String(err) });
    return null;
  }
}

iii.registerFunction('mention::parse', async (input: { body: string }) => {
  return { mentions: parseMentions(input?.body ?? '') };
});

async function notifyForMention(
  mention: Mention,
  threadId: string,
  authorType: string,
  body: string,
): Promise<void> {
  const toastBody = `${authorType}: ${body.slice(0, 80)}`;

  if (mention.type === 'agent') {
    await safeTrigger(
      'ui::toast',
      { title: '@mention', body: toastBody },
      `agent:${mention.id}`,
    );
    return;
  }

  if (mention.type === 'user') {
    await safeTrigger(
      'ui::toast',
      { title: '@mention', body: toastBody },
      `user:${mention.id}`,
    );
    await safeTrigger(
      'thread::system_msg',
      { thread_id: threadId, body: `@user ${mention.id} mentioned in msg` },
      `user:${mention.id}`,
    );
    return;
  }

  if (mention.type === 'issue') {
    const probe = await safeTrigger(
      'issues::get',
      { issue_id: mention.id },
      `issue:${mention.id}`,
    );
    // issues::get returns { issue: Issue | null }, so probe itself is always
    // a non-null envelope when the trigger succeeds — must unwrap to confirm
    // the issue actually exists.
    if (probe != null && (probe as { issue?: unknown }).issue != null) {
      await safeTrigger(
        'thread::system_msg',
        { thread_id: threadId, body: `linked issue #${mention.id}` },
        `issue-link:${mention.id}`,
      );
    }
    return;
  }

  if (mention.type === 'run') {
    const probe = await safeTrigger(
      'agent::run_status',
      { run_id: mention.id },
      `run:${mention.id}`,
    );
    // Same envelope shape as issues::get — agent::run_status returns
    // { run: Run | null }.
    if (probe != null && (probe as { run?: unknown }).run != null) {
      await safeTrigger(
        'thread::system_msg',
        { thread_id: threadId, body: `linked run ${mention.id}` },
        `run-link:${mention.id}`,
      );
    }
  }
}

iii.registerFunction(
  'mention::notify',
  async (event: { key?: string; new_value?: MsgValue }) => {
    const key = event?.key;
    if (!key || !key.startsWith('msg:')) return { skipped: 'not-a-msg' };
    const msg = event.new_value;
    if (!msg || typeof msg.body !== 'string' || msg.body.length === 0) {
      return { skipped: 'empty-body' };
    }
    const threadId = threadIdFromKey(key);
    if (!threadId) return { skipped: 'no-thread-id' };

    const mentions = parseMentions(msg.body);
    if (mentions.length === 0) return { skipped: 'no-mentions' };

    const authorType = msg.author_type ?? 'unknown';
    for (const m of mentions) {
      try {
        await notifyForMention(m, threadId, authorType, msg.body);
      } catch (err) {
        log.warn('notify-for-mention threw', {
          type: m.type,
          id: m.id,
          error: String(err),
        });
      }
    }
    return { ok: true, count: mentions.length };
  },
);

iii.registerTrigger({
  type: 'state',
  function_id: 'mention::notify',
  config: { scope: 'threads' },
});

log.info('mention worker registered');
