
Continued from
IIP Interview (1)
atform> # 6. Commit.
PS C:\Dev\incident-intelligence-platform> git commit -m "fix: align realtime configuration across environments"
[fix/realtime-config-defaults 373de1d] fix: align realtime configuration across environments
 7 files changed, 12 insertions(+), 9 deletions(-)
PS C:\Dev\incident-intelligence-platform>
PS C:\Dev\incident-intelligence-platform> if ($LASTEXITCODE -ne 0) {
>>     throw "Commit failed. Check Git output."
>> }
PS C:\Dev\incident-intelligence-platform>
PS C:\Dev\incident-intelligence-platform> # 7. Verify commit and remaining work.
PS C:\Dev\incident-intelligence-platform> Write-Host "`n--- Commit ---"

--- Commit ---
PS C:\Dev\incident-intelligence-platform> git log -1 --oneline
373de1d (HEAD -> fix/realtime-config-defaults) fix: align realtime configuration across environments
PS C:\Dev\incident-intelligence-platform>
PS C:\Dev\incident-intelligence-platform> Write-Host "`n--- Branch ---"

--- Branch ---
PS C:\Dev\incident-intelligence-platform> git branch --show-current
fix/realtime-config-defaults
PS C:\Dev\incident-intelligence-platform>
PS C:\Dev\incident-intelligence-platform> Write-Host "`n--- Remaining working tree ---"

--- Remaining working tree ---
PS C:\Dev\incident-intelligence-platform> git status --short
?? apps/api/test-query.js
?? scripts/bench-jobqueue.mjs
?? scripts/bench-login-limit.mjs
?? scripts/bench-ratelimit.mjs
?? scripts/bench-realtime-latency.mjs
?? scripts/bench-webhook-flood.mjs
?? test-query.js
?? test-socket.js
PS C:\Dev\incident-intelligence-platform> cd C:\Dev\incident-intelligence-platform
PS C:\Dev\incident-intelligence-platform>
PS C:\Dev\incident-intelligence-platform> if ((git branch --show-current) -ne "fix/realtime-config-defaults") {
>>     throw "Wrong branch. Push cancelled."
>> }
PS C:\Dev\incident-intelligence-platform>
PS C:\Dev\incident-intelligence-platform> Write-Host "`n--- Commit to push ---"

--- Commit to push ---
PS C:\Dev\incident-intelligence-platform> git log -1 --oneline
373de1d (HEAD -> fix/realtime-config-defaults) fix: align realtime configuration across environments
PS C:\Dev\incident-intelligence-platform>
PS C:\Dev\incident-intelligence-platform> Write-Host "`n--- Files in commit ---"

--- Files in commit ---
PS C:\Dev\incident-intelligence-platform> git diff-tree --no-commit-id --name-only -r HEAD
apps/api/src/config/env.ts
apps/web/.env.example
apps/web/Dockerfile
apps/web/src/lib/use-realtime.ts
docker-compose.yml
docs/deployment/realtime-rollout.md
render.yaml
PS C:\Dev\incident-intelligence-platform>
PS C:\Dev\incident-intelligence-platform> git push -u origin fix/realtime-config-defaults
Enumerating objects: 35, done.
Counting objects: 100% (35/35), done.
Delta compression using up to 12 threads
Compressing objects: 100% (18/18), done.
Writing objects: 100% (18/18), 1.99 KiB | 338.00 KiB/s, done.
Total 18 (delta 16), reused 0 (delta 0), pack-reused 0 (from 0)
remote: Resolving deltas: 100% (16/16), completed with 16 local objects.
remote:
remote: Create a pull request for 'fix/realtime-config-defaults' on GitHub by visiting:
remote:      https://github.com/aayushtiwari307/incident-intelligence-platform/pull/new/fix/realtime-config-defaults
remote:
To https://github.com/aayushtiwari307/incident-intelligence-platform.git
 * [new branch]      fix/realtime-config-defaults -> fix/realtime-config-defaults
branch 'fix/realtime-config-defaults' set up to track 'origin/fix/realtime-config-defaults'.
PS C:\Dev\incident-intelligence-platform> cd C:\Dev\incident-intelligence-platform
PS C:\Dev\incident-intelligence-platform>
PS C:\Dev\incident-intelligence-platform> git fetch origin
remote: Enumerating objects: 1, done.
remote: Counting objects: 100% (1/1), done.
remote: Total 1 (delta 0), reused 0 (delta 0), pack-reused 0 (from 0)
Unpacking objects: 100% (1/1), 937 bytes | 187.00 KiB/s, done.
From https://github.com/aayushtiwari307/incident-intelligence-platform
   1cf0cf1..8670756  main       -> origin/main
PS C:\Dev\incident-intelligence-platform> git switch main
Switched to branch 'main'
Your branch is behind 'origin/main' by 5 commits, and can be fast-forwarded.
  (use "git pull" to update your local branch)
PS C:\Dev\incident-intelligence-platform> git pull --ff-only origin main
From https://github.com/aayushtiwari307/incident-intelligence-platform
 * branch            main       -> FETCH_HEAD
Updating 6eb749f..8670756
Fast-forward
 README.md                           | 122 +++++++++++++++++++-----------------
 apps/api/src/config/env.ts          |   2 +-
 apps/web/.env.example               |   2 +-
 apps/web/Dockerfile                 |   2 +
 apps/web/src/lib/use-realtime.ts    |   2 +-
 docker-compose.yml                  |   9 ++-
 docs/deployment/realtime-rollout.md |   8 +--
 render.yaml                         |   4 +-
 8 files changed, 80 insertions(+), 71 deletions(-)
PS C:\Dev\incident-intelligence-platform>
PS C:\Dev\incident-intelligence-platform> Write-Host "`n--- Latest main commit ---"

--- Latest main commit ---
PS C:\Dev\incident-intelligence-platform> git log -1 --oneline
8670756 (HEAD -> main, origin/main, origin/HEAD) Merge pull request #11 from aayushtiwari307/fix/realtime-config-defaults
PS C:\Dev\incident-intelligence-platform>
PS C:\Dev\incident-intelligence-platform> Write-Host "`n--- Working tree ---"

--- Working tree ---
PS C:\Dev\incident-intelligence-platform> git status --short
?? apps/api/test-query.js
?? scripts/bench-jobqueue.mjs
?? scripts/bench-login-limit.mjs
?? scripts/bench-ratelimit.mjs
?? scripts/bench-realtime-latency.mjs
?? scripts/bench-webhook-flood.mjs
?? test-query.js
?? test-socket.js
PS C:\Dev\incident-intelligence-platform> cd C:\Dev\incident-intelligence-platform
PS C:\Dev\incident-intelligence-platform>
PS C:\Dev\incident-intelligence-platform> Write-Host "`n--- Socket.IO latency benchmark ---"

--- Socket.IO latency benchmark ---
PS C:\Dev\incident-intelligence-platform> Get-Content scripts/bench-realtime-latency.mjs
// Local-only benchmark: REST create -> Socket.IO push latency in one org, plus a second org as an isolation control.
import { loadSocketIoClient, parseSetCookie } from "./smoke-stack.mjs";

const api = (process.env.API_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const origin = process.env.WEB_URL ?? "http://127.0.0.1:3000";
const perRound = Number(process.argv[2] ?? 100);
const rounds = Number(process.argv[3] ?? 3);
if (!["127.0.0.1", "localhost"].includes(new URL(api).hostname)) throw new Error("Local stack only");
const io = loadSocketIoClient();
const rid = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const password = Bench-${rid()}-${rid()}!;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)].toFixed(1); };

