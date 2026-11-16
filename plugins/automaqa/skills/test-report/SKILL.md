---
name: test-report
description: Build the final test report — one self-contained HTML file (optional PDF) with a plain-language explanation of every test, step-by-step screenshots with the relevant elements highlighted, bugs with repro steps, and expected-vs-actual for each check. Invoked as the last step of playwright-e2e and maestro-e2e, and on demand.
when_to_use: Use when a test run has finished and the user needs a report, when asked for "the report", "test report", "evidence", "screenshots with highlights", "explain the results", "a report I can share", or when a report must be regenerated or merged (web + mobile + live verification). Trigger on "generate report", "final report", "test report", "report with screenshots", "make the report easier to understand".
argument-hint: [specs/<feature-slug>] [--pdf]
---

# Test Report — evidence, explanation, highlights

Every automaqa run ends with **one file a non-technical reader can open and understand**:

```
specs/<feature-slug>/report-v{N}.html        ← the report (self-contained: screenshots are embedded)
specs/<feature-slug>/report-v{N}.pdf         ← only with --pdf
specs/<feature-slug>/evidence/v{N}/*.manifest.json   ← the data behind it
specs/<feature-slug>/evidence/v{N}/shots/*.png       ← the original, unmodified screenshots
specs/<feature-slug>/evidence/live/*.manifest.json   ← live-verification findings (Step 6/7 of playwright-e2e)
```

The report contains, in order: verdict banner and counts → plain-language summary → **Bugs found**
(severity, expected vs actual, why it matters, repro steps, annotated screenshot) → every test case
(what it checks, expected result, the steps it took each with a screenshot, what happened) → test
health → how to read the screenshots → environment.

**Highlights are overlays, not edits.** Coordinates are stored beside the original PNG and drawn by
the report, so the evidence is never altered and the same code serves web (CSS px) and mobile (device px).

| Colour | Kind | Use it for |
|---|---|---|
| Blue | `target` | the element the step clicked / typed into |
| Green | `expected` | the element showing the correct result |
| Red | `problem` | where the app deviates from the spec |
| Amber | `note` | something worth pointing out that is not a failure |

---

## How the data gets there

| Source | How evidence is captured | Written to |
|---|---|---|
| **Playwright run** (web) | Tests call `snap()` / `check()` from `tests/support/evidence.ts`; `tests/versioned-reporter.ts` collects them in `onEnd()` — **automatic**, also renders `report-v{N}.html` | `evidence/v{N}/web.manifest.json` |
| **Live verification** (Chrome DevTools) | You capture it — see "Live verification" below | `evidence/live/live.manifest.json` |
| **Maestro** (mobile) | You capture it — see "Mobile" below | `evidence/v{N}/mobile.manifest.json` |

For a web-only run the reporter already produced a first draft of the report. This skill's job is the
**enrichment pass** (next section), merging any other sources, and verifying the result.

---

