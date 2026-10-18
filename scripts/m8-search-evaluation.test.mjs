import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  BOOTSTRAP_RESAMPLES,
  CONFIRMATION_CONFIGURATIONS,
  CONFIGURATIONS,
  buildConfirmatoryQueries,
  buildEvaluationSearchSql,
  buildEvaluationQueries,
  calculateQueryMetrics,
  chooseDevelopmentWinner,
  groupedBootstrapDifference,
  groupedBootstrapIntervals,
  normalizeSearchTerms,
  queryString,
  scoreGate,
  selectTopFive,
  summarizeMetrics,
  validateCorpus,
  validateConfirmatoryCorpus,
} from "./lib/m8-search-evaluation.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(await readFile(path.join(__dirname, "..", "docs", "verification", "m8-retrieval-corpus.json"), "utf8"));
const confirmatoryCorpus = JSON.parse(await readFile(path.join(__dirname, "..", "docs", "verification", "m8-confirmatory-retrieval-corpus.json"), "utf8"));

describe("M8 retrieval evaluation corpus", () => {
  it("has twelve scenario groups split eight development and four held-out, without searchable-label leakage", () => {
    assert.deepEqual(validateCorpus(corpus), { scenarioCount: 12, recordCount: 48 });
    const splitScenarios = new Map();
    const counts = new Map();
    for (const record of corpus.records) {
      splitScenarios.set(record.scenarioId, record.split);
      counts.set(record.scenarioId, (counts.get(record.scenarioId) ?? 0) + 1);
      const text = Object.values(record.incident).join(" ").toLowerCase();
      assert.ok(!text.includes(record.scenarioId.toLowerCase()));
      assert.ok(!text.includes(record.split.toLowerCase()));
    }
    assert.equal([...splitScenarios.values()].filter((split) => split === "development").length, 8);
    assert.equal([...splitScenarios.values()].filter((split) => split === "held-out").length, 4);
    assert.ok([...counts.values()].every((count) => count === 4));
  });

  it("keeps query scenarios wholly inside their split while ranking against all 48 corpus incidents", () => {
    const development = buildEvaluationQueries(corpus.records, "development");
    const heldOut = buildEvaluationQueries(corpus.records, "held-out");
    assert.equal(development.length, 32);
    assert.equal(heldOut.length, 16);
    assert.ok(development.every((query) => query.relevantIds.length === 3 && query.split === "development"));
    assert.ok(heldOut.every((query) => query.relevantIds.length === 3 && query.split === "held-out"));
    const heldIds = new Set(heldOut.map((query) => query.sourceId));
    assert.ok(development.every((query) => !heldIds.has(query.sourceId)));
    const allResolvedIds = new Set(corpus.records.filter((record) => record.status === "resolved").map((record) => record.id));
    for (const query of [...development, ...heldOut]) {
      assert.equal(query.candidateIds.length, 47);
      assert.ok(query.candidateIds.every((id) => id !== query.sourceId && allResolvedIds.has(id)));
      assert.deepEqual(new Set(query.candidateIds), new Set([...allResolvedIds].filter((id) => id !== query.sourceId)));
      assert.equal(query.relevantIds.length, 3);
      assert.ok(query.relevantIds.every((id) => query.candidateIds.includes(id)));
    }
    assert.ok(development.every((query) => query.candidateIds.some((id) => corpus.records.find((record) => record.id === id)?.split === "held-out")));
    assert.ok(heldOut.every((query) => query.candidateIds.some((id) => corpus.records.find((record) => record.id === id)?.split === "development")));
  });

  it("rejects scenario leakage across splits and labels copied into searchable fields", () => {
    const crossSplit = structuredClone(corpus);
    crossSplit.records.find((record) => record.scenarioId === "D01").split = "held-out";
    assert.throws(() => validateCorpus(crossSplit), /crosses evaluation splits/);
    const leaked = structuredClone(corpus);
    leaked.records[0].incident.description += " D01";
    assert.throws(() => validateCorpus(leaked), /Scenario label leaks/);
  });

  it("normalizes punctuation as separators, deduplicates terms, and applies the production term cap", () => {
    assert.deepEqual(normalizeSearchTerms("QRS-9087 QRS/9087 outage outage"), ["qrs", "9087", "outage"]);
    const terms = normalizeSearchTerms(Array.from({ length: 15 }, (_, index) => `term${index}`).join(" "));
    assert.equal(terms.length, 12);
    assert.equal(terms.at(-1), "term11");
    assert.equal(queryString(["alpha", "beta"]), "alpha:* | beta:*");
    assert.equal(queryString(["alpha", "beta"], "and"), "alpha:* & beta:*");
  });

  it("produces stable query lists and deterministic grouped confidence intervals", () => {
    const first = buildEvaluationQueries(corpus.records, "development");
    const second = buildEvaluationQueries(corpus.records, "development");
    assert.deepEqual(first, second);
    const rows = first.map((query, index) => ({
      sourceId: query.sourceId,
      scenarioId: query.scenarioId,
      recallAt5: index % 2,
      precisionAt5: (index % 2) / 2,
      reciprocalRank: index % 2,
    }));
    const ci = groupedBootstrapIntervals(rows, BOOTSTRAP_RESAMPLES);
    assert.deepEqual(ci, groupedBootstrapIntervals(rows, BOOTSTRAP_RESAMPLES));
    assert.ok(ci.recallAt5.low <= ci.recallAt5.high);
  });

  it("bootstraps paired configuration differences by scenario and rejects mismatched query sets", () => {
    const selected = [
      { sourceId: "a1", scenarioId: "a", recallAt5: 1, precisionAt5: 0.6, reciprocalRank: 1 },
      { sourceId: "a2", scenarioId: "a", recallAt5: 0.5, precisionAt5: 0.2, reciprocalRank: 0.5 },
      { sourceId: "b1", scenarioId: "b", recallAt5: 1, precisionAt5: 0.6, reciprocalRank: 1 },
    ];
    const baseline = selected.map((row) => ({ ...row, recallAt5: row.recallAt5 - 0.25 }));
    const difference = groupedBootstrapDifference(selected, baseline, 100);
    assert.deepEqual(difference, groupedBootstrapDifference(selected, baseline, 100));
    assert.ok(difference.recallAt5.low > 0);
    assert.throws(() => groupedBootstrapDifference(selected, baseline.slice(1), 10), /Missing paired metric row/);
  });
});