async function register(label) {
  const res = await fetch(${api}/api/auth/register, { method: "POST", headers: { "content-type": "application/json", Origin: origin }, body: JSON.stringify({ email: bench-${label}-${rid()}@example.com, password, displayName: Bench ${label}, organizationName: Bench Org ${label} ${rid()} }) });
  if (res.status !== 201) throw new Error(register ${label}: HTTP ${res.status});
  const c = parseSetCookie(res.headers.getSetCookie()[0]);
  return ${c.name}=${c.value};
}
async function createIncident(cookie, title) {
  const res = await fetch(${api}/api/incidents, { method: "POST", headers: { "content-type": "application/json", Origin: origin, Cookie: cookie }, body: JSON.stringify({ title, description: "benchmark", severity: "sev2" }) });
  if (res.status !== 201) throw new Error(create incident: HTTP ${res.status});
  return (await res.json()).id;
}
function listen(cookie) {
  const seen = new Map();
  const socket = io(api, { path: "/socket.io", transports: ["websocket"], reconnection: false, forceNew: true, timeout: 10000, extraHeaders: { Origin: origin, Cookie: cookie } });
  const ready = new Promise((resolve, reject) => { socket.once("realtime.ready", resolve); socket.once("connect_error", (e) => reject(new Error(socket refused: ${e.message}))); setTimeout(() => reject(new Error("no realtime.ready in 10 s")), 10000); });
  socket.on("incident.event", (m) => { if (m?.incidentId && !seen.has(m.incidentId)) seen.set(m.incidentId, performance.now()); });
  return { socket, seen, ready };
}

const cookieA = await register("A");
const cookieB = await register("B");
const A = listen(cookieA);
const B = listen(cookieB);
await Promise.all([A.ready, B.ready]);

const idsA = new Set(); const idsB = new Set(); const all = []; let timeouts = 0;
for (let r = 1; r <= rounds; r++) {
  const lat = []; const rest = [];
  for (let i = 0; i < perRound; i++) {
    const t0 = performance.now();
    const id = await createIncident(cookieA, bench ${r}-${i});
    const tResp = performance.now();
    idsA.add(id);
    while (!A.seen.has(id) && performance.now() < tResp + 5000) await sleep(1);
    if (!A.seen.has(id)) { timeouts++; continue; }
    lat.push(A.seen.get(id) - t0); rest.push(tResp - t0);
    await sleep(30);
  }
  console.log(round ${r}: received ${lat.length}/${perRound}  create->push p50 ${pct(lat, 50)} ms, p95 ${pct(lat, 95)} ms  (REST create alone p50 ${pct(rest, 50)} ms));
  all.push(...lat);
}
for (let i = 0; i < 20; i++) idsB.add(await createIncident(cookieB, bench B ${i}));
await sleep(1500);
const gotB = [...idsB].filter((id) => B.seen.has(id)).length;
const aSeenByB = [...idsA].filter((id) => B.seen.has(id)).length;
const bSeenByA = [...idsB].filter((id) => A.seen.has(id)).length;
console.log(overall: n=${all.length}, timeouts ${timeouts}, p50 ${pct(all, 50)} ms, p95 ${pct(all, 95)} ms, p99 ${pct(all, 99)} ms);
console.log(isolation: org B socket got ${gotB}/${idsB.size} of its own; org A events seen by B socket ${aSeenByB}/${idsA.size}; org B events seen by A socket ${bSeenByA}/${idsB.size});
A.socket.close(); B.socket.close();
process.exit(0);
PS C:\Dev\incident-intelligence-platform>
PS C:\Dev\incident-intelligence-platform> Write-Host "`n--- Existing socket test ---"

--- Existing socket test ---
PS C:\Dev\incident-intelligence-platform> Get-Content test-socket.js
con
…
I've inspected both scripts. Use scripts/bench-realtime-latency.mjs for the remaining test. Do not use test-socket.js.

What I found
API real-time enabled locally
Your output confirms:

API has REALTIME_ENABLED=true.

API uses Redis at redis://redis:6379.

You're on synchronized main, commit 8670756.

The benchmark script does the following:

Operation

Default

Register synthetic organization A

1

Register synthetic organization B

1

Create incidents for A

300

Create incidents for B

20

Measure create-to-Socket.IO-push latency

300 samples

Check cross-organization event isolation

Both directions

Three important limitations:

It creates 320 persistent synthetic incidents and two accounts/organizations. It does not clean them up.

Its latency measurement is sequential, not a concurrent-load latency test. We should describe the resulting p50/p95 accordingly.

It prints isolation failures but does not automatically return a failing exit code. We must inspect its results rather than trust the exit code alone.

test-socket.js is unsuitable: it uses an unauthenticated connection and a different Socket.IO path.

Step 1 — Verify the running stack
Run:

cd C:\Dev\incident-intelligence-platform

Write-Host "`n--- Containers ---"
docker compose --profile app ps

Write-Host "`n--- API readiness ---"
Invoke-RestMethod http://127.0.0.1:3001/health/ready

Write-Host "`n--- API real-time setting ---"
docker compose --profile app exec api printenv REALTIME_ENABLED

Write-Host "`n--- Web build configuration ---"
docker compose --profile app config |
    Select-String "REALTIME_ENABLED|NEXT_PUBLIC_REALTIME_ENABLED"

Paste the output.

Next we'll run the existing benchmark with its three-round default, provided the stack is healthy. We'll preserve the results for your resume and Claude's final testing tracker.

) {
    const createdTime = new Date(payload.created_at).getTime();
    const latency = receivedTime - createdTime;
    console.log('⚡ End-to-End Latency (Received - Created): ' + latency + ' ms');
  } else {
    console.log('Payload:', payload);
  }
});

socket.on('connect_error', (err) => {
  console.error('Connection Error:', err.message);
});
PS C:\Dev\incident-intelligence-platform>
PS C:\Dev\incident-intelligence-platform> Write-Host "`n--- Local real-time configuration (names/status only) ---"

--- Local real-time configuration (names/status only) ---
PS C:\Dev\incident-intelligence-platform> docker compose --profile app exec api printenv REALTIME_ENABLED
true
PS C:\Dev\incident-intelligence-platform> docker compose --profile app exec api printenv REDIS_URL
redis://redis:6379
PS C:\Dev\incident-intelligence-platform>
PS C:\Dev\incident-intelligence-platform> Write-Host "`n--- Current branch ---"

--- Current branch ---
PS C:\Dev\incident-intelligence-platform> git branch --show-current
main
PS C:\Dev\incident-intelligence-platform> cd C:\Dev\incident-intelligence-platform
PS C:\Dev\incident-intelligence-platform>
PS C:\Dev\incident-intelligence-platform> Write-Host "`n--- Containers ---"

--- Containers ---
PS C:\Dev\incident-intelligence-platform> docker compose --profile app ps
NAME                                        IMAGE                                COMMAND                  SERVICE    CREATED             STATUS                       PORTS
incident-intelligence-platform-api-1        incident-intelligence-platform-api   "docker-entrypoint.s…"   api        About an hour ago   Up About an hour (healthy)   127.0.0.1:3001->3001/tcp
incident-intelligence-platform-postgres-1   postgres:16                          "docker-entrypoint.s…"   postgres   20 hours ago        Up About an hour (healthy)   127.0.0.1:5545->5432/tcp
incident-intelligence-platform-redis-1      redis:7-alpine                       "docker-entrypoint.s…"   redis      20 hours ago        Up About an hour (healthy)   127.0.0.1:6381->6379/tcp
incident-intelligence-platform-web-1        incident-intelligence-platform-web   "docker-entrypoint.s…"   web        About an hour ago   Up About an hour (healthy)   127.0.0.1:3000->3000/tcp
PS C:\Dev\incident-intelligence-platform>
PS C:\Dev\incident-intelligence-platform> Write-Host "`n--- API readiness ---"

