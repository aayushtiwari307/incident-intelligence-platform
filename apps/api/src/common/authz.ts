import { can, type Action } from "@platform/shared";
import type { AuthContext } from "../auth/auth.service";
import { forbidden } from "./errors";

/**
 * The organization every tenant query is scoped to. It comes from the authenticated session, NEVER from the
 * request: there is no code path where a client chooses which organization's data it reads.
 */
export function activeOrganization(auth: AuthContext): string {
  if (!auth.organizationId) throw forbidden("No active organization. Select or create one first.");
  return auth.organizationId;
}

/** Throws 403 unless the caller's role in the active organization allows the action. Returns the organization id. */
export function authorize(auth: AuthContext, action: Action): string {
  const organizationId = activeOrganization(auth);
  if (!can(auth.role, action)) throw forbidden();
  return organizationId;
}
