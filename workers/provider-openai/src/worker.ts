import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { registerWorker, Logger } from 'iii-sdk';

for (const p of ['.env', '/workspace/.env', '/workspace/../.env']) {
  if (existsSync(p)) dotenvConfig({ path: p, override: false });
}

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'provider-openai' },
);
const log = new Logger();

process.on('unhandledRejection', (reason) => {
  log.error('provider-openai unhandled rejection', { reason: String(reason) });
});

const BASE = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
const ENDPOINT = `${BASE}/chat/completions`;
const DEFAULT_MODEL = 'gpt-4o-mini';

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

type CompleteInput = {
  model: string;
  prompt?: string;
  system?: string;
  messages?: Msg[];
  max_tokens?: number;
  temperature?: number;
};

type CompleteResult = {
  ok: boolean;
  text: string;
  model: string;
  error?: string;
  finish_reason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

// Strip a leading "openai/" so "openai/gpt-4o" becomes the raw slug.
const slugFor = (model: string) => model.replace(/^openai\//, '') || DEFAULT_MODEL;

function buildMessages(input: CompleteInput): Msg[] {
  if (input.messages?.length) return input.messages;
  const out: Msg[] = [];
  if (input.system) out.push({ role: 'system', content: input.system });
  if (input.prompt) out.push({ role: 'user', content: input.prompt });
  return out;
}

iii.registerFunction('provider-openai::complete', async (input: CompleteInput): Promise<CompleteResult> => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return { ok: false, text: '', model: input.model, error: 'OPENAI_API_KEY not set' };
  }

  const body = {
    model: slugFor(input.model),
    messages: buildMessages(input),
    max_tokens: input.max_tokens ?? 1024,
    temperature: input.temperature,
  };

  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      return { ok: false, text: '', model: input.model, error: `http ${resp.status}: ${await resp.text()}` };
    }
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices?.[0];
    return {
      ok: true,
      text: choice?.message?.content ?? '',
      finish_reason: choice?.finish_reason,
      model: input.model,
      usage: data.usage,
    };
  } catch (err) {
    return { ok: false, text: '', model: input.model, error: String(err) };
  }
});

iii.registerFunction('provider-openai::list_models', async () => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, models: [], error: 'OPENAI_API_KEY not set' };
  try {
    const resp = await fetch(`${BASE}/models`, {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (!resp.ok) return { ok: false, models: [], error: `http ${resp.status}` };
    const data = (await resp.json()) as { data?: { id: string }[] };
    return { ok: true, models: data.data ?? [] };
  } catch (err) {
    return { ok: false, models: [], error: String(err) };
  }
});

log.info('provider-openai worker registered');