--- API readiness ---
PS C:\Dev\incident-intelligence-platform> Invoke-RestMethod http://127.0.0.1:3001/health/ready

status database
------ --------
ok     up

PS C:\Dev\incident-intelligence-platform>
PS C:\Dev\incident-intelligence-platform> Write-Host "`n--- API real-time setting ---"

--- API real-time setting ---
PS C:\Dev\incident-intelligence-platform> docker compose --profile app exec api printenv REALTIME_ENABLED
true
PS C:\Dev\incident-intelligence-platform>
PS C:\Dev\incident-intelligence-platform> Write-Host "`n--- Web build configuration ---"

--- Web build configuration ---
PS C:\Dev\incident-intelligence-platform> docker compose --profile app config |
>>     Select-String "REALTIME_ENABLED|NEXT_PUBLIC_REALTIME_ENABLED"

      REALTIME_ENABLED: "true"
        NEXT_PUBLIC_REALTIME_ENABLED: "true"

PS C:\Dev\incident-intelligence-platform>
…
Local stack ready for benchmark
All four containers are healthy, PostgreSQL readiness is OK, and both real-time flags are true.

We can now run the actual Socket.IO latency and cross-organization isolation benchmark.

Step 2 — Run the benchmark
Run this from the project root:

node scripts/bench-realtime-latency.mjs 100 3

This performs:

300 incident creations in Organization A, across 3 rounds.

20 incident creations in Organization B.

300 create-to-Socket.IO-push latency measurements.

Cross-organization isolation checks in both directions.

Important: It creates 320 synthetic incidents and two synthetic organizations in your local database. The script does not automatically clean them up. That's expected; don't delete them manually because the project uses audit records.

Expected results
Measurement

Expected

Events received per round

100/100

Timeouts

0

Organization B receives its own events

20/20

Organization B receives Organization A events

0

Organization A receives Organization B events

0

Paste the complete output. I'll assess p50/p95/p99, delivery reliability and isolation separately. We won't claim the benchmark passed merely because the script exits successfully.

PS C:\Dev\incident-intelligence-platform>
PS C:\Dev\incident-intelligence-platform> Write-Host "`n--- Web build configuration ---"

--- Web build configuration ---
PS C:\Dev\incident-intelligence-platform> docker compose --profile app config |
>>     Select-String "REALTIME_ENABLED|NEXT_PUBLIC_REALTIME_ENABLED"

      REALTIME_ENABLED: "true"
        NEXT_PUBLIC_REALTIME_ENABLED: "true"

PS C:\Dev\incident-intelligence-platform> node scripts/bench-realtime-latency.mjs 100 3
round 1: received 100/100  create->push p50 20.2 ms, p95 27.7 ms  (REST create alone p50 19.3 ms)
round 2: received 100/100  create->push p50 19.2 ms, p95 23.6 ms  (REST create alone p50 18.3 ms)
round 3: received 100/100  create->push p50 19.7 ms, p95 26.5 ms  (REST create alone p50 18.3 ms)
overall: n=300, timeouts 0, p50 19.7 ms, p95 26.4 ms, p99 34.6 ms
isolation: org B socket got 20/20 of its own; org A events seen by B socket 0/300; org B events seen by A socket 0/20
PS C:\Dev\incident-intelligence-platform>
…
Socket.IO benchmark passed
Excellent results. Both latency and cross-organization isolation checks passed across all three rounds.

1. Latency results
19.7 ms
Overall p50
26.4 ms
Overall p95
34.6 ms
Overall p99
Round

Events

p50

p95

1

100/100

20.2 ms

27.7 ms

2

100/100

19.2 ms

23.6 ms

3

100/100

19.7 ms

26.5 ms

300/300 events received · 0 timeouts

REST create alone had a median of 18.3 ms.

Important measurement distinction: These numbers measure the time from starting the REST incident-creation request until its Socket.IO event arrives. They are not pure WebSocket transport latency.

2. Cross-organization isolation
Passed both directions
Check

Result

Organization A receives its own events

300/300

Organization B receives its own events

20/20

Organization B receives A's events

0/300

Organization A receives B's events

0/20

No cross-organization event leakage was observed.

3. Testing tracker
Test

Status

Real-time configuration fixes

Merged PR #11

API configuration tests

47/47

Full stack smoke test

20/20

Socket.IO latency

Completed

Cross-organization isolation

Completed locally

Redis fail-closed test

Optional, pending

Worker crash / lease / retry test

Optional, pending

Limitations: The benchmark was sequential, not concurrent. It does not establish production Render latency, reconnect behaviour or performance under many simultaneous clients.

The benchmark also leaves 320 synthetic incidents, two test organizations and two accounts in your local database.

4. Update for Claude
You can send Claude this:

Socket.IO latency and cross-organization isolation benchmark completed successfully on local Docker Compose, after merging PR #11.

Script: scripts/bench-realtime-latency.mjs 100 3

Results:

300/300 Organization A events received across 3 rounds.

Overall create-request-start-to-Socket.IO-event p50: 19.7 ms.

p95: 26.4 ms.

p99: 34.6 ms.

0 timeouts.

REST create median: 18.3 ms.

Organization B received 20/20 of its own events.

Organization B received 0/300 Organization A events.

Organization A received 0/20 Organization B events.

This was a sequential local benchmark, not a concurrent-load or production benchmark. The script created 320 synthetic incidents and two organizations, without automatic cleanup.

The seven real-time configuration fixes are merged in PR #11. API config tests passed 47/47 and npm run smoke:stack passed 20/20.

Please update our testing tracker. The only optional tests still open are:

Redis fail-closed behaviour after stopping Redis.

Worker crash / lease / retry behaviour.

Do not repeat completed tests. Let's decide whether either optional test is worth doing before finalizing the project's engineering evidence.

My recommendation: The required real-time work is complete. You and Claude can now resume the remaining project tasks without repeating the webhook, queue, rate-limit or Socket.IO tests.

 <div align="center">

<img alt="" width="100%" src="https://capsule-render.vercel.app/api?type=waving&height=150&color=0:FFB224,100:E0234E&section=header">

# Incident Intelligence Platform

**A multi-tenant incident operations platform that turns raw alerts into context-rich, auditable incidents.**

Alert intake and deduplication · similar-incident retrieval · change correlation · GitHub context · opt-in grounded AI · Redis-backed rate limiting.

Built on a zero budget, with every safety claim backed by a test or marked as unverified.

<br>

<a href="https://incident-intelligence-free-demo.onrender.com"><img alt="Open the live demo" src="https://img.shields.io/badge/live%20demo-open%20the%20app-FFB224?style=for-the-badge&labelColor=0B0B0C"></a>

<br>

<a href="https://github.com/aayushtiwari307/incident-intelligence-platform/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/aayushtiwari307/incident-intelligence-platform/ci.yml?branch=main&style=flat-square&label=CI"></a>
<img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
<img alt="Budget: zero rupees" src="https://img.shields.io/badge/budget-%E2%82%B90-brightgreen?style=flat-square">

<img alt="Node 22" src="https://img.shields.io/badge/Node-22-339933?style=flat-square&logo=nodedotjs&logoColor=white">
<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white">
<img alt="NestJS 11" src="https://img.shields.io/badge/NestJS-11-E0234E?style=flat-square&logo=nestjs&logoColor=white">
<img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=nextdotjs&logoColor=white">
<img alt="PostgreSQL 16" src="https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white">
<img alt="Redis 7 (Compose default)" src="https://img.shields.io/badge/Redis-7%20Compose%20default-DC382D?style=flat-square&logo=redis&logoColor=white">
<img alt="Socket.IO 4.8" src="https://img.shields.io/badge/Socket.IO-4.8-010101?style=flat-square&logo=socketdotio&logoColor=white">

<br>

