# M8 retrieval configuration evaluation

## Reproduce

The complete evaluation is run with a verified disposable PostgreSQL cluster bound only to `127.0.0.1`:

```powershell
$env:M8_EVAL_DATABASE_URL = 'postgres://postgres@127.0.0.1:<port>/postgres'
npm run eval:m8-search
```

Use a verified disposable PostgreSQL database. The runner creates its data table and GIN indexes as temporary objects inside one transaction, then rolls the transaction back; it does not apply migrations or write persistent data. It prints the database address, port, and PostgreSQL version with a deterministic JSON report. The corrected run used PostgreSQL 17.11 on `127.0.0.1:51641`; two complete consecutive command outputs were byte-identical (SHA-256 `382bff6252c3ea9e113e12d523e261557232697f9723ad240db7955979a1a4ce`). The disposable cluster was stopped, verified stopped, and removed after evaluation.

The current results use a **protocol-corrected full candidate pool**. The earlier held-out results were already inspected using a split-restricted candidate pool; this corrected evaluation is not previously unseen confirmatory evidence.

The version-controlled corpus is [m8-retrieval-corpus.json](./m8-retrieval-corpus.json). Validate metrics and split rules without PostgreSQL using:

```powershell
node --test scripts/m8-search-evaluation.test.mjs
```

## Corpus and labels

- 48 synthetic resolved incidents in 12 scenarios, four incidents per scenario.
- Development: eight scenarios, 32 source queries; every query ranks against all 48 resolved incidents except itself (47 candidates), for 1,504 query-candidate pairs and three same-scenario relevant candidates per query (96 relevant pairs).
- Held-out: four scenarios, 16 source queries; every query uses the identical 48-incident pool except itself (47 candidates), for 752 query-candidate pairs and three same-scenario relevant candidates per query (48 relevant pairs).
- The split is by scenario. No scenario crosses development and held-out.
- Each record has an organization-local incident number, a non-label UUID, incident title and description, root cause, fix, status, and resolved timestamp. Scenario IDs and split/relevance labels are JavaScript-only metadata: they are not sent to PostgreSQL, included in the temporary candidate table, search vectors, or query text.
- Same-scenario candidates are relevant; all different-scenario candidates are hard negatives, including incidents sharing service vocabulary but having a different cause. The scenario pairs cover checkout/database vs catalog cache, payment TLS vs throttling, identity clock vs signing-key cache, deployment integrity vs registry access, storage inode vs metadata freshness, and queue poison-message vs broker/consumer transport.
- Dates and numbers are assigned independently of scenario membership; tie-breaking cannot expose scenario grouping. Corpus order is fixed and no chronology-based label rule is used.
- Seed: `20261017`. The seed is recorded for reproducibility; corpus contents, IDs, numbers and timestamps are fixed in the JSON.
- One author created the synthetic records and labels. There were no independent annotators.

The test set is small and artificial, and same-scenario relevance is a coarse proxy for operational usefulness. All records are resolved, so this experiment does not estimate behavior with large unresolved candidate populations. Results should not be interpreted as a production quality guarantee.

## Retrieval variants and methodology

The runner reuses the Step 3 Unicode letter/digit tokenizer, `en-US` lowercase, token deduplication, 64-code-unit token bound, 12-term cap, prefix terms, resolved-only filtering, source exclusion, and result cap of five. Search terms are constructed by the same `term:*` convention as the endpoint and passed as a SQL parameter to `to_tsquery`; no raw text is concatenated into PostgreSQL query syntax.

The five variants are:

1. **Newest-first** — resolved time descending, then incident number descending.
2. **Title-only English FTS** — English `tsvector` over candidate title only; source terms and tie-breakers otherwise match.
3. **Weighted English FTS (production)** — title A, description B, root cause C, fix C, English `to_tsquery`, OR-prefix query, `ts_rank_cd(..., 32)`, then resolved time and incident number descending. This matches the current Step 3/M8 design.
4. **Weighted simple FTS** — same A/B/C/C fields, OR-prefix query and rank/tie-break rules, using PostgreSQL's `simple` configuration.
5. **Weighted English AND-match** — weighted English vector with all sanitized prefix terms joined using AND. This deliberately strict baseline is included as a simple lexical precision-oriented comparison.

Development and held-out query lists remain separate and are evaluated in sequence. Each list searches the same full 48-incident candidate pool, with only its source incident excluded; relevance remains same-scenario membership, so incidents from other scenario groups are hard negatives in both splits. Candidate status and self-exclusion are applied before ranking. PostgreSQL returns the complete ranked candidate order; JavaScript then excludes the source defensively and truncates to five. This is ranking-equivalent to the endpoint's SQL `LIMIT 5` for this corpus. No indexed latency or plan claims are made; the experiment measures relevance only. No production search settings were changed.

Selection is fixed using development results: maximize Recall@5, then MRR, then Precision@5, with configuration-list order as the last tie-break. The strongest alternative is also selected from development using that same ordering. Held-out outcomes do not affect either choice.

