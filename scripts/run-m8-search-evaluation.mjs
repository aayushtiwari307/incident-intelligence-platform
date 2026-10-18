import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  BOOTSTRAP_RESAMPLES,
  BOOTSTRAP_SEED,
  CONFIGURATIONS,
  buildEvaluationSearchSql,
  buildEvaluationQueries,
  chooseDevelopmentWinner,
  chooseStrongestAlternative,
  calculateQueryMetrics,
  groupedBootstrapDifference,
  groupedBootstrapIntervals,
  scoreGate,
  summarizeMetrics,
  validateCorpus,
} from "./lib/m8-search-evaluation.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpusPath = path.join(__dirname, "..", "docs", "verification", "m8-retrieval-corpus.json");
const databaseUrl = process.env.M8_EVAL_DATABASE_URL;

if (!databaseUrl) {
  throw new Error("Set M8_EVAL_DATABASE_URL to a verified disposable PostgreSQL database before running this evaluation.");
}

const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
const corpusSummary = validateCorpus(corpus);
const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, application_name: "m8-retrieval-evaluation" });

function splitSummary(split) {
  const records = corpus.records.filter((record) => record.split === split);
  const scenarioCount = new Set(records.map((record) => record.scenarioId)).size;
  return {
    scenarios: scenarioCount,
    queries: records.length,
    candidatePoolSize: corpus.records.length,
    candidatesPerQuery: corpus.records.length - 1,
    candidatePairs: records.length * (corpus.records.length - 1),
    relevantItemsPerQuery: records.length === 0 ? 0 : records.length / scenarioCount - 1,
  };
}

async function evaluateSplit(split) {
  const queries = buildEvaluationQueries(corpus.records, split);
  const candidateIds = new Set(corpus.records.filter((record) => record.status === "resolved").map((record) => record.id));
  for (const query of queries) {
    if (query.candidateIds.length !== candidateIds.size - 1 || query.candidateIds.some((id) => !candidateIds.has(id))) {
      throw new Error(`Query ${query.sourceId} does not use the complete resolved corpus candidate pool`);
    }
  }
  const rankings = new Map();
  for (const query of queries) {
    for (const configuration of CONFIGURATIONS) {
      if (!rankings.has(configuration.id)) rankings.set(configuration.id, new Map());
      const configRankings = rankings.get(configuration.id);
      if (query.terms.length === 0) {
        configRankings.set(query.sourceId, []);
        continue;
      }
      const sql = buildEvaluationSearchSql(configuration, query.sourceId, query.terms);
      const result = await client.query(sql.text, sql.values);
      configRankings.set(query.sourceId, result.rows.map((row) => row.id).slice(0, 5));
    }
  }
  const results = CONFIGURATIONS.map((configuration) => {
    const metrics = summarizeMetrics(queries, rankings.get(configuration.id));
    const confidenceIntervals = groupedBootstrapIntervals(metrics.perQuery);
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
        confidenceIntervals,
      },
    };
  });
  return { results, rankings };
}

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
        setweight(to_tsvector('simple'::regconfig, coalesce(input.fix_applied, '')), 'C') AS simple_vector,
      setweight(to_tsvector('english'::regconfig, coalesce(input.title, '')), 'A') AS title_vector
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

  const development = await evaluateSplit("development");
  const selectedConfiguration = chooseDevelopmentWinner(development.results);
  const strongestAlternative = chooseStrongestAlternative(development.results, selectedConfiguration);
  const heldOut = await evaluateSplit("held-out");
  const selectedHeldOut = heldOut.results.find((result) => result.configuration === selectedConfiguration);
  const baselineHeldOut = heldOut.results.find((result) => result.configuration === strongestAlternative);
  const heldOutQueries = buildEvaluationQueries(corpus.records, "held-out");
  const selectedPerQuery = calculateQueryMetrics(heldOutQueries, heldOut.rankings.get(selectedConfiguration));
  const baselinePerQuery = calculateQueryMetrics(heldOutQueries, heldOut.rankings.get(strongestAlternative));
  const gate = {
    ...scoreGate(selectedHeldOut.metrics, baselineHeldOut.metrics),
    pairedScenarioBootstrap95PercentDifferenceInterval: groupedBootstrapDifference(selectedPerQuery, baselinePerQuery),
  };

  await client.query("ROLLBACK");
  const report = {
    corpus: {
      file: "docs/verification/m8-retrieval-corpus.json",
      authoring: corpus.authoring,
      relevanceRule: corpus.relevanceRule,
      seed: corpus.seed,
      ...corpusSummary,
      development: splitSummary("development"),
      heldOut: splitSummary("held-out"),
    },
    postgres: {
      database: server.rows[0].database,
      address: server.rows[0].address,
      port: server.rows[0].port,
      version: server.rows[0].version,
      effects: "All evaluation rows and indexes used temporary objects inside a rolled-back transaction.",
    },
    method: {
      configurations: CONFIGURATIONS,
      normalization: "Production-equivalent Unicode letter/digit tokenization, en-US lowercase, unique terms, <=64 code units, first 12 terms.",
      fullText: "Prefix OR tsquery, weighted A/B/C/C vectors, ts_rank_cd normalization 32, resolved-only candidates, self-exclusion, top five, then resolved_at DESC and incident number DESC tie-breaks.",
      titleOnly: "English vector over title only, same query terms, PostgreSQL rank, production tie-breaks.",
      newestFirst: "Resolved_at DESC, incident number DESC.",
      andMatch: "Weighted English vector with all sanitized prefix terms joined by AND.",
      differences: "Development and held-out source queries are evaluated separately, but each searches the same full 48-incident resolved corpus, excluding itself (47 candidates per query). Split and scenario labels are kept in JavaScript metadata and are not loaded into PostgreSQL. Each split applies first-five truncation in JavaScript after database ordering; production applies LIMIT 5 in SQL. This is ranking-equivalent for this corpus.",
      protocolCorrection: "Earlier held-out results were inspected under a split-restricted candidate pool. This corrected candidate-pool run is protocol-corrected, not previously unseen confirmatory evidence.",
      metrics: "Macro-average per query. Recall@5 = relevant results in top five / all relevant candidates. Precision@5 = relevant results in top five / 5. MRR = reciprocal rank of first relevant result; zero if none. Queries with no relevant candidates contribute zero to all metrics.",
      confidenceIntervals: `Scenario-cluster bootstrap percentile 95% intervals (${BOOTSTRAP_RESAMPLES} resamples, seed ${BOOTSTRAP_SEED}); scenarios sampled with replacement, retaining all query rows in each sampled scenario.`,
      selection: "Selected on development by Recall@5, then MRR, then Precision@5; fixed configuration list order breaks remaining ties. Strongest alternative selected on development using the same ordering. Held-out outcomes are not used for selection.",
      acceptance: "Predeclared gate: selected Recall@5 >= 0.70 and at least +0.10 absolute Recall@5 over the strongest alternative selected on development.",
    },
    development: development.results,
    selectedConfiguration,
    strongestAlternative,
    heldOut: heldOut.results,
    gate,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original evaluation failure; the connection closes below and removes temp objects.
  }
  throw error;
} finally {
  await client.end();
}
