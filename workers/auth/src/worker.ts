import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { registerWorker, Logger } from 'iii-sdk';
import {
  generateToken,
  hashPrefix,
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
    await store.set(roleKey(id, input.owner_id), grant);
    return { workspace_id: id };
  },
);

iii.registerFunction(
  'auth::workspace_get',
  async (input: { workspace_id: string }) => {
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
    await store.set(keyLookupKey(hashPrefix(hash)), id);
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
    const all = await store.list<unknown>();
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
    const prefix = hashPrefix(incoming);
    const keyId = await store.get<string>(keyLookupKey(prefix));
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
    record.last_used_at = Date.now();
    await store.set(keyKey(record.id), record);
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
    const all = await store.list<unknown>();
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
