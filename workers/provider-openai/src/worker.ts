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
const REQUEST_TIMEOUT_MS = 120_000;

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.model.replace(/^openai\//, '') || DEFAULT_MODEL,
        messages: buildMessages(input),
        max_tokens: input.max_tokens ?? 1024,
        temperature: input.temperature,
      }),
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
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      text: '',
      model: input.model,
      error: isAbort ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : String(err),
    };
  } finally {
    clearTimeout(timer);
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
