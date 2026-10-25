import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// Integrations (Milestone 7): organization-scoped credentials that let an external system (today: Prometheus
// Alertmanager) create and resolve incidents. There is deliberately NO organization id in any request schema:
// the organization of a management call comes from the session, and the organization of a webhook delivery comes
// from the validated credential record.

export const INTEGRATION_KINDS = ["alertmanager", "change-events"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

/** Hard cap on non-revoked integrations per organization (bounds credential sprawl). */
export const MAX_ACTIVE_INTEGRATIONS_PER_ORGANIZATION = 20;

/** Largest Alertmanager notification (alerts per HTTP request) accepted; configure `max_alerts` at or below this. */
export const ALERTMANAGER_MAX_ALERTS_PER_REQUEST = 50;

// Printable text only: no control characters (incl. newlines), no leading/trailing space (a DB CHECK repeats the length/trim rule).
// eslint-disable-next-line no-control-regex -- the point of the pattern is to reject control characters
const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]*$/;

export const integrationNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(60, "Name must be at most 60 characters")
  .regex(NO_CONTROL_CHARS, "Name must not contain control characters");

export const createIntegrationSchema = z.object({ name: integrationNameSchema, kind: z.enum(INTEGRATION_KINDS).default("alertmanager") }).strict();

export type IntegrationStatus = "active" | "revoked";

/** Metadata only. The token is never part of this shape: it exists in memory exactly once, in `CreatedIntegrationDto`. */
export interface IntegrationDto {
  id: string;
  kind: IntegrationKind;
  name: string;
  status: IntegrationStatus;
  createdAt: string;
  createdBy: { id: string; displayName: string } | null;
  rotatedAt: string | null;
  rotatedBy: { id: string; displayName: string } | null;
  revokedAt: string | null;
  revokedBy: { id: string; displayName: string } | null;
  lastUsedAt: string | null;
}

/** Returned once by create and once by each rotation. The plaintext token cannot be retrieved afterwards. */
export interface CreatedIntegrationDto extends IntegrationDto {
  token: string;
}

// ---------------------------------------------------------------------------------------------
// Webhook response (what the SENDER receives after a committed delivery).

export const ALERT_DELIVERY_RESULTS = [
  "created", // first firing delivery of a cycle: one incident was created
  "duplicate", // repeated firing delivery of a known cycle: counters only
  "resolved", // firing -> resolved: the incident was resolved
  "duplicate_resolved", // repeated resolved delivery
  "ignored_unknown_resolution", // first notification is resolved: record a tombstone, but create no incident
  "ignored_stale_firing", // firing delivery for a cycle already resolved: acknowledged, never reopens
] as const;
export type AlertDeliveryResult = (typeof ALERT_DELIVERY_RESULTS)[number];

export interface AlertDeliveryItem {
  fingerprint: string;
  startsAt: string;
  result: AlertDeliveryResult;
  incidentId: string | null;
  incidentNumber: number | null;
  /** Deliveries recorded for this cycle including this one; null only when no cycle row exists. */
  deliveryCount: number | null;
}

export interface AlertWebhookResponse {
  accepted: number;
  created: number;
  resolved: number;
  duplicates: number;
  ignored: number;
  results: AlertDeliveryItem[];
}