<a href="#-live-demo"><img alt="Live demo" src="https://img.shields.io/badge/Live%20demo-FFB224?style=flat-square"></a>
<a href="#-highlights"><img alt="Highlights" src="https://img.shields.io/badge/Highlights-30363D?style=flat-square"></a>
<a href="#-features"><img alt="Features" src="https://img.shields.io/badge/Features-30363D?style=flat-square"></a>
<a href="#-architecture"><img alt="Architecture" src="https://img.shields.io/badge/Architecture-30363D?style=flat-square"></a>
<a href="#-redis-backed-rate-limiting"><img alt="Rate limiting" src="https://img.shields.io/badge/Rate%20limiting-30363D?style=flat-square"></a>
<a href="#-quick-start"><img alt="Quick start" src="https://img.shields.io/badge/Quick%20start-30363D?style=flat-square"></a>
<a href="#-what-is-verified-and-what-is-not"><img alt="Evidence" src="https://img.shields.io/badge/Evidence-30363D?style=flat-square"></a>
<a href="#-documentation-map"><img alt="Docs" src="https://img.shields.io/badge/Docs-30363D?style=flat-square"></a>

<br>

<sub>Registration is invite-only (public registration is disabled in production by design). The demo runs on a free tier, so the first request after idle time can be slow.</sub>

</div>

---

## 🌐 Live demo

> [!TIP]
> **No setup needed.** Open the app, sign in with the read-only account below, and explore three synthetic incidents in different lifecycle states.

