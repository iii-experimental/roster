import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { registerWorker, Logger } from 'iii-sdk';
import {
  generateToken,
  hashToken,
  loadSecret,
  timingSafeHexEqual,
} from './hmac.js';
import { assertRole, isRole, roleSatisfies, type Role } from './roles.js';
import {
  keyKey,
  keyLookupKey,
  makeStore,
  roleKey,
  workspaceKey,
  type ApiKey,
  type RoleGrant,
  type Workspace,
} from './store.js';

for (const p of ['.env', '/workspace/.env', '/workspace/../.env']) {
  if (existsSync(p)) dotenvConfig({ path: p, override: false });
}

const SECRET = loadSecret();

// Verify-path cache window for last_used_at writes. Longer = fewer writes,
// coarser telemetry. 5 min is the standard "this key is still in use" ping.
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;

const iii = registerWorker(
  process.env.III_URL ?? 'ws://localhost:49134',
  { workerName: 'auth' },
);
const log = new Logger();

const store = makeStore((args) => iii.trigger(args));

process.on('unhandledRejection', (reason) => {
  log.error('auth unhandled rejection', { reason: String(reason) });
});

iii.registerFunction(
  'auth::workspace_create',
  async (input: { name: string; owner_id: string }) => {
    if (!input.name || !input.owner_id) {
      throw new Error('workspace_create requires name and owner_id');
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    const workspace: Workspace = {
      id,
      name: input.name,
      owner_id: input.owner_id,
      created_at: now,
    };
    await store.set(workspaceKey(id), workspace);
    const grant: RoleGrant = {
      workspace_id: id,
      user_id: input.owner_id,
      role: 'owner',
      granted_at: now,
    };
    try {
      await store.set(roleKey(id, input.owner_id), grant);
    } catch (err) {
      // Compensating rollback — engine has no cross-key transactions yet, so
      // a failed owner grant would leave the workspace unowned.
      await store.del(workspaceKey(id)).catch(() => {});
      throw err;
    }
    return { workspace_id: id };
  },
);

iii.registerFunction(
  'auth::workspace_get',
  async (input: { workspace_id: string }) => {
    if (!input.workspace_id) {
      throw new Error('workspace_get requires workspace_id');
    }
    const ws = await store.get<Workspace>(workspaceKey(input.workspace_id));
    if (!ws) return { workspace: null };
    return {
      workspace: { id: ws.id, name: ws.name, created_at: ws.created_at },
    };
  },
);

iii.registerFunction(
  'auth::key_create',
  async (input: {
    workspace_id: string;
    role: string;
    description?: string;
    created_by?: string;
  }) => {
    const role = assertRole(input.role);
    const ws = await store.get<Workspace>(workspaceKey(input.workspace_id));
    if (!ws) throw new Error(`workspace not found: ${input.workspace_id}`);

    const id = crypto.randomUUID();
    const token = generateToken(input.workspace_id);
    const hash = hashToken(SECRET, token);
    const record: ApiKey = {
      id,
      workspace_id: input.workspace_id,
      role,
      hash,
      description: input.description,
      created_by: input.created_by,
      created_at: Date.now(),
    };
    await store.set(keyKey(id), record);
    try {
      await store.set(keyLookupKey(hash), id);
    } catch (err) {
      // Lookup entry is what verify() uses to find the key — without it, the
      // record exists but is unusable. Roll back the record write.
      await store.del(keyKey(id)).catch(() => {});
      throw err;
    }
    return { key_id: id, token };
  },
);

function publicKey(k: ApiKey) {
  return {
    key_id: k.id,
    role: k.role,
    description: k.description,
    created_at: k.created_at,
    last_used_at: k.last_used_at,
    revoked_at: k.revoked_at,
  };
}

function isApiKey(v: unknown): v is ApiKey {
  return (
    !!v &&
    typeof v === 'object' &&
    'hash' in v &&
    'workspace_id' in v &&
    'id' in v &&
    'role' in v
  );
}

function isRoleGrant(v: unknown): v is RoleGrant {
  return (
    !!v &&
    typeof v === 'object' &&
    'workspace_id' in v &&
    'user_id' in v &&
    'role' in v &&
    'granted_at' in v
  );
}

iii.registerFunction(
  'auth::key_list',
  async (input: { workspace_id: string }) => {
    // Scoped to the `key:` prefix so we don't scan workspaces + role grants
    // + lookup entries. Full workspace-prefixed keys (key:<ws>:<id>) would
    // allow a tighter scan but require a migration; acceptable for now
    // because key records are typically ~10s-100s per workspace.
    const all = await store.list<unknown>('key:');
    const keys = all
      .filter(isApiKey)
      .filter((k) => k.workspace_id === input.workspace_id)
      .map(publicKey)
      .sort((a, b) => b.created_at - a.created_at);
    return { keys };
  },
);

iii.registerFunction('auth::key_revoke', async (input: { key_id: string }) => {
  const k = await store.get<ApiKey>(keyKey(input.key_id));
  if (!k) throw new Error(`key not found: ${input.key_id}`);
  if (k.revoked_at) return { ok: true };
  k.revoked_at = Date.now();
  await store.set(keyKey(k.id), k);
  return { ok: true };
});

type VerifyResult = {
  valid: boolean;
  key_id?: string;
  workspace_id?: string;
  role?: Role;
  reason?: string;
};

iii.registerFunction(
  'auth::verify',
  async (input: {
    token: string;
    required_role?: string;
    workspace_id?: string;
  }): Promise<VerifyResult> => {
    if (typeof input.token !== 'string' || input.token.length === 0) {
      return { valid: false, reason: 'missing token' };
    }
    const incoming = hashToken(SECRET, input.token);
    const keyId = await store.get<string>(keyLookupKey(incoming));
    if (!keyId) return { valid: false, reason: 'unknown token' };
    const record = await store.get<ApiKey>(keyKey(keyId));
    if (!record) return { valid: false, reason: 'unknown token' };
    if (!timingSafeHexEqual(incoming, record.hash)) {
      return { valid: false, reason: 'unknown token' };
    }
    if (record.revoked_at) return { valid: false, reason: 'revoked' };
    if (input.workspace_id && record.workspace_id !== input.workspace_id) {
      return { valid: false, reason: 'workspace mismatch' };
    }
    if (input.required_role) {
      if (!isRole(input.required_role)) {
        return { valid: false, reason: `invalid required_role: ${input.required_role}` };
      }
      if (!roleSatisfies(record.role, input.required_role)) {
        return { valid: false, reason: 'insufficient role' };
      }
    }
    // Throttle last_used_at writes: verify is the hot path, a state::set on
    // every successful auth would chain every request through state-worker
    // latency. Skip when we've already updated in the last 5 minutes; fire-
    // and-forget when we do update so verify never blocks on the write.
    const nowMs = Date.now();
    const lastUsedFresh =
      typeof record.last_used_at === 'number' &&
      nowMs - record.last_used_at < LAST_USED_WRITE_INTERVAL_MS;
    if (!lastUsedFresh) {
      const next: ApiKey = { ...record, last_used_at: nowMs };
      void store.set(keyKey(record.id), next).catch((err) => {
        log.warn('last_used_at update failed', {
          key_id: record.id,
          reason: String(err),
        });
      });
    }
    return {
      valid: true,
      key_id: record.id,
      workspace_id: record.workspace_id,
      role: record.role,
    };
  },
);

iii.registerFunction(
  'auth::role_grant',
  async (input: { workspace_id: string; user_id: string; role: string }) => {
    const role = assertRole(input.role);
    const ws = await store.get<Workspace>(workspaceKey(input.workspace_id));
    if (!ws) throw new Error(`workspace not found: ${input.workspace_id}`);
    // Protect the workspace owner: a plain role_grant must not demote them.
    // Ownership transfer is a dedicated flow (auth::workspace_transfer, TBD)
    // that atomically updates workspace.owner_id and the grant.
    if (ws.owner_id === input.user_id && role !== 'owner') {
      throw new Error(
        `cannot demote workspace owner ${input.user_id} via role_grant; ` +
          `use an explicit ownership transfer flow`,
      );
    }
    const grant: RoleGrant = {
      workspace_id: input.workspace_id,
      user_id: input.user_id,
      role,
      granted_at: Date.now(),
    };
    await store.set(roleKey(input.workspace_id, input.user_id), grant);
    return { ok: true };
  },
);

iii.registerFunction(
  'auth::role_check',
  async (input: {
    workspace_id: string;
    user_id: string;
    required_role: string;
  }) => {
    const required = assertRole(input.required_role);
    const grant = await store.get<RoleGrant>(
      roleKey(input.workspace_id, input.user_id),
    );
    if (!grant) return { allowed: false };
    return { allowed: roleSatisfies(grant.role, required) };
  },
);

iii.registerFunction(
  'auth::role_list',
  async (input: { workspace_id: string }) => {
    // role:<workspace_id>:<user_id> keys already carry the workspace prefix,
    // so list can scan server-side with the exact prefix.
    const all = await store.list<unknown>(`role:${input.workspace_id}:`);
    const grants = all
      .filter(isRoleGrant)
      .filter((g) => g.workspace_id === input.workspace_id)
      .map((g) => ({
        user_id: g.user_id,
        role: g.role,
        granted_at: g.granted_at,
      }))
      .sort((a, b) => a.granted_at - b.granted_at);
    return { grants };
  },
);

log.info('auth worker registered');
