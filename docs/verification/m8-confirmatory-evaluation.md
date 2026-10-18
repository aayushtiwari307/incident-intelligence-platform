# M8 confirmatory retrieval evaluation

## Frozen protocol (recorded before evaluation)

This is a separate confirmatory experiment using `m8-confirmatory-retrieval-corpus.json`. The prior 48-incident corpus has already informed development and its held-out results were inspected. None of those records are candidates in this experiment.

- Corpus: 32 newly authored synthetic resolved incidents, four each in eight new scenarios; one author, no independent annotation.
- Relevance: a candidate is relevant if and only if it is a different incident from the same scenario. Scenario identifiers and labels are metadata and must not enter incident text, the search query, or PostgreSQL candidate/searchable fields.
- Candidate pool: every query searches all 32 incidents except itself, with status `resolved`; exactly 31 candidates. No candidate filtering by scenario or split is permitted.
- Configurations are fixed in advance: production weighted English FTS (A/B/C/C title/description/root cause/fix weights, English prefix-OR query, `ts_rank_cd` normalization 32) versus weighted simple FTS with the identical fields, query terms, ranking, and tie-breaks. No winner selection, tokenization changes, weight changes, or production changes are allowed.
- Query normalization follows the existing production-equivalent Unicode tokenization, English lowercase, unique terms, 64-character token limit, and first-12-term cap. Search text is passed as a SQL parameter.
- Metrics are macro-averaged per query. Recall@5 is relevant top-five results divided by all relevant candidates; Precision@5 is relevant top-five divided by five; MRR is reciprocal rank of the first relevant result, or zero when none is retrieved. Scenario-group bootstrap uses 2,000 resamples with seed `20261017`; the paired bootstrap resamples scenario groups and reports the weighted-English minus weighted-simple metric difference.
- Decision criterion remains the existing +0.10 absolute Recall@5 improvement for weighted English over weighted simple. The 0.70 recall reporting floor is also reported. The paired 95% interval is reported without changing the point-estimate criterion.
- Run the protocol once, then repeat only to verify deterministic output. Any code defect is documented and fixed without tuning to measured results.

The corpus and labels are synthetic and single-author. This is not independent human annotation, production validation, or a broad estimate of operational relevance. The eight scenarios are new to this corpus but use the same authoring process; the findings should be interpreted accordingly.

## Reproduce

On a verified disposable PostgreSQL instance bound only to loopback:

```powershell
$env:M8_CONFIRM_DATABASE_URL = 'postgres://postgres@127.0.0.1:<port>/postgres'
npm run eval:m8-confirmation
```

The runner must use temporary tables and roll back its transaction. It prints its PostgreSQL target and a JSON results report. The exact disposable data directory, port, and listener must be verified before connecting.

## Results

The frozen command `npm run eval:m8-confirmation` was run once, then repeated only to verify reproducibility. Both executions used the same fresh PostgreSQL 17.11 disposable cluster on `127.0.0.1:51642`. Their complete command outputs were byte-identical (SHA-256 `04e69ba4c23ab3bfabbbef11b526f53ed9602aa875386abfcfa0f22ae64cb03f`). The runner reported `postgres` at `127.0.0.1/32:51642`; the live listener, port and unique data directory were checked before connecting. The cluster was stopped, verified stopped with no listener/process references, and only that exact temporary directory was removed.

Corpus/query evidence: 8 scenarios, 32 records and 32 source queries; every query had 31 candidates from the complete 32-record pool, giving 992 candidate pairs. There were 96 relevant pairs (3 per query). Every record was resolved; no query had empty terms or no relevant candidates. Each result configuration used all same queries and candidates.

Metrics are query-macro-averaged. Per-query Recall@5 is relevant top-five results divided by the three same-scenario relevant candidates; Precision@5 is relevant top-five results divided by five; MRR is the reciprocal rank of the first relevant result, or zero if none is retrieved. Intervals are 2,000 scenario-cluster bootstrap percentile 95% intervals, seed `20261017`.

| Frozen configuration | Queries / candidates per query / relevant pairs | Recall@5 [95% CI] | Precision@5 [95% CI] | MRR [95% CI] |
|---|---:|---:|---:|---:|
| Weighted English FTS | 32 / 31 / 96 | 0.8229 [0.7812, 0.8854] | 0.4937 [0.4687, 0.5312] | 0.9479 [0.8750, 1.0000] |
| Weighted simple FTS | 32 / 31 / 96 | 0.6042 [0.4792, 0.7396] | 0.3625 [0.2875, 0.4437] | 0.7745 [0.6573, 0.8828] |

The paired scenario-bootstrap 95% interval for weighted English minus weighted simple was:

- Recall@5: **+0.0938 to +0.3438**; observed difference **+0.2188**.
- Precision@5: **+0.0563 to +0.2063**.
- MRR: **+0.0797 to +0.2906**.

**Decision against the unchanged gate:** the 0.70 recall reporting floor was met (0.8229), and the observed +0.2188 Recall@5 improvement exceeded the predeclared +0.10 margin. **The point-estimate gate is met.** The paired Recall@5 interval is entirely above zero for this sample, but its lower bound (+0.0938) is below +0.10; it does not show that the improvement exceeds the margin at the 95% interval level. This is fresh scenario material relative to the earlier corpus, but remains single-author synthetic evidence rather than independent annotation or production validation. Eight scenarios provide limited coverage and coarse scenario-level uncertainty; same-scenario relevance remains an imperfect proxy for actual operator usefulness.
