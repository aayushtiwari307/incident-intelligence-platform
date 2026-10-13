import { z } from "zod";

/** Organization roles, lowest privilege first. Mirrors the CHECK constraint on memberships.role. */
export const ORG_ROLES = ["viewer", "responder", "admin", "owner"] as const;

export type OrgRole = (typeof ORG_ROLES)[number];

export const orgRoleSchema = z.enum(ORG_ROLES);

const RANK: Record<OrgRole, number> = { viewer: 1, responder: 2, admin: 3, owner: 4 };

/** True when `actual` grants at least the privileges of `required`. */
export function roleAtLeast(actual: OrgRole, required: OrgRole): boolean {
  return RANK[actual] >= RANK[required];
}
