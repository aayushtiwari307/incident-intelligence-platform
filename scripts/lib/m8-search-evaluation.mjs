export const MAX_SEARCH_TERMS = 12;
export const TOP_K = 5;
export const BOOTSTRAP_RESAMPLES = 2000;
export const BOOTSTRAP_SEED = 20261017;

export const CONFIGURATIONS = [
  { id: "newest-first", label: "Newest-first", kind: "newest" },
  { id: "title-only-english", label: "Title-only English FTS", kind: "title" },
  { id: "weighted-english", label: "Weighted English FTS (production)", kind: "english" },
  { id: "weighted-simple", label: "Weighted simple FTS", kind: "simple" },
  { id: "weighted-english-and", label: "Weighted English AND-match", kind: "and" },
];

export const CONFIRMATION_CONFIGURATIONS = Object.freeze(
  CONFIGURATIONS.filter(({ id }) => ["weighted-english", "weighted-simple"].includes(id)),
);

export function normalizeSearchTerms(text) {
  return [...new Set(text.match(/[\p{L}\p{N}]+/gu)?.map((term) => term.toLocaleLowerCase("en-US")) ?? [])]
    .filter((term) => term.length <= 64)
    .slice(0, MAX_SEARCH_TERMS);
}

export function searchText(incident) {
  return [incident.title, incident.description, incident.rootCause ?? "", incident.fixApplied ?? ""].join(" ");
}

export function buildEvaluationQueries(records, split) {
  const queries = records.filter((record) => record.split === split);
  return queries.map((source) => {
    const eligible = records.filter((candidate) => candidate.id !== source.id && candidate.status === "resolved");
    return {
      sourceId: source.id,
      scenarioId: source.scenarioId,
      split: source.split,
      terms: normalizeSearchTerms(searchText(source.incident)),
      candidateIds: eligible.map((candidate) => candidate.id),
      relevantIds: eligible.filter((candidate) => candidate.scenarioId === source.scenarioId).map((candidate) => candidate.id),
    };
  });
}

export function buildConfirmatoryQueries(records) {
  return records.map((source) => {
    const eligible = records.filter((candidate) => candidate.id !== source.id && candidate.status === "resolved");
    return {
      sourceId: source.id,
      scenarioId: source.scenarioId,
      terms: normalizeSearchTerms(searchText(source.incident)),
      candidateIds: eligible.map((candidate) => candidate.id),
      relevantIds: eligible.filter((candidate) => candidate.scenarioId === source.scenarioId).map((candidate) => candidate.id),
    };
  });
}

export function selectTopFive(rankedIds, sourceId) {
  return rankedIds.filter((id) => id !== sourceId).slice(0, TOP_K);
}

export function queryString(terms, mode = "or") {
  const joiner = mode === "and" ? " & " : " | ";
  return terms.map((term) => `${term}:*`).join(joiner);
}

const VECTOR_BY_KIND = {
  title: "title_vector",
  english: "english_vector",
  simple: "simple_vector",
  and: "english_vector",
};

const CONFIG_BY_KIND = {
  title: "english",
  english: "english",
  simple: "simple",
  and: "english",
};

export function buildEvaluationSearchSql(configuration, sourceId, terms) {
  if (configuration.kind === "newest") {
    return {
      text: `SELECT id::text AS id FROM m8_eval_incidents
             WHERE id <> $1::uuid AND status = 'resolved'
             ORDER BY resolved_at DESC, incident_number DESC`,
      values: [sourceId],
    };
  }
  const vector = VECTOR_BY_KIND[configuration.kind];
  const config = CONFIG_BY_KIND[configuration.kind];
  if (!vector || !config) throw new Error(`Unsupported evaluation configuration: ${configuration.kind}`);
  const tsquery = queryString(terms, configuration.kind === "and" ? "and" : "or");
  return {
    text: `WITH q AS (SELECT to_tsquery('${config}'::regconfig, $2) AS value)
           SELECT candidate.id::text AS id
             FROM m8_eval_incidents candidate CROSS JOIN q
            WHERE candidate.id <> $1::uuid
              AND candidate.status = 'resolved'
              AND numnode(q.value) > 0
              AND candidate.${vector} @@ q.value
            ORDER BY ts_rank_cd(candidate.${vector}, q.value, 32) DESC,
                     candidate.resolved_at DESC,
                     candidate.incident_number DESC`,
    values: [sourceId, tsquery],
  };
}

