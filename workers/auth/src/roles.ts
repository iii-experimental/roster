export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export const ROLES: readonly Role[] = ['owner', 'admin', 'member', 'viewer'];

const RANK: Record<Role, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

export function isRole(x: unknown): x is Role {
  return typeof x === 'string' && (ROLES as readonly string[]).includes(x);
}

export function assertRole(x: unknown): Role {
  if (!isRole(x)) {
    throw new Error(`invalid role: ${String(x)}. expected one of ${ROLES.join(', ')}`);
  }
  return x;
}

// required <= granted
export function roleSatisfies(granted: Role, required: Role): boolean {
  return RANK[granted] >= RANK[required];
}