Metrics are macro-averaged per source query:

- `Recall@5 = relevant results in top five / all relevant candidates`.
- `Precision@5 = relevant results in top five / 5`.
- `MRR = reciprocal rank of the first relevant result`; zero if no relevant result is retrieved.
- A query with no relevant candidates contributes zero to all metrics rather than being dropped. Empty-search-term queries return no candidates and contribute zero. The fixed corpus has zero queries with no relevant candidates and zero with no searchable terms.

Uncertainty is estimated with 2,000 scenario-cluster bootstrap resamples (seed `20261017`), sampling scenarios with replacement and retaining all queries per sampled scenario. Reported intervals are percentile 95% confidence intervals. The selected-versus-baseline difference uses a paired scenario-cluster bootstrap.

## Results

All five variants have identical query/candidate/relevance counts within each split. Development: 32 queries, 48-incident pool, 47 candidates/query, 1,504 candidate pairs, and 96 relevant pairs. Held-out: 16 queries, the same 48-incident pool, 47 candidates/query, 752 candidate pairs, and 48 relevant pairs. Each query has three relevant candidates. Queries without relevant candidates/searchable terms: `0 / 0` in both splits.

Values are `Recall@5 [95% CI] / Precision@5 [95% CI] / MRR [95% CI]`, rounded to four decimals.

| Configuration | Development | Held-out |
|---|---|---|
| Newest-first | 0.0938 [0.0313, 0.1875] / 0.0562 [0.0188, 0.1125] / 0.0891 [0.0188, 0.1875] | 0.1250 [0.0000, 0.2500] / 0.0750 [0.0000, 0.1500] / 0.2500 [0.0000, 0.5625] |
| Title-only English FTS | 0.5312 [0.3854, 0.6875] / 0.3188 [0.2313, 0.4125] / 0.6224 [0.4766, 0.7708] | 0.6458 [0.5833, 0.7083] / 0.3875 [0.3500, 0.4250] / 0.8958 [0.7500, 1.0000] |
| Weighted English FTS (production) | 0.7083 [0.5938, 0.8125] / 0.4250 [0.3563, 0.4875] / 0.7734 [0.6250, 0.9063] | 0.8125 [0.7500, 0.8750] / 0.4875 [0.4500, 0.5250] / 0.9375 [0.8750, 1.0000] |
| Weighted simple FTS | 0.6563 [0.5208, 0.7813] / 0.3938 [0.3125, 0.4687] / 0.7786 [0.6510, 0.8906] | 0.6875 [0.6042, 0.7917] / 0.4125 [0.3625, 0.4750] / 0.6458 [0.5833, 0.7083] |
| Weighted English AND-match | 0.0000 [0.0000, 0.0000] / 0.0000 [0.0000, 0.0000] / 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] / 0.0000 [0.0000, 0.0000] / 0.0000 [0.0000, 0.0000] |

Development selected **weighted English FTS** (Recall@5 0.7083); the strongest alternative selected on development was **weighted simple FTS** (0.6563).

### Predeclared held-out gate

The original gate remains unchanged: the development-selected weighted English configuration must achieve Recall@5 >= 0.70 and exceed the development-selected strongest alternative by at least 0.10 absolute Recall@5.

- Weighted English held-out Recall@5: **0.8125** (95% CI 0.7500–0.8750).
- Frozen strongest alternative, weighted simple: **0.6875** (95% CI 0.6042–0.7917).
- Observed Recall@5 improvement (English minus simple): **+0.1250**.
- Paired scenario-bootstrap 95% CI for the Recall@5 difference (English minus simple): **-0.0208 to +0.2708**.
- Reporting floor: **met**.
- Required +0.10 held-out Recall@5 margin: **met by the point estimate**.
- Original point-estimate quality gate: **met**.

The bootstrap interval includes zero and does not establish a positive improvement with 95% interval confidence, despite the predeclared point-estimate margin being met. More importantly, the earlier held-out results were already inspected before correcting the candidate-pool bug. This corrected run is therefore **protocol-corrected, not a previously unseen confirmatory result**; the mechanical gate result must not be represented as fresh independent confirmation. Production search behavior remains unchanged.

## Limitations and interpretation

This is a small, single-author synthetic benchmark with four held-out scenarios. Scenario-level resampling appropriately reflects the split unit but yields coarse uncertainty intervals. The perfect-zero AND baseline reflects the strict requirement that every one of up to 12 source terms occur in a candidate; it is not evidence that all conjunctive retrieval strategies are ineffective. Equal scenario relevance ignores severity, time, service ownership, and partial causal similarity. The corpus uses no external incidents, independent annotation, production traffic, or latency measurements. Expand and independently label a realistic corpus before making broad retrieval-quality claims.

**Evaluation status: PROTOCOL-CORRECTED RUN.** The full-pool evaluation is reproducible and the original point-estimate gate is met. Because the earlier held-out results were already inspected, this run is not untouched confirmatory evidence; independent confirmation requires a newly collected and scenario-grouped corpus with a fresh held-out set.
