# AutomaQA — Playwright + Maestro E2E

AutomaQA sets up and drives end-to-end testing from Claude. It installs and verifies the
toolchain (Playwright for web, Maestro for mobile), turns your test cases into reviewable
specs, writes and runs the automation, verifies it live against the real app, and produces
versioned HTML reports. It also tracks flaky tests across runs and quarantines unreliable
ones instead of deleting them.

## Install

```bash
/plugin marketplace add trackmind-ai/marketplace
/plugin install automaqa@trackmind
```

Then run `/automaqa:setup` (or `/automaqa:setup web`, `/automaqa:setup mobile`).

## What you get

| Skill | What it does |
|---|---|
| `setup` | Detects your OS, installs only what is missing, ends with a status table |
| `import-cases` | Reads test cases from Excel, CSV, JSON, Markdown, Gherkin, YAML, XML or plain text into `spec.md` files for your review |
| `playwright-e2e`, `playwright-skill` | Writes and runs Playwright web tests |
| `maestro-e2e`, `maestro-skill` | Writes and runs Maestro mobile flows |
| `page-objects` | Keeps selectors in page objects, not in tests |
| `self-healing` | Falls back to alternative locators and reports every heal; refuses ambiguous matches |
| `flake-guard` | Classifies flaky tests from run history and quarantines them |
| `scan` | Reads a live web app or Android/iOS app, read-only, and writes a reference document (PDF, Word, TOON) that test cases can be written from |
| `scan-to-cases` | Turns a scan into test cases in an Excel review workbook, then hands the approved workbook to `import-cases` |
| `test-report` | Builds one self-contained HTML test report with step-by-step screenshots and the relevant elements highlighted |
| `language-check` | Reads the text of a live app, read-only, and reports spelling, grammar and wording problems with a highlighted screenshot for each |
| `api-collection-test` | Runs the requests in a Postman collection, checks status codes and response bodies, and writes a pass/fail HTML report |

An agent, `test-orchestrator`, coordinates the pipeline. Automation never starts until you
approve the generated specs.

## What this plugin runs, installs, sends and fetches

Nothing here is hidden. This is the complete list.

**Hooks.** None. This plugin ships no hooks, so nothing runs automatically on your tool calls.