describe("retrieval metric and candidate helpers", () => {
  it("builds candidate SQL over the full corpus without split or scenario label filters", () => {
    for (const configuration of CONFIGURATIONS) {
      const query = buildEvaluationSearchSql(configuration, "source-id", ["cache", "timeout"]);
      assert.match(query.text, /FROM m8_eval_incidents/);
      assert.doesNotMatch(query.text, /(?:candidate\.)?split\s*=/i);
      assert.doesNotMatch(query.text, /scenarioId|scenario_id/i);
      assert.deepEqual(query.values, configuration.kind === "newest"
        ? ["source-id"]
        : ["source-id", configuration.kind === "and" ? "cache:* & timeout:*" : "cache:* | timeout:*"]);
      if (configuration.kind !== "newest") assert.match(query.text, /to_tsquery\('[^']+'::regconfig, \$2\)/);
    }
  });

  describe("M8 confirmatory evaluation protocol", () => {
    it("validates 32 newly authored incidents across eight four-incident scenarios without label leakage", () => {
      assert.deepEqual(validateConfirmatoryCorpus(confirmatoryCorpus), { scenarioCount: 8, recordCount: 32 });
      const confirmationIds = new Set(confirmatoryCorpus.records.map(({ id }) => id));
      assert.equal(confirmationIds.size, 32);
      assert.ok(confirmatoryCorpus.records.every((record) => record.status === "resolved"));
      for (const record of confirmatoryCorpus.records) {
        const searchable = Object.values(record.incident).join(" ").toLocaleLowerCase("en-US");
        assert.ok(!searchable.includes(record.scenarioId.toLocaleLowerCase("en-US")));
        assert.ok(!searchable.includes("relevance"));
      }
    });

    it("uses the fixed weighted-English and weighted-simple pair, not configuration selection", () => {
      assert.deepEqual(
        CONFIRMATION_CONFIGURATIONS.map(({ id }) => id),
        ["weighted-english", "weighted-simple"],
      );
    });

    it("evaluates all 32 queries against 31 candidates and derives relevance only from same-scenario membership", () => {
      const queries = buildConfirmatoryQueries(confirmatoryCorpus.records);
      assert.equal(queries.length, 32);
      const allIds = new Set(confirmatoryCorpus.records.map(({ id }) => id));
      for (const query of queries) {
        assert.equal(query.candidateIds.length, 31);
        assert.ok(!query.candidateIds.includes(query.sourceId));
        assert.deepEqual(new Set(query.candidateIds), new Set([...allIds].filter((id) => id !== query.sourceId)));
        assert.equal(query.relevantIds.length, 3);
        assert.ok(query.relevantIds.every((id) => query.candidateIds.includes(id)));
        assert.ok(query.candidateIds.some((id) => {
          const candidate = confirmatoryCorpus.records.find((record) => record.id === id);
          return candidate.scenarioId !== query.scenarioId;
        }));
      }
    });

    it("rejects malformed confirmatory corpora and searchable scenario labels", () => {
      const leaked = structuredClone(confirmatoryCorpus);
      leaked.records[0].incident.description += ` ${leaked.records[0].scenarioId}`;
      assert.throws(() => validateConfirmatoryCorpus(leaked), /Scenario label leaks/);
      const wrongCount = structuredClone(confirmatoryCorpus);
      wrongCount.records.pop();
      assert.throws(() => validateConfirmatoryCorpus(wrongCount), /Expected 32/);
      const nonResolved = structuredClone(confirmatoryCorpus);
      nonResolved.records[0].status = "triggered";
      assert.throws(() => validateConfirmatoryCorpus(nonResolved), /must be resolved/);
    });

    it("keeps confirmatory queries, rankings, and grouped intervals deterministic", () => {
      const first = buildConfirmatoryQueries(confirmatoryCorpus.records);
      const second = buildConfirmatoryQueries(confirmatoryCorpus.records);
      assert.deepEqual(first, second);
      const metrics = first.map((query, index) => ({
        sourceId: query.sourceId,
        scenarioId: query.scenarioId,
        recallAt5: index % 2,
        precisionAt5: (index % 2) / 2,
        reciprocalRank: index % 2,
      }));
      assert.deepEqual(
        groupedBootstrapIntervals(metrics),
        groupedBootstrapIntervals(metrics),
      );
    });

    it("computes the frozen pair metrics and applies the unchanged recall margin honestly", () => {
      const queries = [
        { sourceId: "s1", scenarioId: "x", relevantIds: ["r1", "r2"], candidateIds: ["r1", "r2", "n1"] },
        { sourceId: "s2", scenarioId: "y", relevantIds: ["r3"], candidateIds: ["r3", "n2"] },
      ];
      const english = new Map([["s1", ["r1", "n1"]], ["s2", ["r3"]]]);
      const simple = new Map([["s1", ["n1", "n2"]], ["s2", ["r3"]]]);
      const englishMetrics = summarizeMetrics(queries, english);
      const simpleMetrics = summarizeMetrics(queries, simple);
      assert.equal(englishMetrics.recallAt5, 0.75);
      assert.equal(englishMetrics.precisionAt5, 0.2);
      assert.equal(englishMetrics.mrr, 1);
      assert.equal(simpleMetrics.recallAt5, 0.5);
      assert.equal(scoreGate(englishMetrics, simpleMetrics).passed, true);
      assert.equal(scoreGate(simpleMetrics, englishMetrics).passed, false);
      const difference = groupedBootstrapDifference(englishMetrics.perQuery, simpleMetrics.perQuery);
      assert.deepEqual(difference, groupedBootstrapDifference(englishMetrics.perQuery, simpleMetrics.perQuery));
    });

    it("returns zero metrics for empty-term queries and surfaces invalid evaluation configuration", () => {
      const rows = [{ id: "src", scenarioId: "empty", status: "resolved", incident: { title: "!!!", description: "", rootCause: "", fixApplied: "" } }];
      const [query] = buildConfirmatoryQueries(rows);
      assert.deepEqual(query.terms, []);
      assert.deepEqual(query.candidateIds, []);
      assert.deepEqual(query.relevantIds, []);
      const summary = summarizeMetrics([query], new Map([["src", []]]));
      assert.equal(summary.recallAt5, 0);
      assert.equal(summary.precisionAt5, 0);
      assert.equal(summary.mrr, 0);
      assert.throws(() => buildEvaluationSearchSql({ kind: "unknown" }, "src", ["token"]), /Unsupported evaluation configuration/);
    });
  });

  it("excludes the source itself and truncates ordered candidates to five", () => {
    assert.deepEqual(selectTopFive(["source", "a", "b", "c", "d", "e", "f"], "source"), ["a", "b", "c", "d", "e"]);
  });

  it("calculates Recall@5, Precision@5, and MRR with explicit empty relevance handling", () => {
    const queries = [
      { sourceId: "s1", scenarioId: "a", relevantIds: ["r1", "r2"], candidateIds: ["r1", "r2", "n1"] },
      { sourceId: "s2", scenarioId: "b", relevantIds: [], candidateIds: ["n2", "n3"] },
    ];
    const rankings = new Map([
      ["s1", ["n1", "r1", "n4", "r2", "n5"]],
      ["s2", ["n2", "n3"]],
    ]);
    const rows = calculateQueryMetrics(queries, rankings);
    assert.deepEqual(rows[0], { sourceId: "s1", scenarioId: "a", recallAt5: 1, precisionAt5: 0.4, reciprocalRank: 0.5 });
    assert.deepEqual(rows[1], { sourceId: "s2", scenarioId: "b", recallAt5: 0, precisionAt5: 0, reciprocalRank: 0 });
    const summary = summarizeMetrics(queries, rankings);
    assert.equal(summary.queryCount, 2);
    assert.equal(summary.candidateCountPerQuery, 2.5);
    assert.equal(summary.relevantItemCount, 2);
    assert.equal(summary.queriesWithoutRelevantCandidates, 1);
    assert.equal(summary.recallAt5, 0.5);
    assert.equal(summary.precisionAt5, 0.2);
    assert.equal(summary.mrr, 0.25);
  });

  it("returns empty rankings for queries with no useful terms and gives zero metrics", () => {
    const records = [
      { id: "src", scenarioId: "S", split: "development", status: "resolved", incident: { title: "!!!", description: "", rootCause: "", fixApplied: "" } },
      { id: "candidate", scenarioId: "S", split: "development", status: "resolved", incident: { title: "???", description: "", rootCause: "", fixApplied: "" } },
      { id: "unresolved", scenarioId: "S", split: "development", status: "triggered", incident: { title: "!!!", description: "", rootCause: "", fixApplied: "" } },
    ];
    const [query] = buildEvaluationQueries(records, "development");
    assert.deepEqual(query.terms, []);
    assert.deepEqual(query.candidateIds, ["candidate"]);
    const metrics = summarizeMetrics([query], new Map([["src", []]]));
    assert.equal(metrics.queriesWithoutSearchTerms, 1);
    assert.equal(metrics.recallAt5, 0);
    assert.equal(metrics.precisionAt5, 0);
    assert.equal(metrics.mrr, 0);
  });

  it("selects a configuration using development outcomes only with declared tie-breaks", () => {
    const winner = chooseDevelopmentWinner([
      { configuration: "weighted-english", metrics: { recallAt5: 0.8, mrr: 0.5, precisionAt5: 0.4 } },
      { configuration: "weighted-simple", metrics: { recallAt5: 0.8, mrr: 0.6, precisionAt5: 0.4 } },
    ]);
    assert.equal(winner, "weighted-simple");
  });

  it("applies the predeclared reporting floor and meaningful-margin gate without changing thresholds", () => {
    const result = scoreGate({ recallAt5: 0.8125 }, { recallAt5: 0.8125 });
    assert.deepEqual(result, {
      recallFloor: 0.7,
      requiredRecallMargin: 0.1,
      selectedRecallAt5: 0.8125,
      baselineRecallAt5: 0.8125,
      absoluteRecallImprovement: 0,
      metRecallFloor: true,
      beatStrongestBaselineByMargin: false,
      passed: false,
    });
  });
});
