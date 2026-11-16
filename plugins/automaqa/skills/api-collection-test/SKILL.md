---
name: api-collection-test
description: Test a REST API from a Postman collection — find every required input (host, auth tokens, IDs, mandatory params, values that depend on earlier responses), ask the user only for what is missing, then run each request safely, check status codes and response payloads, and produce a pass/fail HTML report with categorised issues.
when_to_use: Use when the user provides a Postman collection (.json), or asks to test, smoke-test, validate or regression-check an API/backend from a collection. Trigger on "postman collection", "api collection", "test the api", "validate the endpoints", "check response codes", "api test report", "run the collection", "api smoke test", or any path ending in .postman_collection.json.
argument-hint: [path/to/collection.postman_collection.json]
---

# API Collection Test

Turns a Postman v2.x collection into a validated run: discover inputs → fill the gaps with
the user → execute safely → verify status and payload → report.

Unlike the UI skills this one needs **no browser or device** — only Node 18+.

**Scripts** live in `${CLAUDE_PLUGIN_ROOT}/scripts/api/` (zero dependencies):

| Script | Job |
|---|---|
| `analyze.js` | Parse the collection → `plan.json` (requests, run order, input table, findings) and `inputs.json` |
| `run.js` | Execute the plan, validate responses, write `results.json` + the report |
| `report.js` | Render `results.json` as HTML/Markdown (run.js calls it; rerunnable alone) |

**Output** goes to the user's cwd under `.automaqa/api/` (`.automaqa/*` is already git-ignored, which is
what keeps `inputs.json` — your secrets file — out of git):

```
.automaqa/api/plan.json            what will run, in what order, needing what
.automaqa/api/inputs.json          values + secrets + aliases + overrides  (never commit)
.automaqa/api/results.json         redacted run results
.automaqa/api/reports/latest.html  the report (also api-report-<timestamp>.html/.md)
```

---

## Hard rules

1. **Read-only by default.** Never run with `--mode full` unless the user has confirmed the target is a
   **test / staging / QA** environment, in their own words, in this conversation.
2. **Never put real credentials in chat or in your replies.** Tell the user to fill the `secrets` block of
   `inputs.json` (or export `AUTOMAQA_API_<NAME>` env vars) themselves. If they paste a token anyway, write it to
   `inputs.json` → `secrets`, and never repeat it back.
3. **Three separate unlocks, each needs its own explicit yes:**
   - writes (POST/PUT/PATCH) → `--mode full --confirm-host <hostname>`
   - DELETEs and deletion-like calls → `--allow-destructive`
   - calls that send e-mail / SMS / OTP / invitations / notifications → `--allow-sensitive`
   One "yes" never covers the others. Do not pass a flag the user did not approve.
4. **Production.** `run.js` refuses writes to hosts that do not look like a test environment. Do not add
   `--allow-production-writes` unless the user explicitly says they intend to write to production, and say plainly
   what that means first.
5. **Do not make failures pass.** Never edit expectations, aliases, or overrides to turn a red result green.
   A failing request is a finding. Report it.
6. **Check token expiry before a run.** `run.js` stops (exit 2) when a JWT secret is already expired and warns when
   one expires within 10 minutes (it prints names and times only). Refresh the token (step 2b); use
   `--ignore-expired` only when an expired token is intended (negative tests).
7. **Healthcare / personal data.** Collections like this often exercise real patient flows. Report bodies are
   masked (tokens, e-mail, phone, names, DOB, addresses) and are stored only for failing requests; keep it that way
   (`--bodies failures` is the default; use `all` only if the user asks and the environment holds no real data).

---

## Step 1 — Analyze

Ask for the collection path if not given. Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/api/analyze.js" "<collection.json>" --out .automaqa/api
# optional: --env "<postman_environment.json>"
```

Read the output to the user in plain language — don't paste the raw console dump:

- how many requests, by method; how many are writes / deletes / sensitive
- **findings** worth acting on: typo'd variables (auto-aliased), URLs with a stray leading `/`, requests that
  hardcode a host and ignore `{{host}}`, hard-coded tokens, requests that upload files, duplicates, and how
  many requests have no saved example or test script (those are checked for "2xx" only — say so honestly)

## Step 2 — Collect inputs (only what is missing)

`plan.json → inputs[]` classifies every `{{variable}}`:

| status | meaning | what you do |
|---|---|---|
| `provided` | already has a value (collection variable, env file, inputs.json, env var) | nothing |
| `derived` | a test script sets it, or an earlier list/create call will supply it at run time | nothing — mention it |
| `missing` | nothing supplies it | **ask the user** |

Ask in **one grouped message**, ordered by how many requests each blocks:

1. **Base:** `host` (include `https://`).
2. **Auth:** tokens (`*_token`). Either they paste tokens into `inputs.json` themselves, or you set up a
   `tokenRequests` entry so the run fetches them (see below). Ask which role each token represents — a provider
   token and a client/patient token are not interchangeable.
