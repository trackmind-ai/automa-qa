---
name: scan-to-cases
description: Generate test cases from an automaqa:scan reference document (.toon or source.json), write them to an Excel review workbook, and after the user approves it send it to /automaqa:import-cases. Every case traces to a scan ID (AC-, D-, T-, E-, F-, Q-).
when_to_use: Use after a scan, when the user says "generate test cases from the scan", "write test cases from the .toon", "scan to cases", or "what can we test" and a scan output exists.
argument-hint: [path/to/<Name>_v<version>.toon | path/to/source.json]
---

# scan-to-cases

Bridge between `automaqa:scan` (reference document) and `automaqa:import-cases` (spec.md).
`import-cases` has no `.toon` reader, so this skill writes the test cases itself, in a format it already reads.

Flow: `scan` -> **scan-to-cases** -> `import-cases` -> user approves spec -> `playwright-e2e` / `maestro-e2e`.

## Step 1: Find the input

1. Use the path in `$ARGUMENTS` if given.
2. Else read `specs/_scan/LATEST.txt` and look in that run folder for `source.json` and `*.toon`.
3. Prefer `source.json` (the single source the PDF, Word and TOON are rendered from). Use the `.toon` if that is all there is.
4. If nothing is found, ask the user for the path. Do not scan anything yourself.

Read the whole file. Note `meta.version`, `meta.sheet_prefix`, and the platform (web or mobile).

## Step 2: Ask what to generate

Always ask this, even if the user's request seems clear. Use AskUserQuestion with two multi-select questions
(the tool allows 4 options per question), sent in one call. Tell the user all are optional and nothing is
generated for an unticked section.

Question 1, header "Sections (1/2)": "Which of these should I generate test cases for?"
- **Acceptance criteria** - one case per AC- criterion
- **Screen elements** - one case per element with a checkable rule
- **Data rules** - cross-screen consistency checks (D-)
- **Forms** - required fields, valid input, cancel (F-)

Question 2, header "Sections (2/2)": "And these?"
- **Tooltips** - trigger and check the text (T-)
- **Expandables** - open and check the revealed content (E-)
- **Permissions** - per-role visibility and allowed/blocked actions
- **Workflows** - one end-to-end case per workflow

If the user picks nothing in both, ask again. "All" or "everything" in free text selects all eight.
Only the ticked sections are read in Step 3. Sections not ticked are listed as "not requested" in the Step 6 report, not as gaps.

### Step 2b: Ask for the user's own criteria file

For the sections ticked above, ask once (AskUserQuestion, single-select):
"Do you have a file describing how the test cases should look or what they must check (acceptance criteria, rules, naming, priorities)?"
- **Yes, I have a file** - the user gives a path. Accepted: `.txt`, `.md`, `.csv`, `.docx`, `.xlsx`, `.json`, or pasted text.
- **No, derive from the scan only** - go to Step 3 directly.
- **No, help me write one** - run the guided flow in Step 3b with no starting file.

If a file is given, read it fully. A plain list of sentences is fine; no template is required. Split it into individual
criteria. Where a line names a section (for example "Forms: ..." or "Permissions: ...") or a scan ID, keep that link.
Then match each criterion to scan items by screen name, element label or ID, and show a short table:
criterion -> matched scan item(s), or "no match". Unmatched criteria are not dropped: ask the user which screen or
element they mean, or keep them as `precondition: TBD` cases.

The user's criteria override the generic mapping in Step 3: they set the wording of `expected`, the priority in `type`,
and which cases to write. The scan supplies the screens, labels, steps and rules to make them concrete.

Then ask, only if not already known (one AskUserQuestion call, single-select each):
- Platform (web / mobile), unless the scan already states it.
- Scope: all screens, or named ones.
- Include data-changing cases (save, delete, send)? Default **no**. See Step 4.

## Step 3: Derive cases, one source item at a time

Write cases only from what the scan states, and only for the sections ticked in Step 2. Never invent behaviour. Map each section:

| Scan section | Cases to write |
|---|---|
| `criteria` (AC-) | One case per criterion. The criterion text is the expected result. |
| `screens[].elements` (`must`) | One case per element whose `must` is checkable. |
| `data_rules` (D-) | One case per rule. Mark the case as a consistency check across screens. |
| `forms` (F-) | Required-field case per required field, plus a valid-input case, plus a cancel case. |
| `tooltips` (T-), `expandables` (E-) | One case each: trigger it, check the text or revealed content. |
| `permissions`, `roles` | One case per role: visible menu items, allowed and blocked actions. |
| `workflows` | One end-to-end case per workflow. Steps with `not_executed` follow Step 4. |
| `load_times` | Only if the scan gives a threshold. Otherwise skip and report. |
| `open_questions` (Q-) | **Do not write cases.** List them in the report as blocked. |

Numbers and counts: if `number_kind` is `rule`, test the rule. If the value is only an observed fact (`facts`, "seen on <date>"), do not hard-code it as expected. Test the relationship (total equals sum of pages), not the number.

## Step 3b: Gap check and guided criteria (runs whenever a criteria file was given, and when the user chose "help me write one")

After matching, find what the criteria do not cover, within the ticked sections only:

1. Scan items with no criterion (for example a form with required fields but no validation criterion, a role with no permission criterion, a data rule nobody mentioned).
2. Criteria that are too vague to test ("works correctly", "looks fine"). No observable result is named.
3. Criteria that conflict with the scan (a number or label that differs) or touch an open question (Q-).
4. Missing kinds of check for an item: only the happy path given, no empty, invalid or cancel case.

Show the gaps grouped by section, most important first (forms, permissions and data rules before tooltips).
For each gap, **propose a draft criterion** written from the scan, in the user's own style if a file was given, for example:
`Forms: Save Order is blocked and "Customer Name" is flagged when it is left empty. [F-new-order]`

