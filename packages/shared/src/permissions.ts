import type { OrgRole } from "./roles";
import { roleAtLeast } from "./roles";

/** Everything a member can be allowed to do. Authorization is decided on the server from this table. */
export const ACTION_MIN_ROLE = {
  "incident:read": "viewer",
  "incident:create": "responder",
  "incident:update": "responder",
  "incident:transition": "responder",
  "incident:comment": "responder",
  "analysis:request": "responder",
  "member:list": "viewer",
  "member:invite": "admin",
  "member:remove": "admin",
  "member:setRole": "admin",
} as const satisfies Record<string, OrgRole>;

export type Action = keyof typeof ACTION_MIN_ROLE;

export function can(role: OrgRole | null | undefined, action: Action): boolean {
  return role != null && roleAtLeast(role, ACTION_MIN_ROLE[action]);
}

export interface RoleChange {
  actorRole: OrgRole;
  actorIsTarget: boolean;
  targetRole: OrgRole;
  newRole: OrgRole;
}

/**
 * Who may change whose role.
 *  - owners may change anyone's role, including promoting to owner
 *  - admins may only move non-owners between viewer/responder/admin
 *  - nobody changes their own role (an admin cannot promote themselves; handing over ownership is two steps)
 * The database separately guarantees that an organization never ends up without an owner.
 */
export function canChangeRole(change: RoleChange): boolean {
  if (!can(change.actorRole, "member:setRole")) return false;
  if (change.actorIsTarget) return false;
  if (change.actorRole === "owner") return true;
  return change.targetRole !== "owner" && change.newRole !== "owner";
}

/** Removing members follows the same rule as changing their role to "nothing". */
export function canRemoveMember(change: Omit<RoleChange, "newRole">): boolean {
  if (!can(change.actorRole, "member:remove")) return false;
  if (change.actorRole === "owner") return true;
  return !change.actorIsTarget && change.targetRole !== "owner";
}