**What `/automaqa:setup` installs on your machine** (it asks Claude to run these commands,
which you approve through Claude's normal permission prompts):

- `npm install` of `@playwright/test`, `typescript`, `ts-node`, `@types/node` and `xlsx` in *your*
  project, and `npx playwright install chromium` (downloads a Chromium build).
- Web scope only needs Node.js. Mobile scope also needs Java 17+ and the Maestro CLI.
  On macOS and Linux it is installed with Homebrew (`brew install mobile-dev-inc/tap/maestro`);
  without Homebrew the setup skill asks you to follow Maestro's official install guide and
  tell it when you are done. On Windows it uses `scoop install maestro`. The plugin never
  downloads or runs an installer itself.
- Registers MCP servers with Claude Code: `claude mcp add --scope user maestro maestro mcp`
  (user scope, so it applies to all your projects), and installs the Chrome DevTools MCP
  plugin (`claude plugin install chrome-devtools-mcp`). Both load after you restart Claude Code. Skip mobile or web scope to skip the
  matching registration.
- Copies template files from this plugin into your project: `playwright.config.ts`,
  `tests/versioned-reporter.ts`, `pages/support/healing-locator.ts`,
  `tests/support/flake-store.ts` and `quarantine.ts`.

**Scanning and language checks (`scan`, `language-check`).** These browse a live app you name,
using Playwright or, if you choose, your own already-signed-in browser through Chrome remote
debugging on `http://localhost:9222`. They are read-only: they open pages and forms and read
the text, and they refuse to submit, save, delete or send anything. Everything is written
locally: `scan` writes PDF, Word and TOON files to `specs/_scan/`, and `language-check` writes
its report and screenshots to `specs/_language/`. Screenshots can show whatever the app shows,
including personal data in a test account, so review them before sharing. Nothing is sent to an
external grammar or spelling service.

**API testing (`api-collection-test`).** This sends HTTP requests, including auth headers and
tokens, to the hosts named in the Postman collection you give it. Those requests are the only
network traffic it generates.

- It is read-only by default: only GET-style requests run. Create, update and delete calls are
  skipped.
- `--mode full` allows POST, PUT and PATCH requests. It also needs `--confirm-host <hostname>`
  for each host that will be written to, and it refuses hosts that look like production unless
  you add `--allow-production-writes`. DELETE calls also need `--allow-destructive`, and calls
  that look like they send e-mail, SMS or one-time codes need `--allow-sensitive`.
- Tokens and auth headers are only sent to hosts you confirmed: the host you supply as the base
  URL (in `inputs.json`, an environment file or an `AUTOMAQA_API_*` variable) or a
  `--confirm-host` value. A base URL that appears only inside the collection file is not trusted.
  A request to any other host is skipped with "would send credentials to <host>" and is not sent.
- `scripts/api/store-secret.js` saves an access token you captured from your signed-in browser
  into `.automaqa/api/inputs.json`, **in plain text**. That file is git-ignored in this
  repository, and `/automaqa:setup` adds `.automaqa/` to your project's `.gitignore`. Never
  commit it. Check with `git check-ignore .automaqa/api/inputs.json`. Tokens are masked in
  the report and in `results.json`.

Nothing is sent to Trackmind or to any telemetry service by any of these skills.

**Network access.** Setup downloads the packages and installers above. Setup also checks
`http://localhost:9222` to see whether Chrome remote debugging is enabled. During test runs
the only traffic is your own application under test. The plugin does not send telemetry,
and sends none of your files, test cases or results to any service.

**Files it writes.** In your project only: `specs/` (specs, reports, and `specs/_scan/` and
`specs/_language/` output), `tests/e2e/`, `maestro/flows/`, `.automaqa/history.json` (flake
history, capped in size), `.automaqa/api/` (API test plan, inputs including saved tokens,
results and reports) and `.automaqa/scan-tmp/` (scratch files for a scan). It never
writes inside the plugin folder.

**Data.** Test cases you import are read locally and become Markdown specs on disk. They
are seen by Claude as part of your conversation, like any file you ask it to read.

## Try it

Five prompts to start with:

1. `/automaqa:setup web`. Installs and checks Playwright and ends with a status table.
2. "Import the test cases from `login-cases.xlsx` into specs for my review." Reads the file
   and writes one `spec.md` per feature for you to approve.
3. "I approve the login spec. Write the Playwright tests, run them, and show me the report."
   Writes and runs the tests, then produces a versioned HTML report.
4. "Scan the web app at `http://localhost:3000` and write a reference document." Reads the app
   without changing anything and writes the PDF, Word and TOON files to `specs/_scan/`.
5. "Smoke-test the API in `orders.postman_collection.json`." Asks only for the inputs it is
   missing, runs read-only, and writes an HTML report to `.automaqa/api/reports/`.

## Troubleshooting

- **Setup says a tool is missing that you know is installed.** It is not on `PATH` for the
  shell Claude Code started. Check `node -v` in a fresh terminal and restart Claude Code.
- **Maestro MCP is unavailable right after setup.** MCP servers load at startup, so restart
  Claude Code, then check `claude mcp list`.
- **No report after a run.** Check that `playwright.config.ts` lists
  `./tests/versioned-reporter.ts` as a reporter, or re-run `/automaqa:setup`.

More answers are in the full
[troubleshooting guide](https://github.com/trackmind-ai/automa-qa/blob/main/docs/troubleshooting.md).

## Requirements

Node.js LTS (the API test scripts use the built-in `fetch`, so use a current LTS). `scan`,
`language-check` and `test-report` use the Playwright and Chromium that `/automaqa:setup web`
installs; scanning your signed-in browser also needs Chrome started with remote debugging, which
setup prepares. `scan-to-cases` writes its Excel workbook with the `xlsx` package setup already
installs. `api-collection-test` needs no extra packages. For mobile: Java 17+, Maestro, and a booted emulator, simulator or device.
Python is not required.

## Documentation, support and license

Full guides (setup, workflow, authoring, intake, test health, troubleshooting) are in the
[`docs/`](https://github.com/trackmind-ai/automa-qa/tree/main/docs) folder of the repository.
Report problems at <https://github.com/trackmind-ai/automa-qa/issues>.
Licensed under the MIT License (see the repository `LICENSE`).