Then ask (AskUserQuestion, per batch of up to 4 gaps, multi-select where it fits):
- **Accept the draft** as written
- **Edit it** - the user types a replacement
- **Skip it** - recorded as "skipped by user" in the report, not as an unnoticed gap
- **Not applicable** - recorded with the reason

Work through the gaps in batches of 4 until none remain or the user says "enough". Do not ask about more than 4 at a time.
Never fill a gap silently, and never invent a number or label the scan does not show.

When done, offer to save the final list: append the accepted criteria to the user's file, or create
`specs/_scan/<run>/criteria_v<version>.txt` when there was none. Use one criterion per line, section prefix first.
Next run, the user can pass that file back in at Step 2b and only new gaps will show.

## Step 4: Safety

- A control marked `safe: N` or `Y / N`, or `run_mode: ...needs_approval`, produces a case only if the user opted in at Step 2. Put it on the `Approval Required` sheet (`"approval": true` in the JSON), never on a run sheet.
- Mark cases that need test data the scan does not give as `test_data: TBD`. Never make up credentials or records.

## Step 5: Write the review workbook (Excel)

The Excel file is the overview the user reads and approves. It is also the file `import-cases` reads, so there is no separate CSV.

Path: `specs/_scan/<run>/<app>_test_cases_automaqa_v<version>.xlsx` (next to the scan output).

**Layout (matches the reference test-case workbook layout):**
- One sheet per screen or area, named `<App> <Area>`. Row 1 = sheet title, row 3 = header, cases from row 4, header row frozen.
- Columns, in this order: `TC ID`, `Test Type`, `Test Scenario`, `Pre-Condition`, `Test Data`, `Test Steps`, `Expected Result`.
- Cases that change or download data go on a separate sheet named `Approval Required`, with the TC ID cell shaded orange and the pre-condition starting `APPROVAL REQUIRED:`. They never share a sheet with run cases.

**Case fields:**
- `TC ID`: `<PREFIX>_<AREA>_TC_<NNN>`, for example `SUP_ANA_TC_001`. PREFIX comes from `meta.sheet_prefix` (3 to 4 capitals), AREA is a 3-letter code for the sheet, NNN restarts at 001 on each sheet. Approval cases use `APR` as the area.
- `Test Type`: one of `Navigation`, `UI`, `Functional`, `Validation`, `Negative`, `Data`, `Empty state`, `Regression`. Use the user's own labels if their criteria file used different ones.
- `Test Scenario`: short, starts with the screen or element name. Put the scan ID at the end of the cell in brackets, e.g. `Status filter lists only matching orders [AC-orders-filter]`.
- `Pre-Condition`: role signed in, the address to open, and the filter or date state. Name the QA test data prefix for approval cases.
- `Test Data`: values the case needs. Observed numbers are written as "QA observed <date>: ...". Use `-` when there is none.
- `Test Steps`: numbered, one action per line, using the labels shown in the scan text.
- `Expected Result`: copied or tightened from the scan's `must` / criterion text.

**How to write it:** do not hand-build the workbook. Write the cases to a JSON file in the scratchpad and run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline/write_cases_xlsx.js" <cases.json> <output.xlsx>
```

The input format is documented at the top of that script (`sheets[].name`, `sheets[].title`, `sheets[].cases[]` with `id`, `type`, `scenario`, `precondition`, `test_data`, `steps`, `expected`, `approval`).
It needs `exceljs`; if the script reports it missing, run `npm install exceljs` in the user's project (Node only, never Python), then run it again.
The script rejects duplicate IDs and cases without an ID. Show the user its summary line (cases written, run vs approval-required).

## Step 6: Reconcile and report

Count cases against source items and print a table: items read per section, cases written, items skipped and why.
Within each ticked section, every item must be either covered or listed as skipped. A silent gap is a failure. Unticked sections are listed as "not requested".

Also report, when a criteria file was used: criteria read, matched, unmatched, gaps found, drafts accepted / edited / skipped / not applicable, and where the updated criteria file was saved.
A case written from a user criterion keeps both traces in `scenario`: the scan ID and the criterion's line number, e.g. `[F-new-order] [crit L12]`.

Show 5 sample rows, the path, and the Q- items that block cases.

## Step 7: Approval gate, then hand off to import-cases

1. Give the user the full path of the workbook and tell them to open it. They may edit it freely: change wording, delete rows, add rows, fix IDs.
   Tell them the `Approval Required` sheet holds cases that change data and will not run without their separate yes.
2. Ask (AskUserQuestion, single-select): "Do you approve these test cases?"
   - **Approve - send to import-cases**
   - **I changed the workbook - re-read it** (re-read the file from disk, reprint the Step 6 counts, ask again)
   - **Change something - tell me what** (apply the change, rewrite the workbook, ask again)
   - **Not yet** (stop; leave the file where it is)
3. Loop until the user chooses Approve or Not yet. Never treat silence, "looks fine" about part of it, or a reply to something else as approval.
4. On Approve: re-read the workbook from disk first, so the user's edits are what is sent, and check each sheet has the header row. If a sheet is unreadable, say so and ask; do not guess.
5. Invoke `/automaqa:import-cases <workbook path>` (the Skill tool, with the `.xlsx` path as the argument). `import-cases` reads Excel directly, one feature per sheet.
   Pass the platform from Step 2. Tell it the `Approval Required` sheet is approval-only.
6. After `import-cases` finishes, remind the user that it will ask them to approve the `spec.md` files, and that testing starts only after that.

Do not write test code and do not start `playwright-e2e` or `maestro-e2e` from this skill.