## Step 1 — Find the run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/report/build_report.js" specs/<slug> --init-run
```
Only when **no** automated Playwright run exists for this run (mobile-only): it creates `evidence/v{N}/`
and prints `{ run, dir }` — write the Maestro manifest there. Skip this command when a Playwright run has
just finished: its `evidence/v{N}/` is the run to extend.

## Step 2 — Enrichment pass (the "detailed explanation")

The reporter can only describe what the test code told it. You add the understanding. Open
`evidence/v{N}/web.manifest.json` (and any other manifest in that folder) and, **using only what the
evidence shows**:

1. **`summary`** (top level) — 3–6 sentences, plain language, for someone who has not read the spec:
   what was tested, how many passed/failed, the most important finding, and whether failures look like
   product bugs or test problems. Mention flaky tests and skipped/quarantined ones.
2. **Per case** — fill gaps only; do not overwrite text a test author wrote deliberately:
   - `purpose` — one sentence: the rule from the spec this case protects, and why it matters to a user.
   - `expected` — the spec's expected result.
   - `verdict` — for a failure: *what went wrong, in words* ("The app showed a generic error instead of
     the message the spec defines"), not a stack trace. For a pass: one line on what was confirmed.
3. **`bugs`** — one entry per distinct deviation from the spec (group cases that share a root cause):
   `id` (BUG-1…), `title`, `severity` (Critical = blocks a core flow or loses/leaks data; Major = a
   spec rule is broken but there is a workaround; Minor = cosmetic or wording), `caseId`, `expected`,
   `actual`, `impact` (why a user or the business cares), `repro` (numbered steps from a clean state),
   and `screenshot` + `highlights` + `refSize` copied from the failing step so the bug card carries its own picture.
4. **Better highlights** — if a failing step has no red mark, add one from the step's `refSize` and the
   element's position (re-read it with `evaluate_script` → `getBoundingClientRect()` if needed).

Rules for the narrative:
- **Never change a status.** A failed case stays failed. If you believe a failure is a test problem, say
  so in `verdict` and leave the status.
- **Never invent.** If the evidence does not show why, say "cause not determined" rather than guessing.
- **No secrets in text.** Write "entered the test account's password", never the value. Screenshots can
  still contain test-account data; mention in the summary if the report should not leave the team.
- Plain words. A product manager should understand every sentence without opening the spec.

## Step 3 — Capture evidence for non-Playwright sources

### Live verification (Chrome DevTools)
For each scenario in playwright-e2e Step 6, capture one screenshot at the moment that proves the result.
1. `evaluate_script` → `JSON.stringify(document.querySelector('<sel>').getBoundingClientRect())` for the
   element to highlight, plus `JSON.stringify({w: innerWidth, h: innerHeight})`.
2. `take_screenshot` (pass `filePath` into `specs/<slug>/evidence/live/shots/` when supported). Viewport
   screenshot, **not** full-page, so the coordinates match.
3. Record it in `specs/<slug>/evidence/live/live.manifest.json` as a case with `"source": "live"` and
   `"status": "passed" | "failed"`. A scenario that exposes a deviation is `failed` plus a `bugs` entry.
4. Render the standalone live report (this replaces hand-writing `report.html`):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/report/build_report.js" specs/<slug> --run live --out specs/<slug>/report.html
   ```

### Mobile (Maestro)
1. In the flow, add `- takeScreenshot: <EVIDENCE_DIR>/<caseId>-<n>` at each meaningful step (Maestro appends `.png`).
2. For the element to highlight, take `bounds` from `inspect_screen` (`"[x1,y1][x2,y2]"`) — the renderer
   accepts that string directly in a highlight: `{ "bounds": "[90,215][600,235]", "label": "Error text", "kind": "problem" }`.
   Device pixels equal screenshot pixels, so omit `refSize`.
3. Write `evidence/v{N}/mobile.manifest.json` with `platform: "mobile"` cases (schema below), and put
   `environment.device` (model + OS) in it.
> The Maestro capture path is written from Maestro's documented behaviour and has not been exercised
> end-to-end in this plugin yet. Check the first mobile report's screenshots before trusting it.

