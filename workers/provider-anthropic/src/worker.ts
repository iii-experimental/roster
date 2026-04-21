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

// Strip a leading "anthropic/" so "anthropic/claude-opus-4-7" becomes the
// raw slug Anthropic's API expects.
const slugFor = (model: string) => model.replace(/^anthropic\//, '') || DEFAULT_MODEL;

function buildMessages(input: CompleteInput): Msg[] {
  if (input.messages?.length) return input.messages;
  return input.prompt ? [{ role: 'user', content: input.prompt }] : [];
}

iii.registerFunction('provider-anthropic::complete', async (input: CompleteInput): Promise<CompleteResult> => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { ok: false, text: '', model: input.model, error: 'ANTHROPIC_API_KEY not set' };
  }

  const body: Record<string, unknown> = {
    model: slugFor(input.model),
    messages: buildMessages(input),
    max_tokens: input.max_tokens ?? 1024,
  };
  if (input.system) body.system = input.system;
  if (input.temperature !== undefined) body.temperature = input.temperature;

  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
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
    return { ok: false, text: '', model: input.model, error: String(err) };
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