| | |
|---|---|
| 🌐 **App** | https://incident-intelligence-free-demo.onrender.com |
| 📧 **Email** | `` |
| 🔑 **Password** | Request the current shared Viewer password from the repository maintainer through [GitHub](https://github.com/aayushtiwari307). |
| 👁️ **Role** | **Viewer** (read-only) |

> [!NOTE]
> **Read-only demo account.** You can look at everything the Viewer role allows, but you cannot change incidents, manage the team or see integration credentials.
>
> **Registration remains invitation-only by design.** There is no public sign-up, and this demo account does not change that.

### Try it in about a minute

1. Open the app. The first load after idle time can be slow because the free-tier host has to wake up; give it a moment.
2. Sign in with the email above and the shared password provided by the repository maintainer.
3. Open the **Incidents** list and **start with these three synthetic incidents**, which cover different lifecycle states:

   | Incident | Title | State |
   |---|---|---|
   | INC-0007 | API Latency Spike | 🔴 Triggered |
   | INC-0008 | Notification Delivery Backlog | 🟡 Investigating |
   | INC-0009 | Database Connection Pool Saturation | 🟢 Resolved |

   The list also contains older records created while the platform was being tested. They are engineering verification records, apart from **INC-0002**, which is referenced in the next step.

4. Open any of the three. Each one has a **service association** (the *IIP Live Verification Service*), and the detail view includes similar-incident information. For a **populated service/change-event example**, open **INC-0002**: its service/change context shows a change event and is labelled *"correlation, not proven cause"*.
5. Open **Services** to see the service the three new incidents are attached to.

### What the Viewer account can and cannot do

| As a Viewer you can | By design you cannot |
|---|---|
| ✅ Browse incidents and open incident details | ⛔ Change an incident's status |
| ✅ See services and service/change context | ⛔ Manage the team or invitations |
| ✅ See similar-incident information | ⛔ See integration credentials or management controls |
| ✅ Use the other read-only pages | ⛔ Create an account (registration is invite-only) |

Because the demo is read-only, it does **not** show the write-side workflows live: status transitions, alert intake and deduplication, real-time updates between users, or AI suggestions. Those are covered by automated tests and recorded runs; see [what is verified, and what is not](#-what-is-verified-and-what-is-not).

### What was actually checked for this demo (2026-11-07)

| Check | Result |
|---|---|
| Viewer signs in and can open incidents, services, service/change context and similar-incident information | ✅ Checked in the UI |
| One **direct** status-transition request made with the Viewer's session | ✅ Rejected with `HTTP 403 FORBIDDEN`; the incident stayed unchanged (Triggered, version 2) |
| Team page as a Viewer | ✅ No integration secrets or management controls visible |
| Every other write endpoint probed directly with the Viewer session | ⚪ **Not done.** Only the status transition was tested this way. Role enforcement for the rest is described in the [security model](#-security-model) and is not independently claimed here |

### Demo notes

| | |
|---|---|
| 🧪 **Synthetic data only.** | The incidents are made up for demonstration. Please do not enter real personal or company information. |
| 🔑 **Shared demo account.** | The Viewer account is shared with demo visitors. The password is provided separately; never reuse it for any other account or service. |
| 📧 **Member emails are visible.** | The Team page shows member email addresses to the Viewer. This is a known, accepted trade-off for a public demo. |
| ⏳ **Typos and lockouts.** | Failed sign-ins are rate-limited per account and IP (5 attempts per 15 minutes; see [rate limiting](#-redis-backed-rate-limiting)). If you get locked out, wait and try again. |
| 🤖 **AI is off in the demo.** | AI suggestions are not enabled for the demo organization. |
| ☁️ **Free-tier host.** | The demo runs on Render Free + Neon Free as a single API instance, so expect slow first loads. |

---

## 📌 Status at a glance

> [!NOTE]
> **As of 2026-11-10, the core platform and its documented milestones are implemented, with a free-tier public demo available.** Individual verification results and remaining limitations are documented [below](#-what-is-verified-and-what-is-not). CI is green on `main`.
>
> A public, read-only demo account is available (see [Live demo](#-live-demo)).

| | |
|:-:|---|
| 🚦 | **Redis-backed rate limiting has been implemented and tested through [PR #9](https://github.com/aayushtiwari307/incident-intelligence-platform/pull/9); Redis is enabled by default in the local Docker Compose app profile through [PR #10](https://github.com/aayushtiwari307/incident-intelligence-platform/pull/10).** Redis is not configured on the public Render demo, which runs a single API instance. |
| ⚡ | On Render, the backend real-time listener started successfully (`listening: true`) and the frontend real-time build flag is enabled; a live two-tab, same-session test passed earlier. |
| 🤖 | The Gemini provider is enabled in the Render server configuration, but each organization must still opt in separately. One genuine Gemini request was verified **locally with synthetic data**; **no Gemini request has been made from the public Render deployment**. |
| ⏱️ | A GitHub Actions keepalive (five-minute schedule, best-effort) was added. |

---

## 🎯 Highlights

<table>
  <tr>
    <td valign="top" width="50%">

🏢 **Multi-tenant by design:** four RBAC roles, tenant taken from the session only, and composite foreign keys so the database itself refuses cross-tenant links.

</td>
    <td valign="top" width="50%">

🚦 **Distributed rate limiting:** atomic sliding-window limits in Redis (Lua scripts, Redis server time) across seven policies, each with its own fail-open or fail-closed behaviour.

</td>
  </tr>
  <tr>
    <td valign="top" width="50%">

📨 **No message broker needed:** a dur

…

Worked for 2m 5s
Updated README ready
Download the updated README.md

I preserved your existing structure, diagrams, features, architecture and documentation. I only updated the sections affected by the latest code changes and test results.

What I updated
Project status: Updated to November 11, 2026, and added PR #11.

Real-time configuration: Clarified that Render real-time is now configured OFF pending production acceptance.

Verification evidence: Added the 47/47 API configuration tests and 20/20 smoke checks.

Socket.IO benchmark: Added the actual results:

Metric

Result

p50

19.7 ms

p95

26.4 ms

p99

34.6 ms

Events delivered

320/320

Cross-organization leakage

0

Project status: Updated completed and remaining real-time verification tasks.

Local testing instructions: Clarified the direct database URL requirement and frontend rebuild requirement.

I also explicitly documented that the benchmark was sequential and measured REST-request-start to event-received latency, not pure WebSocket transport latency.

Validation: Markdown code fences and internal section links checked.

This is a downloadable README copy; I haven't modified your local repository or committed anything.


README.md
Document
This might also interest you.



<div align="center"><img alt="" width="100%" src="https://capsule-render.vercel.app/api?type=waving&height=150&color=0:FFB224,100:E0234E&section=header">
Incident Intelligence Platform
A multi-tenant incident operations platform that turns raw alerts into context-rich, auditable incidents.

Alert intake and deduplication · similar-incident retrieval · change correlation · GitHub context · opt-in grounded AI · Redis-backed rate limiting.

Built on a zero budget, with every safety claim backed by a test or marked as unverified.


<a href="https://incident-intelligence-free-demo.onrender.com"><img alt="Open the live demo" src="https://img.shields.io/badge/live%20demo-open%20the%20app-FFB224?style=for-the-badge&labelColor=0B0B0C"></a>


<a href="https://github.com/aayushtiwari307/incident-intelligence-platform/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/aayushtiwari307/incident-intelligence-platform/ci.yml?branch=main&style=flat-square&label=CI"></a>
<img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
<img alt="Budget: zero rupees" src="https://img.shields.io/badge/budget-%E2%82%B90-brightgreen?style=flat-square">

<img alt="Node 22" src="https://img.shields.io/badge/Node-22-339933?style=flat-square&logo=nodedotjs&logoColor=white"> <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white"> <img alt="NestJS 11" src="https://img.shields.io/badge/NestJS-11-E0234E?style=flat-square&logo=nestjs&logoColor=white"> <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=nextdotjs&logoColor=white"> <img alt="PostgreSQL 16" src="https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white"> <img alt="Redis 7 (Compose default)" src="https://img.shields.io/badge/Redis-7%20Compose%20default-DC382D?style=flat-square&logo=redis&logoColor=white"> <img alt="Socket.IO 4.8" src="https://img.shields.io/badge/Socket.IO-4.8-010101?style=flat-square&logo=socketdotio&logoColor=white">
<a href="#-live-demo"><img alt="Live demo" src="https://img.shields.io/badge/Live%20demo-FFB224?style=flat-square"></a>
<a href="#-highlights"><img alt="Highlights" src="https://img.shields.io/badge/Highlights-30363D?style=flat-square"></a>
<a href="#-features"><img alt="Features" src="https://img.shields.io/badge/Features-30363D?style=flat-square"></a>
<a href="#-architecture"><img alt="Architecture" src="https://img.shields.io/badge/Architecture-30363D?style=flat-square"></a>
<a href="#-redis-backed-rate-limiting"><img alt="Rate limiting" src="https://img.shields.io/badge/Rate%20limiting-30363D?style=flat-square"></a>
<a href="#-quick-start"><img alt="Quick start" src="https://img.shields.io/badge/Quick%20start-30363D?style=flat-square"></a>
<a href="#-what-is-verified-and-what-is-not"><img alt="Evidence" src="https://img.shields.io/badge/Evidence-30363D?style=flat-square"></a>
<a href="#-documentation-map"><img alt="Docs" src="https://img.shields.io/badge/Docs-30363D?style=flat-square"></a>


<sub>Registration is invite-only (public registration is disabled in production by design). The demo runs on a free tier, so the first request after idle time can be slow.</sub>

</div>
🌐 Live demo
[!TIP]
No setup needed. Open the app, sign in with the read-only account below, and explore three synthetic incidents in different lifecycle states.

🌐 App	https://incident-intelligence-free-demo.onrender.com
📧 Email	aayushtiwari004@gmail.com
🔑 Password	Request the current shared Viewer password from the repository maintainer through GitHub.
👁️ Role	Viewer (read-only)
[!NOTE]
Read-only demo account. You can look at everything the Viewer role allows, but you cannot change incidents, manage the team or see integration credentials.

Registration remains invitation-only by design. There is no public sign-up, and this demo account does not change that.

Try it in about a minute
Open the app. The first load after idle time can be slow because the free-tier host has to wake up; give it a moment.

Sign in with the email above and the shared password provided by the repository maintainer.

Open the Incidents list and start with these three synthetic incidents, which cover different lifecycle states:

Incident	Title	State
INC-0007	API Latency Spike	🔴 Triggered
INC-0008	Notification Delivery Backlog	🟡 Investigating
INC-0009	Database Connection Pool Saturation	🟢 Resolved
The list also contains older records created while the platform was being tested. They are engineering verification records, apart from INC-0002, which is referenced in the next step.

Open any of the three. Each one has a service association (the IIP Live Verification Service), and the detail view includes similar-incident information. For a populated service/change-event example, open INC-0002: its service/change context shows a change event and is labelled "correlation, not proven cause".

Open Services to see the service the three new incidents are attached to.

What the Viewer account can and cannot do
As a Viewer you can	By design you cannot
✅ Browse incidents and open incident details	⛔ Change an incident's status
✅ See services and service/change context	⛔ Manage the team or invitations
✅ See similar-incident information	⛔ See integration credentials or management controls
✅ Use the other read-only pages	⛔ Create an account (registration is invite-only)
Because the demo is read-only, it does not show the write-side workflows live: status transitions, alert intake and deduplication, real-time updates between users, or AI suggestions. Those are covered by automated tests and recorded runs; see what is verified, and what is not.

What was actually checked for this demo (2026-11-07)
Check	Result
Viewer signs in and can open incidents, services, service/change context and similar-incident information	✅ Checked in the UI
One direct status-transition request made with the Viewer's session	✅ Rejected with HTTP 403 FORBIDDEN; the incident stayed unchanged (Triggered, version 2)
Team page as a Viewer	✅ No integration secrets or management controls visible
Every other write endpoint probed directly with the Viewer session	⚪ Not done. Only the status transition was tested this way. Role enforcement for the rest is described in the security model and is not independently claimed here
Demo notes
🧪 Synthetic data only.	The incidents are made up for demonstration. Please do not enter real personal or company information.
🔑 Shared demo account.	The Viewer account is shared with demo visitors. The password is provided separately; never reuse it for any other account or service.
📧 Member emails are visible.	The Team page shows member email addresses to the Viewer. This is a known, accepted trade-off for a public demo.
⏳ Typos and lockouts.	Failed sign-ins are rate-limited per account and IP (5 attempts per 15 minutes; see rate limiting). If you get locked out, wait and try again.
🤖 AI is off in the demo.	AI suggestions are not enabled for the demo organization.
☁️ Free-tier host.	The demo runs on Render Free + Neon Free as a single API instance, so expect slow first loads.
📌 Status at a glance
[!NOTE]
As of 2026-11-11, the core platform and its documented milestones are implemented, with a free-tier public demo available. Individual verification results and remaining limitations are documented below. CI is green on main.

A public, read-only demo account is available (see Live demo).

🚦	Redis-backed rate limiting has been implemented and tested through PR #9; Redis is enabled by default in the local Docker Compose app profile through PR #10. Redis is not configured on the public Render demo, which runs a single API instance.
⚡	Real-time updates are implemented and verified locally: the container smoke test passed 20/20 checks, and a 300-event sequential Socket.IO benchmark passed with cross-organization isolation. The Render configuration now sets both real-time flags to false through PR #11, pending production acceptance. An already-running Render deployment picks up this setting only after redeployment.
🤖	The Gemini provider is enabled in the Render server configuration, but each organization must still opt in separately. One genuine Gemini request was verified locally with synthetic data; no Gemini request has been made from the public Render deployment.
⏱️	A GitHub Actions keepalive (five-minute schedule, best-effort) was added.
🎯 Highlights
<table> <tr> <td valign="top" width="50%">
🏢 Multi-tenant by design: four RBAC roles, tenant taken from the session only, and composite foreign keys so the database itself refuses cross-tenant links.

</td> <td valign="top" width="50%">
🚦 Distributed rate limiting: atomic sliding-window limits in Redis (Lua scripts, Redis server time) across seven policies, each with its own fail-open or fail-closed behaviour.

</td> </tr> <tr> <td valign="top" width="50%">
📨 No message broker needed: a durable PostgreSQL job queue (SKIP LOCKED, leases, fencing) and real-time updates via LISTEN/NOTIFY + Socket.IO.

</td> <td valign="top" width="50%">
🛡️ Safe AI: incident context is best-effort redacted before it is sent to the provider; generated output is independently schema- and provenance-validated (verbatim-quote citations) and applied only by a human.

</td> </tr> <tr> <td valign="top" colspan="2">
🧪 Evidence over claims: CI, 324 API tests and 21 dedicated Redis tests, 20/20 container smoke checks, a 300-event local real-time benchmark, a real Alertmanager sender and a backup/restore drill, each marked verified or unverified below.

</td> </tr> </table>
✨ Features
Capability	What it does
🏢 Multi-tenant workspaces	Organizations with four roles (viewer → responder → admin → owner), email-bound single-use invitations, and invite-only registration in production. Tenant identity always comes from the authenticated session, never from the request.
🔐 Hardened auth	scrypt password hashing, opaque revocable sessions stored hashed, HttpOnly __Host- cookie, CSRF and browser-`Origin` checks, and Redis-backed rate limits on login and registration.
🚦 Distributed rate limiting	Seven policies enforced by atomic Redis sliding windows, with in-memory limiting when Redis is not configured. Covers login, registration, Alertmanager intake, failed webhook authentication and AI requests.
🔄 Incident lifecycle	Validated status transitions, optimistic concurrency (stale writes get 409), and an append-only, audited timeline of every change.
🚨 Alertmanager intake	POST /api/v1/integrations/alertmanager accepts Prometheus Alertmanager webhook v4, authenticates with a hashed bearer credential (rotate / revoke supported), and deduplicates by integration + fingerprint + startsAt.
🔎 Similar incidents (no AI)	PostgreSQL weighted full-text search over resolved incidents, tenant-scoped, with matched terms shown. Includes a reproducible evaluation harness.
🤖 Grounded AI suggestions (opt-in)	Gemini 3.5 Flash-Lite provider (a mock provider is used in tests), enabled server-side by configuration, with each organization opting in separately. The model sees the incident plus at most five similar resolved incidents, best-effort redacted. Output is validated against a strict schema and must cite sources by alias with verbatim quotes (provenance check). Suggestions are rate-limited and quota-limited, and only a human can apply them.
🧭 Service and change context	Per-organization service catalog, a separate change-event webhook (idempotent), and an incident panel listing changes from the 24 hours before the incident, labelled "correlation, not proven cause."
🐙 GitHub issue/PR enrichment	Opt-in per organization with a repository allow-list. Public data only, fixed api.github.com origin, no redirects, bounded responses, ETag caching, quota-aware rate limiting and a circuit breaker. No GitHub token is stored.
⚡ Real-time updates	Socket.IO fed by PostgreSQL LISTEN/NOTIFY. The handshake checks the session cookie and Origin; only organization-filtered messages are broadcast. Requires a dedicated direct (non-pooled) database URL and explicit opt-in. Verified locally with the 20/20 container smoke test and the benchmark below; disabled in the current Render configuration pending production acceptance (PR #11).
🗃️ Durable job queue	PostgreSQL-backed and independent of Redis or a separate message broker: FOR UPDATE SKIP LOCKED, leases with fencing, retries with backoff, and poison-job isolation so one bad job cannot starve healthy ones.
🖥️ Control Room UI	A dark, keyboard-friendly interface with a sidebar, status progress track, severity indicators and instructive empty states. Deployed on the live demo.
🏗 Architecture
Rate-limit decision flow
From alert to context
Design stance: a modular monolith with a background worker. PostgreSQL is the single source of truth for application data and the background job queue. There is no ORM (handwritten SQL with pg and numbered, never-edited migrations). Redis is enabled by default in the Docker Compose app profile for distributed rate limiting; standalone API processes use the in-memory fallback when REDIS_URL is unset. No paid services are required for local development.

🚦 Redis-backed rate limiting
[!IMPORTANT]
Status: implemented, tested, and merged through PR #9. Redis was enabled by default in the local Docker Compose app profile through PR #10.

The API uses one asynchronous RateLimiter interface (consume(), peek(), reset()) for both process-local and distributed limiting. The Docker Compose app profile defaults REDIS_URL to redis://redis:6379 and starts the API only after both PostgreSQL and Redis report healthy. This enables shared rate-limit state across API processes in the local Compose stack. For a non-Compose API process, leaving REDIS_URL unset selects the in-memory SlidingWindowLimiter.

Policies
#	Policy	Scope	Limit	Window	If Redis is unavailable
1	Login by IP	Per IP	100	15 min	🔒 Fail closed
2	Login by account	Per account + IP	5	15 min	🔒 Fail closed
3	Registration by IP	Per IP	10	1 hour	🔒 Fail closed
4	Alertmanager by IP	Per IP	600	1 min	🔓 Fail open → in-memory fallback (process-local limits still enforced)
5	Webhook failed authentication	Failed attempts	20	5 min	🔒 Fail closed
6	Alertmanager integration	Per integration	300	1 min	🔓 Fail open → in-memory fallback (process-local limits still enforced)
7	AI requests by user	Per user, global across organizations	5	10 min	🔒 Fail closed
A valid Alertmanager integration is never rejected solely because the failed-authentication preflight cannot reach Redis; invalid credentials still fail closed. Registration uses a more permissive 10,000/hour override in the test environment only.

Engineering details
Concern	How it works
⚛️ Atomic sliding window	Requests are recorded in Redis Sorted Sets, one member per unique request. Lua scripts remove expired entries and enforce the policy counter in a single atomic call, so concurrent API instances cannot race each other. The scripts back consume(), peek() and reset().
🕒 Redis server time	The scripts take their timestamp from Redis itself, not from the application host, so clock skew between API instances cannot distort a window.
🎚️ Policy-specific failure mode	Security-sensitive entry points (login, registration, failed webhook authentication, AI requests) fail closed: an outage cannot become a way around the limit. The two Alertmanager policies (by IP, by integration) fail open to the in-memory limiter during a Redis outage, so alert delivery keeps working. That fallback still enforces limits, but only per API process, not across instances.
⏱️ Bounded connection handling	TCP connect is capped at 1 s. The full Redis handshake and each dispatched command have separate 5 s absolute deadlines. Commands waiting to be written have a 1 s queue timeout. A timed-out operation destroys its client, offline queuing is disabled, and the next request reconnects after a short cooldown. Redis clients are closed on API shutdown.
🕵️ Privacy-safe keys	Key = fixed application prefix + version + one of the seven policy namespaces + a SHA-256 hash of the identity. Raw email addresses and IP addresses never appear in Redis keys. Every key has a TTL and expires after its policy window.
👤 AI limits follow the user	The AI limiter is keyed on the user's global user ID, so switching organizations does not reset the allowance.
♻️ Successful-login reset	A successful login resets that account's login counter, so legitimate users are not locked out by earlier typos. Failed attempts keep counting.
<details> <summary><b>Run it locally</b> (Compose defaults to Redis)</summary>
Start PostgreSQL, Redis and the API through the app profile. The API waits for both dependencies to become healthy. Redis is exposed on loopback at 127.0.0.1:6381; Compose containers use redis://redis:6379:

docker compose --profile app up -d postgres redis api
For an API process running directly on the host, configure:

# PowerShell
$env:REDIS_URL="redis://127.0.0.1:6381"

# CMD
set REDIS_URL=redis://127.0.0.1:6381

# Bash
export REDIS_URL="redis://127.0.0.1:6381"
A standalone API process with REDIS_URL unset uses in-memory limiting. Run the dedicated Redis test suite with:

npm run test:redis -w @platform/api   # needs Redis 7 and a loopback TEST_DATABASE_URL
</details>
Scope of the claim. CI runs the dedicated Redis suite against Redis 7. The local two-process Compose verification is recorded in the verification section. The Render demo remains a single API instance with no Redis/Valkey service configured; production multi-instance behaviour has not been verified.

🧰 Tech stack
Layer	Choice
🖥️ Web	Next.js 16 (App Router), React 19, TypeScript
⚙️ API	NestJS 11 with framework-free handlers behind thin controllers
🗄️ Data	PostgreSQL 16, raw SQL via pg, 14 numbered migrations
🚦 Rate limiting	Redis 7 sliding window (atomic Lua scripts; enabled by default in the Compose app profile), with an in-memory fallback for standalone API processes
⚡ Real-time	Socket.IO 4.8 over PostgreSQL LISTEN/NOTIFY
✅ Validation	Zod 4, shared between API and web (packages/shared)
🤖 AI (optional)	Gemini 3.5 Flash-Lite adapter with schema-validated, citation-checked output
🧪 Testing	Jest, real-PostgreSQL and real-Redis integration tests, Node test runner for scripts
📦 Delivery	Docker Compose, Caddy single-origin proxy, GitHub Actions (CI + best-effort keepalive)
☁️ Hosting (demo)	Render Free + Neon Free (₹0)
🚀 Quick start
Requirements: Node 22+, npm 10+, Docker (for the local PostgreSQL). Windows CMD and PowerShell walkthroughs are in `docs/DEVELOPMENT.md`.

npm ci
npm run setup:env      # creates a local .env with generated secrets
npm run services:up    # starts PostgreSQL on 127.0.0.1:5545
npm run migrate        # applies migrations 0001-0014
npm run dev:api        # API on http://127.0.0.1:3001
# in a second terminal
npm run dev:web        # web on http://127.0.0.1:3000
[!WARNING]
Open http://127.0.0.1:3000. The session cookie is host-only. Use 127.0.0.1 consistently instead of switching between localhost and 127.0.0.1; a cookie set for one hostname is not sent to the other.

The Quick Start commands above run the API directly on the host, so it uses in-memory rate limiting unless REDIS_URL is configured. The Docker Compose app profile enables Redis-backed distributed limiting by default. See Run it locally for the Compose setup.

Try the integrations locally (loopback only, tokens are created in the Team page and never committed):

npm run simulate:alertmanager   # fire sample alerts at the Alertmanager webhook
npm run simulate:change         # send a sample deploy/change event
🧪 Testing
npm run check:deps && npm run check:hygiene
npm run typecheck && npm run lint
npm test                    # unit tests (scripts, shared, API, web)
npm test -w @platform/api   # API unit tests only, with Redis-specific tests excluded
npm run test:integration    # real PostgreSQL, loopback only
npm run test:redis -w @platform/api  # dedicated real-Redis tests; Redis 7 and loopback TEST_DATABASE_URL must be available
npm run build
npm run smoke:stack         # against the running container stack
smoke:stack also checks real-time. For a local run, set REALTIME_ENABLED=true and a dedicated direct REALTIME_DATABASE_URL in your .env, then rebuild/recreate the API and web containers with docker compose --profile app up -d --build api web. Compose passes REALTIME_ENABLED to NEXT_PUBLIC_REALTIME_ENABLED for the Next.js build so the API listener and browser client agree.

Integration tests fail closed unless the database host is loopback, so they cannot touch a hosted database. CI also builds the full container stack, smoke-tests HTTP and WebSocket behaviour (including a negative control that must fail when real-time is off), and repeats the smoke test through the single-origin proxy.

✅ What is verified, and what is not
Every claim here is tied to a date and a kind of evidence. Nothing is rounded up.

Redis rate limiting (PR #9) · final verified results
Check	Result
Redis test suites	✅ 3/3 passed
Redis tests	✅ 21/21 passed
Full API test suites	✅ 31/31 passed
Full API tests	✅ 324/324 passed
API typecheck	✅ Passed
API build	✅ Passed
Local Compose distributed check (2026-11-10)
Two independent API containers shared the same Compose Redis service. A manual HTTP run sent 200 POST /api/auth/login requests, split evenly between the two API processes. Each request used a unique synthetic account and invalid credentials, so a 401 indicates that it passed the login-IP rate limiter and reached authentication.

Check	Result
API processes	2 independent containers using redis://redis:6379
Requests	200 total; 100 sent to each API
API 1 responses	50 401, 50 429
API 2 responses	50 401, 50 429
Total responses	100 401, 100 429
Shared Redis counter	1 login-IP sorted-set key with 100 members
Unexpected responses/errors	0
Cleanup	Temporary API container and test Redis key removed
This was a manual local verification, not a checked-in automated test. It demonstrates shared rate-limit enforcement in the local Compose environment; it does not establish production deployment behaviour.

Local Compose real-time verification (2026-11-11)
The real-time configuration changes were verified locally with the API and web containers explicitly enabled. The API environment configuration suite passed 47/47 tests, and npm run smoke:stack passed 20/20 checks, including authenticated Socket.IO connection, event delivery, foreign-Origin rejection, cross-organization isolation and session logout.

A separate sequential benchmark ran node scripts/bench-realtime-latency.mjs 100 3. It created 300 incidents in organization A and 20 in organization B using two synthetic accounts and two independent Socket.IO clients.

Measurement	Result
Organization A events delivered	300/300
Organization B events delivered	20/20
Timeouts	0
Create-request-start to Socket.IO event p50	19.7 ms
Create-request-start to Socket.IO event p95	26.4 ms
Create-request-start to Socket.IO event p99	34.6 ms
Organization A events received by B	0/300
Organization B events received by A	0/20
Measurement scope: latency starts immediately before the REST create request and ends when the corresponding Socket.IO event is received. It includes REST/database processing and notification delivery; it is not a measurement of WebSocket transport latency alone. Requests were sequential, with a short pause between events—not a concurrent-load benchmark. These are local Docker Compose results, not production Render measurements.

Platform-wide evidence
Area	Evidence	Status
🚦 Redis rate limiting	Implemented, tested and merged through PR #9 into main; Redis defaults in the local Compose app profile through PR #10. The local two-process check is documented above. No Redis/Valkey service is configured for the single-instance Render demo; production multi-instance behaviour is not established.	✅ Verified in tests · demo not Redis-backed
🧩 Whole platform	Windows run on 2026-10-25 at d89f800: clean npm ci, typecheck, lint, 537 unit/script tests, 271 real-PostgreSQL integration tests (21 suites), production build. These counts are from that earlier commit and are not directly comparable to the API-only figures above.	✅ Verified locally
📦 Container stack	smoke:stack passed 20/20 checks against rebuilt images, including real-time authentication, delivery, tenant isolation and logout.	✅ Verified locally
☁️ Demo deployment	Render Free + Neon at https://incident-intelligence-free-demo.onrender.com; /health/live and /health/ready return OK.	✅ Live runtime verified
👁️ Public demo access	A Viewer account created through the normal Team invitation flow, with three synthetic incidents (INC-0007 to INC-0009). Viewer read access was checked in the UI; one direct status-transition request with the Viewer session returned 403 FORBIDDEN and left the incident unchanged; the Team page showed no integration secrets or management controls. Other write endpoints were not individually probed with the Viewer session. Details in Live demo.	🟡 Partially verified (2026-11-07)
⏱️ Keepalive workflow	A GitHub Actions workflow is scheduled every five minutes to ping the Render service. Scheduled runs are best-effort: GitHub may delay or skip them. The first manual run received HTTP 200 from Render; reliable recurring scheduled execution has not been verified.	🟡 Manual run verified · scheduled runs unverified
🔁 Continuous integration	Latest run on main is green.	✅ Passing
🛡️ Dependency audit	npm audit reported 0 vulnerabilities on the 2026-10-25 tree (547 packages).	✅ Clean on 2026-10-25
🐙 GitHub enrichment	Repository/PR association and the API/UI paths are implemented and tested. Live PR/issue detail retrieval remains unverified: the earlier live attempt returned rate_limited.	🟡 Live detail retrieval unverified
🧭 Service and change context	Live change event live-check-001 appeared in Incident #3's service/change context, and the service association and event details persisted after refresh. Correlation is contextual evidence only; causation is not proven.	✅ Live persistence verified
🔑 Registration policy	Invite-only default in production, covered by code and tests.	🟡 Not separately checked on the live service
⚡ Real-time	Locally, the 20/20 container smoke test and the 300-event sequential benchmark verified authenticated delivery, cross-organization isolation and logout handling. The current Render Blueprint sets both API and frontend real-time flags to false through PR #11, pending production acceptance. An already-running Render deployment reflects this change only after redeployment; production reconnect/resync and independent-user acceptance remain unverified.	✅ Local verification · 🟡 production acceptance pending
🚨 Alertmanager intake	8 synthetic live scenarios passed (including 5 concurrent deliveries → 1 incident + 4 duplicates). A real prom/alertmanager container then delivered an authenticated alert to the deployed app and created Incident #6. Deduplication and resolution were verified with the synthetic scenarios.	✅ Verified
🤖 Grounded AI (Gemini)	Gemini 3.5 Flash-Lite provider. One genuine request was run locally on a synthetic incident; it returned source-grounded suggestions that passed the existing validation flow. Provider tests passed 5/5. The provider is enabled in the Render server configuration, but organization-level opt-in is separate. An OpenAI adapter exists with unit tests only.	🟡 Verified locally on synthetic data · no Gemini request has been made from the public Render deployment
💾 Backup / restore	Guarded scripts and focused safety tests; a disposable local PostgreSQL backup/restore verification passed on 2026-11-02.	✅ Verified locally, not a production restore drill
<details> <summary><b>Retrieval quality</b></summary>
On a synthetic, single-author corpus of 32 resolved incidents, weighted English full-text search scored Recall@5 0.82 against 0.60 for a plain full-text baseline (+0.22; paired bootstrap interval +0.09 to +0.34). The point estimate met the pre-declared +0.10 gate, but the interval's lower bound does not, and the corpus is not production data. Treat it as a regression guard, not proof of real-world relevance. Protocol and corpora are in `docs/verification/`.

</details>
🔒 Security model
🏢 Tenancy:	the organization comes from session membership. Tenant tables use composite foreign keys, and cross-tenant reads return 404.
🛂 Authorization:	enforced in the API by role; the browser is never trusted.
🚦 Abuse protection:	seven rate-limit policies cover login, registration, Alertmanager intake, failed webhook authentication and AI requests. Auth-sensitive policies fail closed, and Redis keys contain only hashed identities. See Redis-backed rate limiting.
🪝 Webhooks:	bearer credentials are shown once and stored only as hashes. Alert and change credentials are different kinds and cannot be swapped. The body is read only after the credential is verified and is size-capped.
🌍 Outbound calls:	GitHub requests go only to a fixed origin, with no redirects, response-size caps and sanitised remote text. External content is never sent to AI.
🤖 AI safety:	opt-in per organization, a per-user rate limit and a daily quota. Incident context is best-effort redacted before it is sent to the provider. Generated output is independently validated: a strict output schema, and citations that must quote the sent source verbatim. Changes are applied only by a human. Redaction is best-effort, not a guarantee. Citations prove where text came from, not that it is correct, and the UI says to verify.
🛠️ Operations:	migrations are never edited after being applied, destructive scripts are loopback-only, and the repository hygiene check blocks secret-looking files.
🎓 Engineering concepts this project demonstrates
⚛️ Atomic sliding-window rate limiting: Redis Lua scripts with server-side time, so concurrent instances share one consistent window.	🎚️ Fail-open vs fail-closed design: the failure mode is chosen per policy, based on what an outage would put at risk.
🔄 Optimistic concurrency control: version checks return 409 instead of silently overwriting.	♻️ Idempotency: webhook deduplication and unique keys make retries safe.
🔐 Row-level locking: FOR UPDATE, FOR KEY SHARE and SKIP LOCKED for races and queue claiming.	🪪 Lease fencing: a stale worker cannot commit a job it no longer owns.
🏢 Composite foreign keys for multi-tenancy: the database itself refuses cross-tenant links.	📡 LISTEN/NOTIFY: push updates without a message broker.
🗂️ Conditional HTTP caching (ETag) and a circuit breaker for an external API.	🧾 Provenance checking for LLM output: verbatim-quote validation instead of trusting the model.
📊 Bootstrap confidence intervals: honest evaluation on a small corpus.	
🗺 Project status
Implemented


Multi-tenant auth, organizations, four roles and email-bound invitations

Incident lifecycle with audit timeline and optimistic concurrency

Durable PostgreSQL job queue

Real-time updates (Socket.IO over LISTEN/NOTIFY; local smoke and two-organization isolation verified; Render rollout disabled pending acceptance)

Alertmanager intake with deduplication

Similar-incident retrieval, with an evaluation harness

Opt-in grounded AI suggestions (Gemini provider)

GitHub issue/PR enrichment (association and API/UI paths)

Service catalog and change-event context

Redis-backed rate limiting and dedicated Redis tests (PR #9)

Redis enabled by default in the local Docker Compose app profile (PR #10)

Real-time environment defaults and Render rollout gate corrected (PR #11)

Control Room UI

Free-tier deployment on Render + Neon, best-effort keepalive, and a public read-only Viewer demo
Still open

Successful live GitHub PR/issue detail retrieval
Production real-time acceptance after the Render configuration is redeployed (same-organization multi-user updates, reconnect/resync and session revocation)
Verified recurring scheduled keepalive runs (only a manual run so far)
📚 Documentation map
Topic	Where
💻 Local development (Windows and Unix)	
`docs/DEVELOPMENT.md`
🧱 Architecture decisions	
`docs/decisions/`
🚨 Alertmanager webhook	
`docs/integrations/alertmanager.md`
🔀 Change-event webhook	
`docs/integrations/change-events.md`
🤖 Gemini grounded suggestions	
`docs/integrations/gemini-ai-suggestions.md`
🐙 GitHub enrichment design	
`docs/design/github-issue-enrichment.md`
🧭 Service and change context design	
`docs/design/m10-service-change-context.md`
☁️ Free deployment guide	
`docs/deployment/m6-free-deployment.md`
⚡ Real-time rollout	
`docs/deployment/realtime-rollout.md`
✅ Verification records	
`docs/verification/`
🔒 Security and dependency notes	
`docs/security/`
🧠 Project memory and handoff	`PROJECT_MEMORY.md`, `docs/HANDOFF.md`
📄 License and attribution
Released under the MIT License. Third-party notices are in `THIRD_PARTY_NOTICES.md`.

<div align="center">
<sub>Built by <a href="https://github.com/aayushtiwari307">Aayush Tiwari</a> · Zero budget, zero hand-waving.</sub>

<img alt="" width="100%" src="https://capsule-render.vercel.app/api?type=waving&height=120&color=0:E0234E,100:FFB224&section=footer"></div>




⋮⋮⋮⋮