## Step 4 — Build the report

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/report/build_report.js" specs/<slug> [--run vN] [--pdf]
```
It merges `evidence/live/` (unless `--no-live`) with every `*.manifest.json` in the run folder
(web, mobile, …) and writes `report-v{N}.html`, then prints
`{ report, pdf, run, totals: { total, passed, failed, flaky, skipped, bugs } }`.
Use `--no-embed` only if the HTML would exceed ~25 MB (many full-HD screenshots); the report is then no
longer a single file and the `shots/` folder must travel with it.

## Step 5 — Verify before you hand it over

- [ ] `totals.total` equals the number of tests that ran (compare with the Playwright / Maestro summary). A mismatch means a case was dropped.
- [ ] `totals.failed` equals the failures you saw; every failure appears in **Bugs found** or has a `verdict` saying why it is not a product bug.
- [ ] Open the HTML (or `--pdf`) and look at least at the first failing case: highlights sit on the intended element, the legend names are right, no "Screenshot not found" boxes.
- [ ] No credentials or tokens appear in any text field of the manifests.

Then tell the user: the report path, the totals, the top findings in two or three lines, and that the
file is self-contained and can be shared as-is (with the test-account caveat if screenshots show account data).

---

## Manifest schema (v1)

```jsonc
{
  "schema": 1,
  "feature": "login", "run": "v3", "title": "Login — test report v3",
  "spec": "specs/login/spec.md", "generatedAt": "ISO-8601", "durationMs": 4300,
  "summary": "Plain-language overview (Step 2.1)",
  "environment": { "baseUrl": "https://staging.x.com", "browser": "Chromium", "device": "Pixel 7 / Android 14" },
  "cases": [{
    "id": "TC_002", "title": "Wrong password shows the specified error",
    "platform": "web | mobile", "source": "automated | live",
    "status": "passed | failed | flaky | skipped", "durationMs": 1900, "retries": 0,
    "specRef": "spec.md §3.2", "purpose": "…", "expected": "…", "verdict": "…",
    "error": "raw error text (optional)", "trace": "path to trace.zip (optional)",
    "steps": [{
      "action": "Clicked Log In", "expected": "…", "actual": "…", "note": "…",
      "status": "passed | failed",
      "screenshot": "shots/002-TC_002-s2.png",          // relative to the manifest file, or absolute
      "refSize": { "w": 1280, "h": 720 },                // coordinate space of the highlights; omit for mobile/image px
      "highlights": [{ "x": 90, "y": 215, "w": 500, "h": 22, "label": "Error text", "kind": "problem" }]
    }],
    "finalScreenshot": "shots/….png"                     // used when a case has no steps
  }],
  "bugs": [{ "id": "BUG-1", "title": "…", "severity": "Critical | Major | Minor", "caseId": "TC_002",
             "expected": "…", "actual": "…", "impact": "…", "repro": ["…"],
             "screenshot": "…", "refSize": {}, "highlights": [] }],
  "health": { "line": "Tracked tests: 20 | Flake rate: 5%", "sections": [{ "title": "…", "kind": "broken", "items": [{ "id": "…", "reason": "…" }] }] }
}
```

## Writing good evidence in Playwright tests

```ts
import { snap, check } from './support/evidence';

test('TC_002 — wrong password shows the specified error', {
  annotation: [
    { type: 'purpose',  description: 'A wrong password must be rejected with the message the spec defines.' },
    { type: 'expected', description: 'Error "Wrong email or password." is shown.' },
    { type: 'spec',     description: 'spec.md §3.2' },
  ],
}, async ({ page }, testInfo) => {
  await page.getByLabel('Password').fill('wrongpass');
  await snap(page, testInfo, { action: 'Typed a wrong password',
    marks: [{ locator: page.getByLabel('Password'), label: 'Password field' }] });
  await page.getByRole('button', { name: 'Log In' }).click();
  await check(page, testInfo, {
    action: 'Submitted the form', expected: 'An error message appears',
    marks: [{ locator: page.getByText('Wrong email or password.'), label: 'Error message' }],
    assert: () => expect(page.getByText('Wrong email or password.')).toBeVisible(),
  });
});
```
- `snap()` records a step (marks are blue). `check()` runs the assertion, then records the step — **green on
  pass, red on fail, original error re-thrown** so test behaviour is unchanged.
- One `snap`/`check` per meaningful state change (input entered, action taken, result shown) — not per line.
  Typically 2–4 per test. The reporter adds Playwright's own end-of-test screenshot to every failure.
- Highlight 1–3 elements per screenshot. A mark whose element does not exist (negative tests) is skipped silently.
- Locators passed to `marks` belong in the page object like any other locator (see `automaqa:page-objects`).
- Evidence never fails a test: a screenshot error is logged and skipped.

## Strict rules

1. **Report every run.** A run is not finished until Step 4 has produced the file and Step 5 has passed.
2. **Status is evidence, not opinion.** Never edit a case from failed to passed, and never drop a failing case to make totals look better.
3. **Originals stay original.** Never draw on, crop or compress the PNGs in `shots/`.
4. **One run, one file.** Never overwrite an earlier `report-v{N}.html`; `report.html` (no version) is only the live-verification report.
5. **No secrets in the report text** (credentials, tokens, API keys).
