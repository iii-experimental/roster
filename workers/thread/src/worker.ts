import { registerWorker, Logger } from 'iii-sdk';

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'thread' },
);
const log = new Logger();

const SCOPE = 'threads';

type Thread = {
  id: string;
  parent_type: 'issue' | 'agent_run';
  parent_id: string;
  created_at: number;
};

type Msg = {
  ts: number;
  author_type: 'user' | 'agent' | 'system';
  author_id: string;
  body: string;
  markdown?: boolean;
  attachments?: string[];
};

const stateSet = (key: string, value: unknown) =>
  iii.trigger({ function_id: 'state::set', payload: { scope: SCOPE, key, value } });

const stateGet = async <T>(key: string): Promise<T | null> =>
  ((await iii.trigger({ function_id: 'state::get', payload: { scope: SCOPE, key } })) as T | null) ?? null;

const stateList = async <T>(prefix: string): Promise<T[]> => {
  const v = await iii.trigger({ function_id: 'state::list', payload: { scope: SCOPE, prefix } });
  return Array.isArray(v) ? (v as T[]) : [];
};

const threadExists = async (thread_id: string) =>
  (await stateGet<Thread>(`thread:${thread_id}`)) !== null;

iii.registerFunction(
  'thread::open',
  async (input: { parent_type: 'issue' | 'agent_run'; parent_id: string }) => {
    const id = crypto.randomUUID();
    const t: Thread = { id, parent_type: input.parent_type, parent_id: input.parent_id, created_at: Date.now() };
    await stateSet(`thread:${id}`, t);
    return { thread_id: id };
  },
);

iii.registerFunction(
  'thread::post',
  async (input: {
    thread_id: string;
    author_type: 'user' | 'agent' | 'system';
    author_id: string;
    body: string;
    markdown?: boolean;
    attachments?: string[];
  }) => {
    if (!(await threadExists(input.thread_id))) {
      return { ok: false, error: 'thread not found' };
    }
    const ts = Date.now();
    const uuid = crypto.randomUUID().slice(0, 8);
    const msg: Msg = {
      ts,
      author_type: input.author_type,
      author_id: input.author_id,
      body: input.body,
      markdown: input.markdown,
      attachments: input.attachments,
    };
    await stateSet(`msg:${input.thread_id}:${ts}:${uuid}`, msg);
    return { ok: true, ts };
  },
);

iii.registerFunction('thread::list', async (input: { thread_id: string; limit?: number }) => {
  if (!(await threadExists(input.thread_id))) {
    return { ok: false, error: 'thread not found', messages: [] };
  }
  const all = await stateList<Msg>(`msg:${input.thread_id}:`);
  all.sort((a, b) => a.ts - b.ts);
  const limit = input.limit ?? 200;
  return { messages: all.slice(-limit) };
});

iii.registerFunction(
  'thread::system_msg',
  async (input: { thread_id: string; body: string }) => {
    return await iii.trigger({
      function_id: 'thread::post',
      payload: { thread_id: input.thread_id, author_type: 'system', author_id: 'system', body: input.body },
    });
  },
);

log.info('thread worker registered');
