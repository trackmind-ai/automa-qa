/**
 * versioned-reporter.ts
 * ─────────────────────
 * Custom Playwright Reporter that writes a versioned, evidence-rich HTML report after every run.
 *
 * Output:
 *   specs/<feature-slug>/report-v{N}.html                     the human-readable report
 *   specs/<feature-slug>/evidence/v{N}/web.manifest.json      the data behind it
 *   specs/<feature-slug>/evidence/v{N}/shots/*.png            the screenshots it embeds
 * N is one past the highest existing report-v*.html / evidence/v* (see support/report-render.js).
 *
 * The slug is derived from the spec file name:
 *   tests/e2e/login-test-cases.spec.ts  →  specs/login-test-cases/report-v1.html
 *
 * Each test case in the report carries: what it checks (test annotations), the steps it took with
 * screenshots and highlighted elements (tests/support/evidence.ts), the expected vs actual result,
 * and — for failures — the error and the final screenshot. Cases with no snap()/check() steps
 * still get Playwright's automatic screenshot.
 *
 * Also owns test-health tracking: every result is appended to .automaqa/history.json,
 * the quarantine policy is applied, and the report gains a Test health section.
 * Flakiness needs history — a single run only tells you a test failed, not that it is
 * unreliable. See tests/support/flake-store.ts.
 *
 * Lifecycle:
 *   onBegin()   — record start time
 *   onTestEnd() — collect result, evidence steps and screenshot in memory
 *   onEnd()     — persist history, apply quarantine, write manifest + HTML
 *
 * Registered in playwright.config.ts as: ['./tests/versioned-reporter.ts']
 * globalTeardown is NOT used — reports are written here in onEnd().
 *
 * Mobile (Maestro) results and live-verification findings are added to the same run by
 * scripts/report/build_report.js (see the test-report skill), which re-renders this file.
 */

import type {
  Reporter,
  FullConfig,
  Suite,
  TestCase,
  TestResult,
  FullResult,
} from '@playwright/test/reporter';
import * as fs   from 'fs';
import * as path from 'path';

// Plain JS renderer copied next to this file by /automaqa:setup (single source: plugin scripts/report/render.js)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const renderer = require('./support/report-render.js') as {
  render: (m: unknown, o?: { baseDir?: string; embed?: boolean }) => string;
  mergeManifests: (dirs: string[]) => unknown;
  nextRun: (specDir: string) => string;
};

