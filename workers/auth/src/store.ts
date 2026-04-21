import type { Role } from './roles.js';

export const SCOPE = 'auth';

export type Workspace = {
  id: string;
  name: string;
  owner_id: string;
  created_at: number;
};

export type ApiKey = {
  id: string;
  workspace_id: string;
  role: Role;
  hash: string;
  description?: string;
  created_by?: string;
  created_at: number;
  last_used_at?: number;
  revoked_at?: number;
};

export type RoleGrant = {
  workspace_id: string;
  user_id: string;
  role: Role;
  granted_at: number;
};

export const workspaceKey = (id: string) => `workspace:${id}`;
export const keyKey = (id: string) => `key:${id}`;
export const keyLookupKey = (prefix: string) => `key_lookup:${prefix}`;
export const roleKey = (workspaceId: string, userId: string) =>
  `role:${workspaceId}:${userId}`;

export type Trigger = (args: {
  function_id: string;
  payload: unknown;
}) => Promise<unknown>;

export function makeStore(trigger: Trigger) {
  const set = (key: string, value: unknown) =>
    trigger({ function_id: 'state::set', payload: { scope: SCOPE, key, value } });

  const get = async <T>(key: string): Promise<T | null> =>
    ((await trigger({ function_id: 'state::get', payload: { scope: SCOPE, key } })) as
      | T
      | null) ?? null;

  const list = async <T>(): Promise<T[]> => {
    const v = await trigger({ function_id: 'state::list', payload: { scope: SCOPE } });
    return Array.isArray(v) ? (v as T[]) : [];
  };

  const del = (key: string) =>
    trigger({ function_id: 'state::delete', payload: { scope: SCOPE, key } });

  return { set, get, list, del };
}

export type Store = ReturnType<typeof makeStore>;
