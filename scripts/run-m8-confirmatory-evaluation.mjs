import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  BOOTSTRAP_RESAMPLES,
  BOOTSTRAP_SEED,
  CONFIRMATION_CONFIGURATIONS,
  buildConfirmatoryQueries,
  buildEvaluationSearchSql,
  groupedBootstrapDifference,
  groupedBootstrapIntervals,
  scoreGate,
  summarizeMetrics,
  validateConfirmatoryCorpus,
} from "./lib/m8-search-evaluation.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpusPath = path.join(__dirname, "..", "docs", "verification", "m8-confirmatory-retrieval-corpus.json");
const databaseUrl = process.env.M8_CONFIRM_DATABASE_URL;

if (!databaseUrl) {
  throw new Error("Set M8_CONFIRM_DATABASE_URL to a verified disposable PostgreSQL database before running confirmation.");
}

const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
const corpusSummary = validateConfirmatoryCorpus(corpus);
const queries = buildConfirmatoryQueries(corpus.records);
const expectedCandidateIds = new Set(corpus.records.map(({ id }) => id));
for (const query of queries) {
  if (
    query.candidateIds.length !== corpus.records.length - 1 ||
    query.candidateIds.some((id) => !expectedCandidateIds.has(id) || id === query.sourceId) ||
    query.relevantIds.length !== 3
  ) {
    throw new Error(`Confirmatory query ${query.sourceId} violates full-pool, self-exclusion, or relevance invariants`);
  }
}

const client = new pg.Client({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 5000,
  application_name: "m8-confirmatory-retrieval-evaluation",
});

try {
  await client.connect();
  const server = await client.query(
    "SELECT current_database() AS database, inet_server_addr()::text AS address, inet_server_port() AS port, version() AS version",
  );
  await client.query("BEGIN");
  await client.query(`
    CREATE TEMP TABLE m8_eval_incidents ON COMMIT DROP AS
    SELECT
      input.id,
      input.incident_number,
      input.resolved_at,
      input.status,
      input.title,
      input.description,
      input.root_cause,
      input.fix_applied,
      setweight(to_tsvector('english'::regconfig, coalesce(input.title, '')), 'A') ||
        setweight(to_tsvector('english'::regconfig, coalesce(input.description, '')), 'B') ||
        setweight(to_tsvector('english'::regconfig, coalesce(input.root_cause, '')), 'C') ||
        setweight(to_tsvector('english'::regconfig, coalesce(input.fix_applied, '')), 'C') AS english_vector,
      setweight(to_tsvector('simple'::regconfig, coalesce(input.title, '')), 'A') ||
        setweight(to_tsvector('simple'::regconfig, coalesce(input.description, '')), 'B') ||
        setweight(to_tsvector('simple'::regconfig, coalesce(input.root_cause, '')), 'C') ||
        setweight(to_tsvector('simple'::regconfig, coalesce(input.fix_applied, '')), 'C') AS simple_vector
    FROM jsonb_to_recordset($1::jsonb) AS input(
      id uuid,
      incident_number integer,
      resolved_at timestamptz,
      status text,
      title text,
      description text,
      root_cause text,
      fix_applied text
    )`,
    [
      JSON.stringify(
        corpus.records.map((record) => ({
          id: record.id,
          incident_number: record.number,
          resolved_at: record.resolvedAt,
          status: record.status,
          title: record.incident.title,
          description: record.incident.description,
          root_cause: record.incident.rootCause,
          fix_applied: record.incident.fixApplied,
        })),
      ),
    ],
  );
  await client.query("CREATE INDEX ON m8_eval_incidents USING gin (english_vector)");
  await client.query("CREATE INDEX ON m8_eval_incidents USING gin (simple_vector)");
  await client.query("ANALYZE m8_eval_incidents");

  const rankings = new Map(CONFIRMATION_CONFIGURATIONS.map(({ id }) => [id, new Map()]));
  for (const query of queries) {
    for (const configuration of CONFIRMATION_CONFIGURATIONS) {
      if (query.terms.length === 0) {
        rankings.get(configuration.id).set(query.sourceId, []);
        continue;
      }
      const sql = buildEvaluationSearchSql(configuration, query.sourceId, query.terms);
      const result = await client.query(sql.text, sql.values);
      rankings.get(configuration.id).set(query.sourceId, result.rows.map(({ id }) => id).slice(0, 5));
    }
  }

  const results = CONFIRMATION_CONFIGURATIONS.map((configuration) => {
    const metrics = summarizeMetrics(queries, rankings.get(configuration.id));
    return {
      configuration: configuration.id,
      metrics: {
        queryCount: metrics.queryCount,
        candidateCountPerQuery: metrics.candidateCountPerQuery,
        relevantItemCount: metrics.relevantItemCount,
        queriesWithoutRelevantCandidates: metrics.queriesWithoutRelevantCandidates,
        queriesWithoutSearchTerms: metrics.queriesWithoutSearchTerms,
        recallAt5: metrics.recallAt5,
        precisionAt5: metrics.precisionAt5,
        mrr: metrics.mrr,
        confidenceIntervals: groupedBootstrapIntervals(metrics.perQuery),
      },
    };
  });

  const englishRows = summarizeMetrics(queries, rankings.get("weighted-english")).perQuery;
  const simpleRows = summarizeMetrics(queries, rankings.get("weighted-simple")).perQuery;
  const weightedEnglish = results.find(({ configuration }) => configuration === "weighted-english");
  const weightedSimple = results.find(({ configuration }) => configuration === "weighted-simple");
  const gate = {
    ...scoreGate(weightedEnglish.metrics, weightedSimple.metrics),
    pairedScenarioBootstrap95PercentDifferenceInterval: groupedBootstrapDifference(englishRows, simpleRows),
  };

  await client.query("ROLLBACK");
  const report = {
    corpus: {
      file: "docs/verification/m8-confirmatory-retrieval-corpus.json",
      authoring: corpus.authoring,
      relevanceRule: corpus.relevanceRule,
      seed: corpus.seed,
      ...corpusSummary,
      queryCount: queries.length,
      candidatePoolSize: corpus.records.length,
      candidatesPerQuery: corpus.records.length - 1,
      candidatePairs: queries.reduce((sum, query) => sum + query.candidateIds.length, 0),
      relevantItemCount: queries.reduce((sum, query) => sum + query.relevantIds.length, 0),
    },
    postgres: {
      database: server.rows[0].database,
      address: server.rows[0].address,
      port: server.rows[0].port,
      version: server.rows[0].version,
      effects: "Temporary evaluation table and indexes were rolled back; no persistent database writes.",
    },
    protocol: {
      configurations: CONFIRMATION_CONFIGURATIONS,
      candidatePool: "All 32 resolved incidents for every query, excluding only the source incident; scenario IDs and labels are not loaded into PostgreSQL.",
      normalization: "Frozen production-equivalent Unicode tokenization, en-US lowercase, unique terms, <=64-code-unit terms, first 12 terms.",
      relevance: "Same-scenario membership; source excluded.",
      bootstrap: `Paired scenario-cluster bootstrap percentile 95% intervals (${BOOTSTRAP_RESAMPLES} resamples, seed ${BOOTSTRAP_SEED}).`,
      decision: "Frozen weighted English versus weighted simple; original gate remains Recall@5 >= 0.70 and at least +0.10 absolute Recall@5 improvement.",
      confirmationCaveat: "Fresh synthetic scenarios, but single-author labels. These results are not independent human annotation or production validation.",
    },
    results,
    gate,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original evaluation failure; connection close removes transaction-scoped objects.
  }
  throw error;
} finally {
  await client.end();
}
