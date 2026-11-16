---
name: scan
description: Read a live website or mobile app, strictly read-only, and write a standing reference document that test cases can be written from — built from one structured source and rendered as PDF, Word and TOON (identical IDs and content). Fixed structure with stable IDs (AC-P, D-, T-, E-, F-, Q-), a cross-screen consistency pass, tooltip and expandable-field registers, forms opened read-only, a multi-role pass, and a quality check that fails the build. Modes - scan (new), update <previous .toon> (versioned, rescans named areas only), resume (continue unreached areas). Always asks which platform first.
when_to_use: Use when the user wants to scan, read, crawl, map, understand or document an app or website, produce a business workflow / reference document, write test cases from an app, refresh the reference after a release (update), or continue a scan that stopped early (resume). Trigger on "scan", "scan the app", "read the website", "document the workflow", "business workflow", "reference document", "update the scan", "update <file>.toon", "resume the scan", "what can we test".
argument-hint: [web | mobile] [url or appId] | update <previous .toon> | resume
---

# App Scan

Reads a **running** app like a careful tester and writes a **reference document** — how the app is
*meant* to work — with IDs and rules that test cases are written from. It is not a scan report.

| Question | Answered by |
|---|---|
| How is the app meant to work? Which rules can a test check? | The **reference document** (this skill's output) |
| What was seen on one day? | The evidence inside it, marked "seen on <date>" |

**One source, three outputs.** The skill writes ONE file, `source.json`, and `render.js` turns it into
`<Name>_v<version>.pdf`, `.docx` and `.toon`. They are generated together and checked to carry the same
IDs, so they cannot drift apart. The `.toon` holds a guidance block for Claude (G-1 to G-10) and a sheet map from
each section to an AutomaQA sheet, so `/automaqa:import-cases` can use it directly.

**Modes** (from `$ARGUMENTS`): `web|mobile <target>` = new scan · `update <previous.toon>` = versioned update ·
`resume` = continue the unreached areas of the latest scan.

---

## Read-Only Contract _(applies to every step — read this first)_

The scan is **observation only**. It must not change anything, anywhere, for anyone.

**Never do** (if a screen seems to need one, stop and ask what the user wants, on which page, and why):
save · submit · send · **resend** · publish · delete · upload · download · export · buy · book · post ·
start a call or meeting · remind / notify · approve · reject · resolve · complete · archive · reset · generate · log out.

**Fine to do:** open pages, tabs (including tabs **inside side panels**), menus, dropdowns, dialogs, expand arrows, filters,
search, sort, pagination, hover / info icons — and **open forms read-only** (below). Close every dialog with
**Cancel or ✕**, never with anything that saves.

**Also forbidden:** marking anything read / seen / approved / completed (opening an unread message, notification or
alert — ask first) · creating accounts, accepting terms, granting permissions, changing settings · following links that leave
the website (report them) · copying **personal data** (names, emails, phone numbers, addresses, dates of birth, payment
details) into any output — use IDs or "test user" · asking for or typing a **password** · typing into any field.

### Forms: open read-only, record the fields
A button whose label is `Add`, `New`, `Invite`, `Create` or `Edit` is classified **`open-form`**. Click it only to open the form:
1. click, then `readForm(page)` → title, fields (label, type, required, hint), buttons
2. close with `closeForm(page)` — **Cancel / close only**. Never press Save, Send, Create, Invite-send or Submit.
3. if no dialog opened (inline edit or navigation), reload the page to drop any edit state.

Record each form in `forms[]` (e.g. New Appointment, Invite New Client, Add Notes). Opening is `Y`; saving is `N`
("Y / N" in the safe-to-test register). The write guard aborts any save even if one were clicked by mistake.

### How the rule is enforced — deny by default
1. **Classifier** (`safety.js`, whole-word matching — "Invited Clients" is not "Invite", "Postpartum" is not "Post"):
   `safe` → click · `open-form` → open read-only as above · `review` → shown to the user in one batch per screen ·
   `unsafe` → never clicked, listed as N.
2. **Tabs inside side panels are clickable**: `role=tab`, tab groups, expanders and "+N more" controls are safe even in a panel.
   Anything else inside a dialog or panel is `review`, never silently skipped. A form opener inside a dialog is unsafe.
3. **Never operate** checkboxes, radios, switches or toggles that persist state. Typing is limited to search/filter text.
4. **Write guard — prevention, not detection** (`guard.js`): aborts every non-GET request before it leaves the browser unless
   allowlisted (known telemetry, GraphQL *queries*, endpoints the user approved) and blocks GET navigation to logout URLs.
   When something is blocked, **pause and report it** and add the control to the N table. A blocked navigation leaves the tab
   on an error page — re-open the last good URL, in a fresh tab if `goto` is interrupted.
5. When unsure: do **not** click. Record it and ask.

---

## Helper Scripts _(tested — use them, do not re-write them)_

`${CLAUDE_PLUGIN_ROOT}/scripts/scan/`. Load with
`const S = p => require(require('path').join(process.env.CLAUDE_PLUGIN_ROOT, 'scripts/scan', p));`

| Script | Purpose |
|---|---|
| `guard.js` · `learn.js` | `installGuard(context)` write guard · `learn(page, url)` + `formatForApproval()` — the blocked-request list shown at the start |
| `loading.js` | `waitLoaded(page)` → `{ ok, waitedMs, changed, reason }` — the Loading Protocol |
| `safety.js` · `forms.js` | `listCandidates(page)` → verdicts `safe / open-form / review / unsafe` · `readForm(page)`, `closeForm(page)` |
| `evidence.js` | `dumpEvidence(page, rawDir, id)` — the text the page really showed (for the exact-text check) · `harvestNames(rawDir)` |
| `consistency.js` | `harvestFacts`, `findCrossScreen`, `proposeRules`, `diffFacts` — the cross-screen pass |
| `roles.js` | `roleSnapshot`, `comparePermissions`, `notObserved` — the multi-role pass |
| `ids.js` | stable IDs: `assignIds`, `allocate`, `retire`, `validateIds` |
| `qa.js` | `node qa.js source.json --evidence <raw> --names names.txt` — **fails the build** (see Step 9) |
| `render.js` · `toon.js` · `docx.js` · `pdf.js` | `node render.js source.json --out <dir> [--screenshots on --shots <dir>]` → PDF + Word + TOON, ID-match verified |
| `update.js` · `resume.js` | versioned merge · `resumePlan(modelDir)` |
| `redact.js` · `cleanup.js` | blur personal data in screenshots · delete raw dumps and check for personal data |
| `selftest.js` | proves all of the above (local server only). Run once per session. **Any FAIL → stop.** |

Source schema and an example: `${CLAUDE_PLUGIN_ROOT}/templates/scan/source.example.json` (copy its shape).

---

## Step 1: Ask Which Platform First _(always the very first action)_

Before any tool call, file read or other question, ask with `AskUserQuestion`: **Web** (Playwright) or **Mobile** (Maestro).
Skip only when `$ARGUMENTS` starts with `web` / `mobile`, or is `update <file>` / `resume` (platform is read from the previous run).

## Step 2: Collect Details

Ask only what is missing, in one `AskUserQuestion` call where possible.

| Detail | Notes |
|---|---|
| **Target** | Web URL, or mobile `appId` + device from `mcp__maestro__list_devices` (none → ask the user to boot one, stop) |
| **ENVIRONMENT** | test / QA / staging / **production** (production: ask the user to confirm first; skip personal-record areas; no screenshots) |
| **AREAS TO COVER** | menu areas, or "everything reachable from the main navigation" |
| **ROLES** | which roles to scan (e.g. provider, admin, research analyst). One sign-in per role, done by the user |
| **Screenshots** | **Off by default.** The reference needs none, and QA data often has real-looking names. Turn on only if the user asks; they appear in the PDF only |
| **Update / resume** | the previous `.toon` and the areas to rescan (see Steps 11–12) |

The three files are always produced together (PDF + Word + TOON). Nobody chooses between them.

### Step 2a: Sign-in — the user signs in, never Claude
Ask: no login · already signed in · I'll sign in now. **Never ask for a password in chat. Never type one**, even if offered.
The user signs in (MFA/OTP included) in the attached browser or device. Record "authenticated (user-supplied session)", never a username.

## Step 3: Pre-flight

**Web:** `npx playwright --version` (missing → `/automaqa:setup web`). Attach to the user's signed-in browser with
`chromium.connectOverCDP('http://localhost:9222')`; if nothing answers, ask the user to start the debug browser
(`/automaqa:setup web` Step 11) or launch a **separate** Chromium that the user signs in to. Never close the user's tabs.
**Mobile:** `mcp__maestro__list_devices`, then `launchApp` (missing tool → `/automaqa:setup mobile`).

Scratch (scripts, raw evidence) → `.automaqa/scan-tmp/<run>/`. Outputs → `specs/_scan/<platform>-<YYYYMMDD-HHmm>/`. Never overwrite a previous run.

1. Run `node selftest.js`. Any FAIL → stop.
2. Install the write guard **before the first click** and show the blocked list **at the start**:
   `const r = await learn(page, startUrl); console.log(formatForApproval(r));`
   Show the user the numbered list (e.g. Tracking Insights, chat session, notification user). Approve only the calls the user
   confirms are read-only (`guard.allow({ method, host, path })`). Everything else stays blocked. This is why a scan no longer
   shows half-empty panels for no reason: read-only calls that the app needs are approved up front.

## Loading Protocol _(after EVERY click, navigation, tab change, filter, search, sort, page change or dialog opening)_

`const r = await waitLoaded(page)` → `{ ok, waitedMs, changed, reason }`. Finished = no spinner/skeleton/"Loading…", content present,
and an identical second look ~2 s later. Not finished after 30 s → record "did not finish loading" (screen, action, wait) and move on;
never report a loading state as content. `waitedMs > 5000` → slow. `changed` → numbers moved: note it. Scroll every page and
container to the end, page through tables, wait for tooltips. Never click a second control mid-load. Check for lingering placeholders
before screenshots: `[class*=skeleton|shimmer]` visible → wait and look again.

## Step 4: Understand the App First
Read the landing view and top-level navigation only. Write a hypothesis (what, why, actors, entities, expected flows) and
correct it as the scan proves it wrong. It becomes the executive summary and the "Purpose and users" section.

## Step 5: Go Through the Areas, One at a Time

For each screen, in order:
1. Navigate (only classifier-approved controls) → `waitLoaded`.
2. `dumpEvidence(page, rawDir, id)` — **always**, for the screen and for every dialog/panel/tooltip you open. This is what the
   exact-text check reads later.
3. Read structure (`ariaSnapshot` / `inspect_screen`). Scroll everything.
4. `listCandidates(page)`: click `safe`; open `open-form` read-only; collect `review` for one batch per screen; list `unsafe` as N.
   Re-navigate to the screen between controls so state never drifts.
5. **Tooltips register.** Hover every info icon and every icon-only button. Record **word for word**: where (screen > area),
   which icon (the label next to it), exact bubble text (`aria-label`, `title` or the tooltip element). One row per icon → `tooltips[]`.
6. **Expandable fields register.** Open every expandable (Tap to Expand, chevrons, "+N more", Read More, "+" in a table). Record the
   control's exact text and what it reveals; close it. → `expandables[]`. Include the "+N" counts: `N` more items must equal the extra items shown.
7. **Forms.** Every `open-form` button → `forms[]` (title, fields with label/type/required/hint, buttons).
8. Record per screen: where it is, what it is for, **exact text** (headings, buttons, column names, labels, empty states), each control
   with Y/N, the rules a test can check, anything inconsistent. Numbers carry "seen on <date>".
9. Harvest numbers for Step 7: screen text → `facts[]` (`{ key, screen, label, value, seen }`).

Same template, different data (`/orders/:id`): open two instances, record the template once. Same nav everywhere: record once.
Persistent widgets (chat assistants, scribes, cookie banners): record once, never operate; a new same-site tab is followed, an off-site one is reported.
Mobile: `inspect_screen` after every UI change; `scroll`/`swipe` until stable; deny permission prompts; no coordinates as locators.

**Stop conditions:** queue empty, blocker (OTP, payment), or budget (default web ~100 screens, mobile ~50). At the budget,
**write `model/coverage.txt`** (`writeCoverage`) listing what was reached and what was not — with the reason ("queued, budget used"),
and the route so `resume` can continue. Then ask whether to continue.

## Step 6: Role Pass _(when more than one role was requested)_
For each role the user signs in as: record the menu, which screens open, which controls exist, what is denied or hidden
(`roleSnapshot`). Then `comparePermissions(snaps)` → `permissions[]`. "Cannot" is recorded **only when observed**; roles never
signed in appear as "Not observed — needs a business definition" (`notObserved`). Keep each role's evidence separate; never merge accounts.

## Step 7: Cross-Screen Consistency Pass _(after the scan, before writing)_
The same number often appears on several screens. This pass finds them and records a **D- rule** for each.
1. `harvestFacts(textByScreen)` → candidate facts; `findCrossScreen(facts)` → groups seen on ≥ 2 screens.
2. Review the groups: keep only real "same quantity" pairs (e.g. Alerts total on the Alerts page vs the client Alerts tab; header weight vs the
   Tracking tab; Clients total vs the sum over pages; a `+N` chip vs the items it opens; a task badge vs its rows; Users total vs pages).
3. `proposeRules(source, groups, date)`: agreeing numbers → `data_rules[]` ("… is the same on A and B (seen on <date>: V)");
   differing numbers → `open_questions[]` ("differs: A = x, B = y (seen on <date>)"). Add D- rules for calculated relations too
   (macros add up to calories, BMI follows height and weight, percentages vs day counts).
This pass produces most of the document's value; do not skip it.

## Step 8: Write the Source _(one file: `source.json`)_

Follow `templates/scan/source.example.json`. Rules:
- **Stable key + ID.** Every criterion, data rule, tooltip, expandable, form and open question has a stable `key` (e.g.
  `ac:alerts-severity-sum`). Leave `id` empty: `assignIds()` gives the next free number. **IDs are never reused or renumbered.**
  `AC-P` acceptance criteria · `D-` cross-screen rules · `T-` tooltips · `E-` expandables · `F-` forms · `Q-` open questions.
- Each screen's "Must be true" lines become **acceptance criteria** (`criteria[]`, `screen: <key>`); every screen needs at least one.
  Cross-cutting rules use `screen: "global"`; permission rules `screen: "permissions"`.
- **Numbers:** any number in a rule carries `seen on <date>` in the text (and `seen` on the item). A limit, threshold or format
  (25 per page, ≥80 %) is tagged `number_kind: "rule"`. The rule matters more than the value (assert counts add up, not "194").
- **Exact text** (`screens[].text`, tooltip `text`, expandable `control`, form labels) must be copied from what the page showed.
- **Sign-off stays visible:** rules are `status: "proposed"` ("proposed from what was observed, needs Business sign-off") until a
  person approves them. Things only a person can judge go in `person_judgement[]` (clinical wording, reference ranges, colour clarity).
  Unclear intent goes in `open_questions[]`; do not guess.
- **No personal data.** Client/user names → "test user" or IDs. No emails, phone numbers, dates of birth.
- Keep from the scan: `exec_summary`, `glossary`, `workflows` (steps not performed carry `not_executed: true`), `load_times`, `coverage`.
- `safe_to_test[]`: every button, Y / N / "Y / N", effect, run_mode (`read_only_ok`, `needs_approval`, `open_ok_save_needs_approval`).

## Step 9: Quality Check _(fails the build)_
`node qa.js source.json --evidence <rawDir> --names names.txt --require-evidence` (`names.txt` from `harvestNames(rawDir)`).
It **fails** when: an acceptance criterion, rule, tooltip, expandable, form or question is missing its ID (or an ID is duplicated /
malformed) · a number lacks "seen on <date>" · an exact-text quote does not appear in the scan evidence · a section has no rule ·
personal data is found (email, phone, DOB, long digits, or any name seen in the scan). Fix the **source**, not the checker, and re-run until it
passes. Do not render a document that failed.

## Step 10: Render the Three Outputs
`node render.js source.json --out specs/_scan/<run>/ [--screenshots on --shots <run>/model/shots]`
→ `<Name>_v<version>.pdf`, `.docx`, `.toon`, `.source.json` (the sidecar `update` loads). `render.js` verifies the three carry identical IDs
and exits non-zero otherwise. Check the PDF: opens, page count > 0, look at page 1 and one screen section.

### Fixed document structure
**Opening:** Document control (item/detail table, business sign-off status) · How to read · Using this document when the portal changes
(7 steps) · 1 Purpose and users (executive summary, role table, glossary).
**Screens:** 2 Application map (2.1 menu and addresses · 2.2 top bar · 2.3 forms · 2.4 info icons and tooltips with TR- rules and the T- register ·
2.5 expandable fields with ER- rules and the E- register) · **one section per screen** (where, purpose, exact text, element table with "must be true",
the AC- rules) · Business workflows · **Data that must agree across the portal** (D- rules).
**Closing:** Permissions and data isolation · Acceptance criteria (all AC-P, with status) · Safe-to-test register · Items to confirm with the business (Q-) ·
Out of scope / not covered · **Things only a person can judge** · Load times, coverage and limits · Document control: change log and sheet map.
Section numbers stay stable across versions (stored in `numbering`). The TOON adds `llm_guidance` (G-1…G-10), `sheet_map`, `change_log`, and every register.

## Step 11: Update Mode — `update <previous .toon>`
1. Load the previous version (`loadPrevious`): the `.source.json` next to the `.toon`, else the registers inside the `.toon` (IDs, rules,
   tooltips, expandables, questions, safe-to-test, change log — screens must then be rescanned).
2. Ask which areas to rescan (screen keys) and scan **only those** (Steps 5–9 for those areas).
3. `mergeUpdate(prev, fresh, { areas, approvedBy })`:
   - existing IDs are **kept** (matched by `key`); new keys get the **next free number**; a retired ID is never reused;
   - items of the rescanned areas not seen again → `status: "not-seen"` (ID kept); items outside the areas are carried unchanged;
   - numbers that moved are listed ("alerts 860 → 1,034") and written to the change log;
   - the version is bumped and a **change-log row** is added: version, date, sections, what changed, approved by ("Pending Business sign-off" until a person signs).
4. Run Step 9 (carried items skip the evidence check), render (Step 10), then Step 13.

## Step 12: Resume Mode — `resume`
`resumePlan(modelDir)` reads `coverage.txt`. It continues with the **unreached, resumable** items (queued / budget used). Items skipped for
safety (ask-first, external, may record) are **not** resumed without the user's approval. Re-attach, install the guard, scan the queue, update
`coverage.txt` and the source (merge as in update mode), then Steps 7–13.

## Step 13: Hand Off and Clean Up
1. Order: **qa.js → render.js → cleanup.js**. The evidence lives in the raw folder, so qa must run before it is deleted.
2. `node cleanup.js --raw .automaqa/scan-tmp/<run>/raw --model specs/_scan/<run>/model` deletes the raw dumps (real names and emails) and
   checks the model for personal data; **exit code 2 = fix before sharing**.
3. Summarise: coverage, ID counts, open questions, N controls, numbers that moved, what was not reached (and that `resume` can continue it).
   Write the run path to `specs/_scan/LATEST.txt`. Offer `/automaqa:scan-to-cases <file>.toon` as the next step (it turns the reference document into test cases, then hands off to `/automaqa:import-cases`); do not start it unprompted.

---

## Strict Rules
1. **Platform question first** (unless the arguments name the platform or the mode).
2. **Strictly read-only.** Deny by default; the write guard backs every click; forms are opened and closed with Cancel only.
3. **Never ask for, accept or type a password.** The user signs in, once per role.
4. **Wait for every screen to finish loading** before reading or clicking.
5. **Observed only; do not guess.** Exact text is copied from the page. Unclear intent → an open question. Steps not performed are "not executed".
6. **No personal data** anywhere in the outputs. Screenshots are **off by default**; production never.
7. **IDs are stable**: never reused, never renumbered. A rule without an ID, a number without "seen on <date>", an unverifiable quote, a section without a rule, or personal data **fails the build**.
8. **One source, three outputs**: never hand-edit the PDF, Word or TOON; change `source.json` and re-render.
9. **Keep business sign-off visible**: rules are proposed until approved; "only a person can judge" is a separate list.
10. Ask, don't assume — for anything that might change state, and when the guard blocks a request.
11. Use the tested helper scripts and run `selftest.js` first. Finish with `cleanup.js`.
12. Never close the user's browser tabs or kill processes without asking. Never overwrite a previous run.
