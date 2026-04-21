import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { registerWorker, Logger } from 'iii-sdk';

// microVM mounts the project at /workspace; cwd inside the VM isn't always the
// workspace root, so try the common spots.
for (const p of ['.env', '/workspace/.env', '/workspace/../.env']) {
  if (existsSync(p)) dotenvConfig({ path: p, override: false });
}

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'provider-openrouter' },
);
const log = new Logger();

process.on('unhandledRejection', (reason) => {
  log.error('provider-openrouter unhandled rejection', { reason: String(reason) });
});

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

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
  text: string;
  finish_reason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost_usd?: number };
  model: string;
  ok: boolean;
  error?: string;
};

// Strip any leading "openrouter/" so "openrouter/openai/gpt-4o-mini" becomes
// the slug OpenRouter actually expects.
const slugFor = (model: string) => model.replace(/^openrouter\//, '');

function buildMessages(input: CompleteInput): Msg[] {
  if (input.messages?.length) return input.messages;
  const out: Msg[] = [];
  if (input.system) out.push({ role: 'system', content: input.system });
  if (input.prompt) out.push({ role: 'user', content: input.prompt });
  return out;
}

iii.registerFunction('provider-openrouter::complete', async (input: CompleteInput): Promise<CompleteResult> => {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return { ok: false, text: '', model: input.model, error: 'OPENROUTER_API_KEY not set' };
  }

  const body = {
    model: slugFor(input.model),
    messages: buildMessages(input),
    max_tokens: input.max_tokens ?? 512,
    temperature: input.temperature,
  };

  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/iii-experimental/roster',
        'X-Title': 'roster',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      return { ok: false, text: '', model: input.model, error: `http ${resp.status}: ${await resp.text()}` };
    }
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_cost?: number };
    };
    const choice = data.choices?.[0];
    return {
      ok: true,
      text: choice?.message?.content ?? '',
      finish_reason: choice?.finish_reason,
      model: input.model,
      usage: {
        prompt_tokens: data.usage?.prompt_tokens,
        completion_tokens: data.usage?.completion_tokens,
        cost_usd: data.usage?.total_cost,
      },
    };
  } catch (err) {
    return { ok: false, text: '', model: input.model, error: String(err) };
  }
});

iii.registerFunction('provider-openrouter::list_models', async () => {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { ok: false, models: [], error: 'OPENROUTER_API_KEY not set' };
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (!resp.ok) return { ok: false, models: [], error: `http ${resp.status}` };
    const data = (await resp.json()) as { data?: { id: string; name?: string }[] };
    return { ok: true, models: data.data ?? [] };
  } catch (err) {
    return { ok: false, models: [], error: String(err) };
  }
});

log.info('provider-openrouter worker registered');
