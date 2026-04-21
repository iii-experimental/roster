import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { registerWorker, Logger } from 'iii-sdk';

for (const p of ['.env', '/workspace/.env', '/workspace/../.env']) {
  if (existsSync(p)) dotenvConfig({ path: p, override: false });
}

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'provider-anthropic' },
);
const log = new Logger();

process.on('unhandledRejection', (reason) => {
  log.error('provider-anthropic unhandled rejection', { reason: String(reason) });
});

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const REQUEST_TIMEOUT_MS = 120_000;

type Msg = { role: 'user' | 'assistant'; content: string };

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
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost_usd?: number };
};

iii.registerFunction('provider-anthropic::complete', async (input: CompleteInput): Promise<CompleteResult> => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { ok: false, text: '', model: input.model, error: 'ANTHROPIC_API_KEY not set' };
  }
  const messages = input.messages?.length
    ? input.messages
    : input.prompt ? [{ role: 'user', content: input.prompt }] : [];
  if (messages.length === 0) {
    return { ok: false, text: '', model: input.model, error: 'no prompt or messages provided' };
  }

  const body: Record<string, unknown> = {
    model: input.model.replace(/^anthropic\//, '') || DEFAULT_MODEL,
    messages,
    max_tokens: input.max_tokens ?? 1024,
  };
  if (input.system) body.system = input.system;
  if (input.temperature !== undefined) body.temperature = input.temperature;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': key,
        'anthropic-version': API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      return { ok: false, text: '', model: input.model, error: `http ${resp.status}: ${await resp.text()}` };
    }
    const data = (await resp.json()) as {
      content?: { type: string; text?: string }[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (data.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    return {
      ok: true,
      text,
      model: input.model,
      finish_reason: data.stop_reason,
      usage: { prompt_tokens: data.usage?.input_tokens, completion_tokens: data.usage?.output_tokens },
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

iii.registerFunction('provider-anthropic::list_models', async () => {
  return {
    ok: true,
    models: [
      { id: 'anthropic/claude-opus-4-7', family: 'opus', tier: 'top' },
      { id: 'anthropic/claude-sonnet-4-6', family: 'sonnet', tier: 'balanced' },
      { id: 'anthropic/claude-haiku-4-5-20251001', family: 'haiku', tier: 'fast' },
    ],
  };
});

log.info('provider-anthropic worker registered');