/** Attachment name used by tests/support/evidence.ts. Keep in sync. */
const STEP_ATTACHMENT = 'automaqa-step';
// eslint-disable-next-line no-control-regex
const ANSI = /[[0-9;]*m/g;

import {
  type Store,
  type HealthSummary,
  type QuarantineChange,
  testId,
  loadStore,
  saveStore,
  record,
  applyQuarantinePolicy,
  summarise,
  formatHealthSummary,
} from './support/flake-store';

interface EvidenceStep {
  action: string;
  expected?: string;
  actual?: string;
  note?: string;
  status: string;
  screenshotFile?: string;
  refSize?: { w: number; h: number };
  highlights?: unknown[];
}

interface TestRecord {
  id:       string;
  caseId:   string;
  title:    string;
  status:   string;                 // passed | failed | skipped | flaky
  duration: number;
  /** Retries Playwright needed. >0 with status "passed" means it flaked. */
  retries:  number;
  error?:   string;
  purpose?:  string;
  expected?: string;
  specRef?:  string;
  steps:    EvidenceStep[];
  /** Playwright's automatic end-of-test screenshot (screenshot: 'on'). */
  autoShot?: string;
  trace?:   string;
}

class VersionedReporter implements Reporter {
  private records: TestRecord[] = [];
  private startTime             = 0;
  private suiteName             = '';

  onBegin(_config: FullConfig, suite: Suite): void {
    this.startTime = Date.now();
    // Derive feature slug from the first spec file found
    const firstFile = suite.allTests()[0]?.location?.file ?? '';
    const base      = path.basename(firstFile, '.spec.ts');   // e.g. "login-test-cases"
    this.suiteName  = base;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const id = testId(test.location.file, suiteTitles(test));
    const note = (type: string) => test.annotations.find(a => a.type === type)?.description;

    const steps: EvidenceStep[] = [];
    for (const a of result.attachments) {
      if (a.name !== STEP_ATTACHMENT || !a.body) continue;
      try { steps.push(JSON.parse(a.body.toString('utf-8'))); } catch { /* malformed step: skip */ }
    }
    const shot  = result.attachments.find(a => a.name === 'screenshot' && a.path);
    const trace = result.attachments.find(a => a.name === 'trace' && a.path);

    const title  = test.title;
    const m      = /^\s*(TC[_-]?\d+[A-Za-z0-9_-]*)\s*[—–:-]*\s*(.*)$/i.exec(title);
    const status = result.status === 'passed' && result.retry > 0 ? 'flaky' : result.status;

    const entry: TestRecord = {
      id,
      caseId:   m ? m[1] : `T${this.records.length + 1}`,
      title:    m && m[2] ? m[2] : title,
      status,
      duration: result.duration,
      retries:  result.retry,
      error:    result.error?.message?.replace(ANSI, ''),
      purpose:  note('purpose'),
      expected: note('expected'),
      specRef:  note('spec'),
      steps,
      autoShot: shot?.path,
      trace:    trace?.path,
    };

    // A retried test fires onTestEnd once per attempt. Keep only the final
    // attempt: recording every attempt would count one run several times and
    // skew the pass rate of precisely the flaky tests being measured.
    const prev = this.records.findIndex(r => r.id === id);
    if (prev === -1) this.records.push(entry);
    else if (result.retry >= this.records[prev].retries) this.records[prev] = entry;
  }

  /**
   * Append this run to the history file and apply the quarantine policy.
   * Failures here are reported but never fatal: losing health tracking must not
   * break a test run.
   */
  private updateHealth(): { summary: HealthSummary; changes: QuarantineChange[] } | null {
    try {
      const store: Store = loadStore();
      const at  = new Date().toISOString();
      const ref = process.env.GITHUB_SHA ?? process.env.BUILD_SOURCEVERSION ?? process.env.CI_COMMIT_SHA;

      for (const r of this.records) {
        // Skipped tests carry no signal, and recording them would dilute pass rates.
        if (r.status === 'skipped') continue;
        record(store, r.id, {
          at,
          outcome:  r.status === 'passed' || r.status === 'flaky' ? 'passed' : 'failed',
          duration: r.duration,
          retries:  r.retries,
          ...(ref ? { ref } : {}),
        });
      }

      const changes = applyQuarantinePolicy(store);
      saveStore(store);
      return { summary: summarise(store), changes };
    } catch (err) {
      process.stderr.write(
        `  [health] tracking skipped: ${(err as Error).message}\n`,
      );
      return null;
    }
  }

  onEnd(_result: FullResult): void {
    if (!this.suiteName) return;

    const health = this.updateHealth();

    const specDir = path.join('specs', this.suiteName);
    fs.mkdirSync(specDir, { recursive: true });

    const run     = renderer.nextRun(specDir);                       // "v3"
    const runDir  = path.join(specDir, 'evidence', run);
    const shotDir = path.join(runDir, 'shots');
    fs.mkdirSync(shotDir, { recursive: true });
    const outFile = path.join(specDir, `report-${run}.html`);

    /** Copy a screenshot out of Playwright's output dir (wiped next run); return a manifest-relative path. */
    const keep = (src: string | undefined, name: string): string | undefined => {
      if (!src || !fs.existsSync(src)) return undefined;
      fs.copyFileSync(src, path.join(shotDir, name));
      return `shots/${name}`;
    };

    const cases = this.records.map((r, ci) => {
      const key = `${String(ci + 1).padStart(3, '0')}-${r.caseId.replace(/[^\w-]/g, '')}`;
      const steps: Array<Record<string, unknown>> = r.steps.map((s, si) => ({
        action: s.action, expected: s.expected, actual: s.actual, note: s.note, status: s.status,
        screenshot: keep(s.screenshotFile, `${key}-s${si + 1}.png`),
        refSize: s.refSize, highlights: s.highlights,
      }));
      const finalShot = keep(r.autoShot, `${key}-final.png`);
      // A step list tells the story; add the end-of-test screenshot to it for failures so the
      // reader sees the state the app was left in, and use it alone when no steps were recorded.
      if (finalShot && r.status !== 'passed' && steps.length) {
        steps.push({ action: 'State of the page when the test ended', status: 'failed', screenshot: finalShot });
      }
      const firstLine = r.error?.split('\n').find(l => l.trim());
      return {
        id: r.caseId, title: r.title, platform: 'web', source: 'automated',
        status: r.status, durationMs: r.duration, retries: r.retries,
        purpose: r.purpose, expected: r.expected, specRef: r.specRef,
        steps,
        finalScreenshot: steps.length ? undefined : finalShot,
        verdict:
          r.status === 'failed'  ? failureVerdict(steps, firstLine) :
          r.status === 'flaky'   ? `Passed only after ${r.retries} retry — the result is not reliable.` :
          r.status === 'skipped' ? 'The test did not run (skipped or quarantined).' :
          r.expected             ? `Every check passed: ${r.expected}` : undefined,
        error: r.error,
        trace: r.trace ? tidyPath(r.trace) : undefined,
      };
    });

    const manifest = {
      schema: 1,
      feature: this.suiteName,
      run,
      title: `${this.suiteName} — test report ${run}`,
      spec: fs.existsSync(path.join(specDir, 'spec.md')) ? path.join(specDir, 'spec.md').replace(/\\/g, '/') : undefined,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - this.startTime,
      environment: { platform: 'web (Playwright)', node: process.version, os: process.platform },
      cases,
      bugs: [] as unknown[],
      health: health ? healthSection(health) : null,
    };
    fs.writeFileSync(path.join(runDir, 'web.manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

    // Render from the merged evidence for this run, so live-verification findings
    // (evidence/live) and any mobile manifest already present are folded in.
    const merged = renderer.mergeManifests([path.join(specDir, 'evidence', 'live'), runDir]);
    fs.writeFileSync(outFile, renderer.render(merged, { baseDir: specDir }), 'utf-8');
    console.log(`\n📊 Report written → ${outFile}`);
    console.log(`   Evidence       → ${runDir}`);

    if (health) {
      const text = formatHealthSummary(health.summary);
      if (text) console.log(text);
      for (const c of health.changes) {
        const verb = c.action === 'quarantined' ? 'QUARANTINED' : 'RELEASED';
        console.log(`  [${verb}] ${c.id} — ${c.reason}`);
      }
    }
    console.log('');
  }
}

/** Explain a failure in words: which step, what was expected, what actually happened. */
function failureVerdict(steps: Array<Record<string, unknown>>, errorLine?: string): string {
  const i = steps.findIndex(s => s.status === 'failed' && s.expected);
  if (i === -1) return errorLine?.replace(/^Error:\s*/, '') ?? 'The test failed.';
  const s = steps[i];
  const action = String(s.action).replace(/\.+$/, '');
  return `Step ${i + 1} (${action}) did not behave as expected. Expected: ${s.expected}. ` +
         `What happened: ${s.actual ?? errorLine ?? 'the check failed'}.`;
}

/** Relative to the project when it is inside it, absolute otherwise. */
function tidyPath(p: string): string {
  const rel = path.relative(process.cwd(), p);
  return rel.startsWith('..') ? p : rel;
}

/** Convert the health summary to the manifest's structured form (rendered by report-render.js). */
function healthSection(
  health: { summary: HealthSummary; changes: QuarantineChange[] },
): { line: string; sections: Array<{ title: string; kind?: string; items: Array<{ id: string; reason: string }> }> } | null {
  const { summary, changes } = health;
  const { flakedThisRun, flakyOverTime, consistentlyFailing, quarantined } = summary;
  if (!flakedThisRun.length && !flakyOverTime.length && !consistentlyFailing.length
      && !quarantined.length && !changes.length) return null;

  const items = (v: Array<{ id: string; reason: string }>) => v.slice(0, 25).map(x => ({ id: x.id, reason: x.reason }));
  return {
    line: `Tracked tests: ${summary.totalTracked} | Flake rate: ${(summary.flakeRate * 100).toFixed(1)}%`,
    sections: [
      { title: 'Changed this run', items: changes.map(c => ({ id: c.id, reason: `${c.action === 'quarantined' ? 'Quarantined' : 'Released'} — ${c.reason}` })) },
      { title: 'Flaked in this run (passed only after a retry)', items: items(flakedThisRun) },
      { title: 'Unreliable over time', items: items(flakyOverTime) },
      { title: 'Consistently failing — real bugs, NOT quarantined', kind: 'broken', items: items(consistentlyFailing) },
      { title: 'Currently quarantined', items: items(quarantined) },
    ],
  };
}

/**
 * Titles identifying the test within its file — Playwright's titlePath() begins
 * with the project name and the file name, both of which are already captured
 * elsewhere in the id, so including them would duplicate the filename.
 */
function suiteTitles(test: TestCase): string[] {
  const file = test.location.file.split(/[\\/]/).pop() ?? '';
  return test.titlePath().filter(t => Boolean(t) && t !== file);
}

export default VersionedReporter;
