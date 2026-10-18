import type { IncidentSeverity } from "@platform/shared";
import type { SqlClient } from "../common/sql";
import { num } from "../common/sql-helpers";
import type { IncidentService } from "../incidents/incident.service";
import { assembleSuggestionContext, type SuggestionContext } from "./suggestion-context";

interface CurrentRow {
  id: string;
  title: string;
  description: string;
  severity: IncidentSeverity;
  status: string;
  version: string | number;
  root_cause: string | null;
  fix_applied: string | null;
}

/**
 * Loads the incident and its similar incidents for ONE organization and assembles the redacted, bounded context.
 * The organization comes from the caller (a job row the server wrote), every query filters by it, and the similar
 * incidents come from the same organization-scoped retrieval as the "Similar incidents" panel (resolved incidents only,
 * the incident itself excluded). Returns null when the incident does not exist in that organization.
 */
export async function loadSuggestionContext(
  db: SqlClient,
  incidents: Pick<IncidentService, "similarForOrganization">,
  organizationId: string,
  incidentId: string,
): Promise<SuggestionContext | null> {
  const found = await db.query<CurrentRow>(
    `SELECT i.id, i.title, i.description, i.severity, i.status, i.version, r.root_cause, r.fix_applied
       FROM incidents i
       LEFT JOIN incident_resolutions r ON r.organization_id = i.organization_id AND r.incident_id = i.id
      WHERE i.organization_id = $1 AND i.id = $2`,
    [organizationId, incidentId],
  );
  const current = found.rows[0];
  if (!current) return null;

  const similar = await incidents.similarForOrganization(organizationId, incidentId);
  return assembleSuggestionContext(
    {
      incidentId: current.id,
      title: current.title,
      description: current.description,
      rootCause: current.root_cause,
      fixApplied: current.fix_applied,
      severity: current.severity,
      status: current.status,
      version: num(current.version),
    },
    similar.map((s) => ({ incidentId: s.id, title: s.title, description: s.description, rootCause: s.rootCause, fixApplied: s.fixApplied })),
  );
}
