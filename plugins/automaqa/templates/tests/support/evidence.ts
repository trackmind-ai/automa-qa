/**
 * evidence.ts
 * ───────────
 * Step-level evidence for the automaqa report: a screenshot per meaningful step, with the
 * relevant element(s) highlighted and a plain-English description of what the step did and
 * what it expected. tests/versioned-reporter.ts collects these into the final HTML report.
 *
 *   import { snap, check } from './support/evidence';
 *
 *   test('TC_002 — wrong password shows an error', {
 *     annotation: [
 *       { type: 'purpose',  description: 'A wrong password must be rejected with a clear message.' },
 *       { type: 'expected', description: 'Error "Wrong email or password." is shown; user stays on login.' },
 *       { type: 'spec',     description: 'spec.md §3.2 Login validation' },
 *     ],
 *   }, async ({ page }, testInfo) => {
 *     await page.getByLabel('Password').fill('wrongpass');
 *     await snap(page, testInfo, {
 *       action: 'Typed a wrong password',
 *       marks:  [{ locator: page.getByLabel('Password'), label: 'Password field' }],
 *     });
 *     await clickAndWait(page, 'Log In');
 *     await check(page, testInfo, {
 *       action:   'Submitted the form',
 *       expected: 'An error message appears',
 *       marks:    [{ locator: page.getByText('Wrong email or password.'), label: 'Error message' }],
 *       assert:   () => expect(page.getByText('Wrong email or password.')).toBeVisible(),
 *     });
 *   });
 *
 * Highlights are recorded as coordinates and drawn by the report over the UNMODIFIED screenshot
 * (nothing is injected into the page under test, so the evidence cannot change the behaviour it
 * documents). Evidence failures never fail a test: a screenshot problem is swallowed, an
 * assertion failure inside check() is re-thrown unchanged.
 */
import type { Page, Locator, TestInfo } from '@playwright/test';

export type MarkKind = 'target' | 'expected' | 'problem' | 'note';

export interface Mark {
  locator: Locator;
  /** Short name shown in the legend under the screenshot, e.g. "Password field". */
  label: string;
  /** target = what the step acted on (default for snap). expected/problem are set by check(). */
  kind?: MarkKind;
}

export interface StepInput {
  /** Plain-English description of what the step did, e.g. "Typed a wrong password". */
  action: string;
  expected?: string;
  actual?: string;
  note?: string;
  marks?: Mark[];
}

export interface CheckInput extends StepInput {
  /** The assertion. Runs first; the screenshot is taken after, green on pass and red on fail. */
  assert: () => Promise<unknown>;
}

/** Name of the attachment the reporter looks for. Keep in sync with versioned-reporter.ts. */
export const STEP_ATTACHMENT = 'automaqa-step';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Turn a Playwright assertion error into one readable sentence:
 *   "expect(locator).toBeVisible() failed" + "Error: element(s) not found"
 *   -> "expect(locator).toBeVisible() failed — element(s) not found"
 * Falls back to the first line, so unusual errors are still reported rather than hidden.
 */
function describeFailure(msg: string): string {
  const lines = msg.split('\n').map(l => l.trim()).filter(Boolean);
  const head = (lines[0] ?? msg).replace(/^Error:\s*/, '');
  const detail = lines.slice(1).find(l => /^(Error:|Received:)/.test(l))?.replace(/^Error:\s*/, '');
  return (detail ? `${head} — ${detail}` : head).slice(0, 300);
}

async function viewport(page: Page): Promise<{ w: number; h: number }> {
  const vp = page.viewportSize();
  if (vp) return { w: vp.width, h: vp.height };
  return page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
}

async function record(
  page: Page,
  testInfo: TestInfo,
  input: StepInput,
  status: 'passed' | 'failed',
  defaultKind: MarkKind,
): Promise<void> {
  try {
    const n = testInfo.attachments.filter(a => a.name === STEP_ATTACHMENT).length + 1;
    const marks = input.marks ?? [];

    // Bring the first mark into view so it is inside the (viewport-only) screenshot.
    const first = marks[0]?.locator.first();
    if (first) await first.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});

    const highlights = [];
    for (const m of marks) {
      const box = await m.locator.first().boundingBox({ timeout: 1500 }).catch(() => null);
      if (!box) continue;                       // absent element — nothing to outline
      highlights.push({
        x: box.x, y: box.y, w: box.width, h: box.height,
        label: m.label,
        kind: status === 'failed' && !m.kind ? 'problem' : (m.kind ?? defaultKind),
      });
    }

    const file = testInfo.outputPath(`automaqa-step-${n}.png`);
    await page.screenshot({ path: file });      // viewport only: coordinates above match it

    const body = {
      action: input.action,
      expected: input.expected,
      actual: input.actual,
      note: input.note,
      status,
      screenshotFile: file,
      refSize: await viewport(page),
      highlights,
    };
    await testInfo.attach(STEP_ATTACHMENT, {
      body: JSON.stringify(body),
      contentType: 'application/json',
    });
  } catch (err) {
    process.stderr.write(`  [evidence] step skipped: ${(err as Error).message}\n`);
  }
}

/** Record a step: screenshot + highlighted element(s) + description. Never throws. */
export async function snap(page: Page, testInfo: TestInfo, input: StepInput): Promise<void> {
  await record(page, testInfo, input, 'passed', 'target');
}

/**
 * Run an assertion and record it as a step. On pass the marks are green ("expected"); on fail
 * they turn red ("problem"), the actual result is taken from the error, and the original error
 * is re-thrown so the test still fails exactly as it would have without evidence.
 */
export async function check(page: Page, testInfo: TestInfo, input: CheckInput): Promise<void> {
  try {
    await input.assert();
  } catch (err) {
    const msg = String((err as Error).message ?? err).replace(ANSI, '');
    await record(
      page, testInfo,
      { ...input, actual: input.actual ?? describeFailure(msg) },
      'failed', 'problem',
    );
    throw err;
  }
  await record(page, testInfo, { ...input, actual: input.actual ?? input.expected }, 'passed', 'expected');
}
