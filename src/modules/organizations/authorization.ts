/**
 * ServiceOS /organizations authorization core (WORK-002, module internal).
 *
 * THE ONE AUTHORIZATION CHAIN (architecture-lock "one authorization chain",
 * authority-matrix "tenant scope: /organizations + authorization contract").
 *
 * This file is the only place in ServiceOS where a role is translated into a
 * capability decision. Every guarded route, every module mutation and the
 * public `authorize` entry point resolve permissions through
 * `roleAllows`. Any other module exporting a permission/capability decision
 * entry point is an architecture violation (structural checks
 * `second-authorization-engine`).
 *
 * Capability model (deterministic, frozen for WORK-002):
 * - action `read`      — observe organization/tenant directory data
 * - action `write`     — tenant-scoped customer-domain data operations
 *                        (reserved for later Work Orders; the capability
 *                        exists so tenant-scoped modules can be authorized)
 * - action `administer`— manage tenants, members, service accounts
 *
 * Role → capability:
 *   viewer  → read
 *   member  → read, write
 *   admin   → read, write, administer
 *   owner   → read, write, administer (+ governance protections: last-active-
 *             owner rule and exclusive owner-role management, enforced in the
 *             membership operations, not in this matrix)
 */
import type { Role } from './store.js';

export type TenancyAction = 'read' | 'write' | 'administer';

export const ROLES: readonly Role[] = ['owner', 'admin', 'member', 'viewer'];

export const TENANCY_ACTIONS: readonly TenancyAction[] = ['read', 'write', 'administer'];

/**
 * The capability matrix. Single source of truth; exported read-only for
 * structural proof tests, never for other modules to re-implement decisions.
 */
export const ROLE_CAPABILITIES: Readonly<Record<Role, ReadonlySet<TenancyAction>>> = Object.freeze({
  owner: Object.freeze(new Set<TenancyAction>(['read', 'write', 'administer'])),
  admin: Object.freeze(new Set<TenancyAction>(['read', 'write', 'administer'])),
  member: Object.freeze(new Set<TenancyAction>(['read', 'write'])),
  viewer: Object.freeze(new Set<TenancyAction>(['read'])),
});

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isTenancyAction(value: unknown): value is TenancyAction {
  return typeof value === 'string' && (TENANCY_ACTIONS as readonly string[]).includes(value);
}

/** The single role→capability decision function. */
export function roleAllows(role: Role, action: TenancyAction): boolean {
  return ROLE_CAPABILITIES[role].has(action);
}

/**
 * Roles a machine (service-account) principal may hold. Machine credentials
 * can never gain `administer`-grade or ownership capabilities (AC-5): an API
 * key maps to a principal whose grants come from the same membership chain,
 * and the chain structurally refuses owner/admin for machines.
 */
export const MACHINE_ALLOWED_ROLES: readonly Role[] = ['member', 'viewer'];

export function roleAllowedForMachine(role: Role): boolean {
  return MACHINE_ALLOWED_ROLES.includes(role);
}