export function calculateQueryMetrics(queries, rankingsBySource) {
  return queries.map((query) => {
    const relevant = new Set(query.relevantIds);
    const top = selectTopFive(rankingsBySource.get(query.sourceId) ?? [], query.sourceId);
    const found = top.filter((id) => relevant.has(id)).length;
    const firstRelevant = top.findIndex((id) => relevant.has(id));
    return {
      sourceId: query.sourceId,
      scenarioId: query.scenarioId,
      recallAt5: relevant.size === 0 ? 0 : found / relevant.size,
      precisionAt5: found / TOP_K,
      reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
    };
  });
}

export function summarizeMetrics(queries, rankingsBySource) {
  const perQuery = calculateQueryMetrics(queries, rankingsBySource);
  const mean = (field) => (perQuery.length === 0 ? 0 : perQuery.reduce((sum, row) => sum + row[field], 0) / perQuery.length);
  return {
    queryCount: queries.length,
    candidateCountPerQuery: queries.length === 0 ? 0 : queries.reduce((sum, query) => sum + query.candidateIds.length, 0) / queries.length,
    relevantItemCount: queries.reduce((sum, query) => sum + query.relevantIds.length, 0),
    queriesWithoutRelevantCandidates: queries.filter((query) => query.relevantIds.length === 0).length,
    queriesWithoutSearchTerms: queries.filter((query) => query.terms?.length === 0).length,
    recallAt5: mean("recallAt5"),
    precisionAt5: mean("precisionAt5"),
    mrr: mean("reciprocalRank"),
    perQuery,
  };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return 0;
  const position = (sortedValues.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sortedValues[lower];
  const upperValue = sortedValues[upper];
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

export function groupedBootstrapIntervals(perQuery, resamples = BOOTSTRAP_RESAMPLES, seed = BOOTSTRAP_SEED) {
  const groups = new Map();
  for (const row of perQuery) {
    const group = groups.get(row.scenarioId) ?? [];
    group.push(row);
    groups.set(row.scenarioId, group);
  }
  if (groups.size === 0) {
    return {
      recallAt5: { low: 0, high: 0 },
      precisionAt5: { low: 0, high: 0 },
      mrr: { low: 0, high: 0 },
    };
  }
  const groupedRows = [...groups.values()];
  const random = seededRandom(seed);
  const samples = { recallAt5: [], precisionAt5: [], mrr: [] };
  for (let iteration = 0; iteration < resamples; iteration += 1) {
    const rows = [];
    for (let draw = 0; draw < groupedRows.length; draw += 1) {
      const picked = groupedRows[Math.floor(random() * groupedRows.length)];
      rows.push(...picked);
    }
    for (const [metric, key] of [["recallAt5", "recallAt5"], ["precisionAt5", "precisionAt5"], ["mrr", "reciprocalRank"]]) {
      samples[metric].push(rows.reduce((sum, row) => sum + row[key], 0) / rows.length);
    }
  }
  return Object.fromEntries(
    Object.entries(samples).map(([metric, values]) => {
      values.sort((a, b) => a - b);
      return [metric, { low: percentile(values, 0.025), high: percentile(values, 0.975) }];
    }),
  );
}

export function groupedBootstrapDifference(leftRows, rightRows, resamples = BOOTSTRAP_RESAMPLES, seed = BOOTSTRAP_SEED) {
  const rightBySource = new Map(rightRows.map((row) => [row.sourceId, row]));
  const groups = new Map();
  for (const left of leftRows) {
    const right = rightBySource.get(left.sourceId);
    if (!right) throw new Error(`Missing paired metric row for query ${left.sourceId}`);
    if (left.scenarioId !== right.scenarioId) throw new Error(`Paired query ${left.sourceId} has inconsistent scenario labels`);
    const values = groups.get(left.scenarioId) ?? [];
    values.push({
      recallAt5: left.recallAt5 - right.recallAt5,
      precisionAt5: left.precisionAt5 - right.precisionAt5,
      reciprocalRank: left.reciprocalRank - right.reciprocalRank,
    });
    groups.set(left.scenarioId, values);
  }
  if (groups.size === 0) {
    return {
      recallAt5: { low: 0, high: 0 },
      precisionAt5: { low: 0, high: 0 },
      mrr: { low: 0, high: 0 },
    };
  }
  const groupedRows = [...groups.values()];
  const random = seededRandom(seed);
  const samples = { recallAt5: [], precisionAt5: [], mrr: [] };
  for (let iteration = 0; iteration < resamples; iteration += 1) {
    const rows = [];
    for (let draw = 0; draw < groupedRows.length; draw += 1) {
      rows.push(...groupedRows[Math.floor(random() * groupedRows.length)]);
    }
    for (const [metric, key] of [["recallAt5", "recallAt5"], ["precisionAt5", "precisionAt5"], ["mrr", "reciprocalRank"]]) {
      samples[metric].push(rows.reduce((sum, row) => sum + row[key], 0) / rows.length);
    }
  }
  return Object.fromEntries(
    Object.entries(samples).map(([metric, values]) => {
      values.sort((a, b) => a - b);
      return [metric, { low: percentile(values, 0.025), high: percentile(values, 0.975) }];
    }),
  );
}

export function chooseDevelopmentWinner(results) {
  return [...results].sort(
    (left, right) =>
      right.metrics.recallAt5 - left.metrics.recallAt5 ||
      right.metrics.mrr - left.metrics.mrr ||
      right.metrics.precisionAt5 - left.metrics.precisionAt5 ||
      CONFIGURATIONS.findIndex((config) => config.id === left.configuration) -
        CONFIGURATIONS.findIndex((config) => config.id === right.configuration),
  )[0]?.configuration;
}

export function chooseStrongestAlternative(results, winner) {
  return [...results]
    .filter((result) => result.configuration !== winner)
    .sort(
      (left, right) =>
        right.metrics.recallAt5 - left.metrics.recallAt5 ||
        right.metrics.mrr - left.metrics.mrr ||
        right.metrics.precisionAt5 - left.metrics.precisionAt5 ||
        CONFIGURATIONS.findIndex((config) => config.id === left.configuration) -
          CONFIGURATIONS.findIndex((config) => config.id === right.configuration),
    )[0]?.configuration;
}

export function validateCorpus(corpus) {
  if (!corpus || !Array.isArray(corpus.records)) throw new Error("Corpus must contain a records array");
  const ids = new Set();
  const scenarioSplits = new Map();
  const scenarios = new Set();
  for (const record of corpus.records) {
    if (!record.id || ids.has(record.id)) throw new Error(`Missing or duplicate incident id: ${record.id}`);
    ids.add(record.id);
    if (!record.scenarioId || !["development", "held-out"].includes(record.split)) {
      throw new Error(`Invalid scenario metadata for incident ${record.id}`);
    }
    const previousSplit = scenarioSplits.get(record.scenarioId);
    if (previousSplit && previousSplit !== record.split) throw new Error(`Scenario ${record.scenarioId} crosses evaluation splits`);
    scenarioSplits.set(record.scenarioId, record.split);
    scenarios.add(record.scenarioId);
    for (const field of ["title", "description", "rootCause", "fixApplied"]) {
      if (typeof record.incident?.[field] !== "string") throw new Error(`Missing incident.${field} for ${record.id}`);
    }
    if (record.status !== "resolved") throw new Error(`Corpus incident ${record.id} must be resolved`);
    const searchable = searchText(record.incident).toLocaleLowerCase("en-US");
    if (searchable.includes(record.scenarioId.toLocaleLowerCase("en-US"))) {
      throw new Error(`Scenario label leaks into searchable text for ${record.id}`);
    }
  }
  if (scenarios.size !== 12) throw new Error(`Expected 12 scenarios; received ${scenarios.size}`);
  for (const [scenarioId] of scenarioSplits) {
    const size = corpus.records.filter((record) => record.scenarioId === scenarioId).length;
    if (size < 3 || size > 5) throw new Error(`Scenario ${scenarioId} has ${size} incidents; expected 3-5`);
  }
  const developmentScenarios = [...scenarioSplits.values()].filter((split) => split === "development").length;
  const heldOutScenarios = [...scenarioSplits.values()].filter((split) => split === "held-out").length;
  if (developmentScenarios !== 8 || heldOutScenarios !== 4) {
    throw new Error(`Expected eight development and four held-out scenarios; received ${developmentScenarios} and ${heldOutScenarios}`);
  }
  for (const split of ["development", "held-out"]) {
    if (!corpus.records.some((record) => record.split === split)) throw new Error(`Missing ${split} records`);
  }
  return { scenarioCount: scenarios.size, recordCount: corpus.records.length };
}

export function validateConfirmatoryCorpus(corpus) {
  if (!corpus || !Array.isArray(corpus.records)) throw new Error("Confirmatory corpus must contain a records array");
  if (corpus.records.length !== 32) throw new Error(`Expected 32 confirmatory incidents; received ${corpus.records.length}`);
  const ids = new Set();
  const scenarios = new Map();
  for (const record of corpus.records) {
    if (!record.id || ids.has(record.id)) throw new Error(`Missing or duplicate confirmatory incident id: ${record.id}`);
    ids.add(record.id);
    if (!record.scenarioId) throw new Error(`Missing scenario metadata for incident ${record.id}`);
    if (record.status !== "resolved") throw new Error(`Confirmatory incident ${record.id} must be resolved`);
    const scenarioRecords = scenarios.get(record.scenarioId) ?? [];
    scenarioRecords.push(record);
    scenarios.set(record.scenarioId, scenarioRecords);
    for (const field of ["title", "description", "rootCause", "fixApplied"]) {
      if (typeof record.incident?.[field] !== "string") {
        throw new Error(`Missing incident.${field} for confirmatory record ${record.id}`);
      }
    }
    const searchable = searchText(record.incident).toLocaleLowerCase("en-US");
    if (searchable.includes(record.scenarioId.toLocaleLowerCase("en-US"))) {
      throw new Error(`Scenario label leaks into searchable text for ${record.id}`);
    }
  }
  if (scenarios.size !== 8) throw new Error(`Expected eight confirmatory scenarios; received ${scenarios.size}`);
  for (const [scenarioId, records] of scenarios) {
    if (records.length !== 4) throw new Error(`Confirmatory scenario ${scenarioId} has ${records.length} incidents; expected 4`);
  }
  return { scenarioCount: scenarios.size, recordCount: ids.size };
}

export function scoreGate(selected, baseline, floor = 0.7, margin = 0.1) {
  const improvement = selected.recallAt5 - baseline.recallAt5;
  return {
    recallFloor: floor,
    requiredRecallMargin: margin,
    selectedRecallAt5: selected.recallAt5,
    baselineRecallAt5: baseline.recallAt5,
    absoluteRecallImprovement: improvement,
    metRecallFloor: selected.recallAt5 >= floor,
    beatStrongestBaselineByMargin: improvement >= margin,
    passed: selected.recallAt5 >= floor && improvement >= margin,
  };
}