3. **Identity IDs** (`patient_id`, `provider_id`, `client_id` …): never guessed or derived — they decide whose data
   is read. They must exist on the target environment.
4. **Other IDs and values** (`date`, `assessment_code`, `phone_number` …).
5. **Mandatory-field hints:** `plan.requests[].placeholders` lists body/query fields that are blank or look like
   `<string>`. They are sent as-is and will often earn a 400. Ask whether the user wants to supply real values
   (`requestOverrides`, below) — otherwise tell them those 400s are expected.
6. **File uploads:** requests with `files` are skipped unless a path is given in `requestOverrides`.

Write the answers into `.automaqa/api/inputs.json`:

```jsonc
{
  "variables": { "host": "https://api.staging.example.com", "patient_id": "…", "date": "2026-11-05" },
  "secrets":   { "provider_token": "", "client_token": "" },          // user fills; never echo
  "aliases":   { "cleint_token": "client_token" },                    // typo fixes found by analyze
  "tokenRequests": {                                                  // optional: fetch tokens at run time
    "provider_token": {
      "url": "https://<tenant>.auth0.com/oauth/token",
      "body": { "grant_type": "password", "username": "…", "password": "…", "client_id": "…", "audience": "…" },
      "tokenPath": "access_token"
    }
  },
  "requestOverrides": {
    "Intake Form / Submit intake form / Submit intake form": {
      "body": { "answers.0.value": "Yes" },                           // dotted path into the JSON body
      "query": { "limit": "5" },
      "headers": {},
      "files": { "document": "C:/path/to/sample.pdf" }
    }
  }
}
```

`tokenRequests` is refreshed once automatically on a 401. If a token is `derived` from nothing and the user has
no credentials yet, say what is blocked and continue with what can run.

Re-run `analyze.js` after editing inputs to confirm nothing is still `missing` (it never overwrites a value).

### Step 2b — Tokens from a browser login (when `tokenRequests` cannot work)

Use this when the app signs in through a browser (Auth0/SSO/MFA) so a direct token call is not possible.
Do **not** use `automaqa:playwright-e2e` for this — it writes test suites; this is only a token capture.

1. Open the app with the Chrome DevTools tools. Ask the **user** to log in themselves, or to give QA test credentials.
   Never guess credentials and never look for `.env` files.
2. Run this in the page with `evaluate_script`, passing `filePath` (a scratchpad file) so the token never appears in
   chat. It looks in **both** `localStorage` and `sessionStorage` and picks the entry that is not expired (the SPA
   can leave an expired copy in one of them):

   ```js
   () => {
     const now = Date.now() / 1000, cands = [];
     for (const s of [localStorage, sessionStorage])
       for (const k of Object.keys(s)) {
         if (!k.includes('@@auth0spajs@@') || k.includes('@@user@@')) continue;
         try { const e = JSON.parse(s.getItem(k)); if (e.body && e.body.access_token) cands.push(e); } catch {}
       }
     const live = cands.filter((e) => !e.expiresAt || e.expiresAt > now).sort((a, b) => b.expiresAt - a.expiresAt)[0];
     return live ? { access_token: live.body.access_token, audience: live.body.audience } : { error: 'no unexpired token found' };
   }
   ```

3. Store it — this prints only the audience, expiry, claim names and roles, and deletes the temp file:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/api/store-secret.js" <tmpfile> .automaqa/api/inputs.json provider_token --var host=https://<host>
   ```

4. For a second role (client/patient) use a separate incognito window or isolated browser context, so the first
   session is not replaced, and store it as `client_token`.
5. Read the roles it prints back to the user: an Admin token can change real data, which matters for step 3.

## Step 3 — Choose the run mode

State the plan back and get explicit answers:

| Question | If no | If yes |
|---|---|---|
| Is the host a test/staging/QA environment? | read-only only | writes become possible |
| Run create/update calls? | read-only (default) | `--mode full --confirm-host <hostname>` |
| Run DELETE calls? | skipped | add `--allow-destructive` |
| Run calls that send e-mail/SMS/OTP? | skipped | add `--allow-sensitive` |

Read-only still produces a useful report; requests that depend on a blocked write are reported as
**dependency not met**, not as failures.

`--confirm-host` must be the **hostname** (no scheme/port). A request that hardcodes a *different* host
needs that host confirmed too (`--confirm-host a.example.com,b.example.com`).

**Credentials are pinned to confirmed hosts.** A token or `Authorization` header is only sent to the host the user
gave as `host`/`baseUrl` (in `inputs.json`, an env file or an env var) or to a `--confirm-host` host. A base URL that
exists only in the collection file is not trusted. Any request to another host is skipped with
`skipped: would send credentials to <host>` — tell the user, and add `--confirm-host <host>` only if they confirm
that host is intended (this works in read-only mode too).

## Step 4 — Dry run, then run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/api/run.js" --out .automaqa/api --dry-run
```

Sends nothing. Shows which requests would run, which are blocked and why, and which still miss inputs. The
summary separates **would send now** from **would send only if upstream calls succeed** (requests that rely on a
value produced by another request) — the real run can send fewer than the first count if an upstream call fails.
Fix those with the user, then:

```bash
# read-only (default)
node "${CLAUDE_PLUGIN_ROOT}/scripts/api/run.js" --out .automaqa/api

# approved writes on a confirmed test host
node "${CLAUDE_PLUGIN_ROOT}/scripts/api/run.js" --out .automaqa/api --mode full --confirm-host api.staging.example.com
```

Useful flags: `--only "Care Plan,Laboratory"` (folder substring filter) · `--schema balanced|strict|lenient|off` ·
`--slow 5000` (ms before a slow-response warning) · `--timeout 30000` · `--delay 200` (be gentle with rate limits) ·
`--bodies failures|all|none` · `--auth-fallback <variable>` (send that token on requests the collection sets to
No Auth; each such row is labelled in the report; off by default) · `--ignore-expired` · `--no-fail-exit`. The process exits **1** when anything fails, so it works in CI.

Large collections: run folder by folder with `--only`, starting with the folder the user cares about most.

### What the runner does per request

- **Order:** reads first, then creates, updates, deletes — but any request that produces a value another one needs
  (via a test script like `pm.environment.set('x', response.id)`, or inferred from a collection endpoint such as
  `GET /orders/` → `{{order_id}}`) runs ahead of its consumer.
- **Gate:** read-only / confirm-host / production-host / destructive / sensitive checks happen *before* anything is sent.
- **Skip, don't guess:** unresolved `{{var}}` → skipped as *missing input*; upstream failed → *dependency not met*.
- **Validate:**
  - status: any 2xx passes; if saved examples only document error codes, those are expected; a 2xx that differs from
    the documented code is a **warning**
  - payload: shape compared with the saved example (missing fields, wrong types; shallow gaps fail, deep ones warn
    under `balanced`); 2xx bodies that signal an error (`success:false`, `status:"error"`) warn
  - time: slower than `--slow` warns
- **Categorise** failures: auth (401/403) · auth-not-sent (401/403 on a request the collection sends with No Auth) ·
  route-not-found (HTML 404 — the path does not exist, usually a stale collection) · data-not-found (JSON 404 — the
  route exists, the resource does not) · validation · server-error · network/timeout · schema-mismatch — each with a
  hint naming the variable to check.
- **Invalid requests** (no URL in the collection) are skipped as *invalid-request*, not counted as errors.

## Step 5 — Report back

Open `.automaqa/api/reports/latest.html` (offer to open it) and summarise **in the chat** — the user should not
have to open the file to learn the outcome:

1. Totals: passed / warnings / failed / errors / skipped, and the pass rate of requests actually sent.
2. **Failures grouped by category** — lead with auth (usually one wrong token explains dozens), then server errors,
   then schema mismatches. Name the variable or endpoint, and the likely cause from the hint. Say how many failures
   are *route-not-found* (likely a stale collection — owner: whoever maintains the collection) versus real API
   defects such as 5xx (owner: backend), because they go to different people.
3. **What was not tested and why** — blocked writes, deletes, sensitive calls, missing inputs, unmet dependencies.
   Never let skipped requests read as passing.
4. Caveats: requests with no saved example were only checked for 2xx; passes in read-only mode say nothing about
   the write endpoints.
5. Offer the next step: supply the missing inputs, approve a wider mode, re-run failed folders with `--only`,
   or hand a failing endpoint to the backend team (the report row has the masked request/response).

If the user wants the failures re-run after a fix, run again — each run writes a new timestamped report and
refreshes `latest.html`.

---

## Reference

### Exit codes and files
`0` all sent requests passed (warnings allowed) · `1` at least one FAIL/ERROR · `2` usage error (e.g. no plan).

### Result statuses
`PASS` · `WARN` (passed with warnings) · `FAIL` (wrong status or payload) · `ERROR` (network/timeout) ·
`SKIPPED` (reason in `skipReason`; kind is `missing-input`, `dependency`, `blocked`, `token-endpoint`, `dry-run`).

### Variable precedence (low → high)
collection `variable` → Postman environment (`--env`) → `inputs.json` variables → `inputs.json` secrets →
`AUTOMAQA_API_<NAME>` env var → values captured during the run (script captures override; inferred ones never do).

### Supported
Postman v2.0/v2.1 · bearer / basic / API-key auth (incl. folder-level inheritance) · raw JSON, urlencoded,
form-data (text + files via overrides) · `:pathVar` params · disabled params/headers ignored ·
Postman dynamic vars `{{$guid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`, `{{$randomEmail}}` ·
`pm.environment/collectionVariables/globals.set(name, response.<path>)` captures.

### Not supported (reported, not silently ignored)
OAuth2 flows configured inside Postman (use `tokenRequests`) · pre-request scripts · `pm.test` assertions
(the collection's own assertions are not executed — expectations come from saved examples) · GraphQL/binary bodies ·
collection-level JS logic. Requests depending on those show up as failures or skips with a reason.

### Related skills
Use `automaqa:flake-guard` to track results across repeated runs of the same collection.
