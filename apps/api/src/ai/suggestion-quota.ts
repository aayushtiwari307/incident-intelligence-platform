import type { SqlClient } from "../common/sql";

/**
 * The daily AI quota of an organization: ONE row per (organization, UTC day).
 *
 * Reservation is a single conditional upsert, so it is atomic without any application-side locking:
 *   - no row yet: the INSERT creates it with 1 (limit >= 1 is guaranteed by configuration)
 *   - row exists: the DO UPDATE ... WHERE only increments while requests_used < limit. If the WHERE is false PostgreSQL
 *     returns no row, which means "quota exhausted".
 * Concurrent reservations queue on the row lock; after waiting, the WHERE is re-evaluated against the committed value
 * (READ COMMITTED), so N parallel requests can never reserve more than the limit. The CHECK in migration 0012 is a last
 * line of defence, not the mechanism.
 *
 * The reservation runs inside the same transaction as the suggestion row and its job, so a request that fails for any
 * reason (duplicate in-flight, audit failure, crash) rolls the reservation back with everything else.
 * The day is the UTC date (documented in the UI as "per day, UTC").
 */
export async function reserveDailyQuota(tx: SqlClient, organizationId: string, limit: number): Promise<{ usageDate: string; used: number } | null> {
  if (!Number.isInteger(limit) || limit < 1) return null;
  const result = await tx.query<{ usage_date: string; requests_used: string | number }>(
    `INSERT INTO organization_ai_usage (organization_id, usage_date, requests_used)
     VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
     ON CONFLICT (organization_id, usage_date)
     DO UPDATE SET requests_used = organization_ai_usage.requests_used + 1
       WHERE organization_ai_usage.requests_used < $2::int
     RETURNING usage_date::text AS usage_date, requests_used`,
    [organizationId, limit],
  );
  const row = result.rows[0];
  return row ? { usageDate: row.usage_date, used: Number(row.requests_used) } : null;
}

/**
 * Gives one reservation back (the provider was never reached). The caller must have just flipped the suggestion's own
 * `quota_refunded` flag inside the same transaction (the UPDATE ... WHERE status IN ('queued','running') that marks it
 * failed): that status guard is what makes a refund happen at most once per request, even if two workers race.
 * `usageDate` is the day the request was CHARGED, so a refund after midnight UTC credits the right day.
 */
export async function refundDailyQuota(tx: SqlClient, organizationId: string, usageDate: string): Promise<void> {
  await tx.query(
    `UPDATE organization_ai_usage SET requests_used = requests_used - 1
      WHERE organization_id = $1 AND usage_date = $2::date AND requests_used > 0`,
    [organizationId, usageDate],
  );
}

export async function usedToday(db: SqlClient, organizationId: string): Promise<number> {
  const result = await db.query<{ requests_used: string | number }>(
    "SELECT requests_used FROM organization_ai_usage WHERE organization_id = $1 AND usage_date = (now() AT TIME ZONE 'UTC')::date",
    [organizationId],
  );
  return result.rows[0] ? Number(result.rows[0].requests_used) : 0;
}

/** Seconds until the next UTC midnight (for Retry-After when the quota is exhausted). */
export function secondsUntilUtcMidnight(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}
