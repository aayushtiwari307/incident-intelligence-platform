# 0003 Product name

**Status: needs the owner's decision.** Tracewake is rejected (an existing AI evidence agent uses that exact name). Until a name is chosen the code uses the neutral workspace name `incident-platform` / `@platform/*`, so renaming later is a search-and-replace on package names and docs only.

## Candidates checked (2026-10-09)

| Name | GitHub repos named like it | `.com` | Other observations |
|------|---------------------------|--------|--------------------|
| Cairnwatch | 0 | registered 2026-03-27 (Amazon Registrar) | no direct web hits; results were the unrelated "Cairn" software |
| Lanternroom | 0 | registered since 1999 (CSC Corporate Domains, a brand-protection registrar) | no direct web hits; the long-held, corporate-managed `.com` suggests an owner who would defend it |
| Nightbridge | 6 (e.g. a LocalSend-compatible server, 2 stars) | registered 2016 (GoDaddy) | `.dev` and `.io` both registered |
| Embertrail | 11 (mostly empty/old) | registered 2021 (Amazon Registrar) | |
| Wardline | 25, including an open-source control-plane proxy for AI agents (15 stars) | registered 2003 (GoDaddy) | `.io` (2026) and `.dev` (2026) registered; **closest conflict, an AI-agent governance product** |

## What this check can and cannot show
- **npm:** the registry fetches for all five names failed with the same fetch error, and the calibration against a known package did not settle it. **npm availability is unverified for every candidate.** Run `npm view <name>` locally.
- **`.dev` / `.io`:** several lookups errored; only the results above are known. A "not found" answer was never obtained for any name, so no name is confirmed available on any TLD.
- **Trademarks:** only general web searches were run. **No USPTO/EUIPO/WIPO register search was done.** This is not a trademark clearance and not legal advice.

## Recommendation
**Cairnwatch**, as a working name only: it is the only candidate with no GitHub repositories, no direct web hits and no obviously related product. Caveat: its `.com` was registered in March 2026, so someone may be planning to use it. Runner-up: Wardline is the strongest *conflict* and should be avoided; Lanternroom is weaker because of its long-held corporate `.com`.

**Before committing to a name:** `npm view`, GitHub org/user availability, a USPTO TESS/WIPO Global Brand Database search in classes 9 and 42, and a quick look at Cairnwatch's registrant activity. Since this is a portfolio project the practical risk is low, but do not print the name on a resume or domain until these are done.
