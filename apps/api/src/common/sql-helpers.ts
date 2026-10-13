/**
 * Values must look the same whichever PostgreSQL driver is used (the real `pg` returns Date/number/boolean
 * objects, a simpler driver returns text). So timestamps are selected as explicit ISO-8601 UTC strings, and
 * numbers/JSON are normalised by the mappers below instead of relying on driver type parsing.
 */
export const iso = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const num = (value: unknown): number => Number(value);

export const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

export function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  return (value ?? {}) as Record<string, unknown>;
}
