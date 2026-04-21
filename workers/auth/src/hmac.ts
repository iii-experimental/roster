import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const HASH_PREFIX_LEN = 12;

export function loadSecret(): string {
  const secret = process.env.AUTH_HMAC_SECRET;
  if (!secret || secret.length === 0) {
    throw new Error(
      'auth worker refuses to start: AUTH_HMAC_SECRET env var is not set. ' +
        'Generate one with `openssl rand -hex 32` and put it in workers/auth/.env.',
    );
  }
  return secret;
}

export function hashToken(secret: string, token: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

export function hashPrefix(hash: string): string {
  return hash.slice(0, HASH_PREFIX_LEN);
}

export function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function generateToken(workspaceId: string): string {
  const prefix = workspaceId.slice(0, 8);
  const body = randomBytes(24).toString('base64url');
  return `rsk_${prefix}_${body}`;
}
