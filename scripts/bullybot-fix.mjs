import { clampFixMaxLines } from './bullybot/fix.mjs';
import { finishFix } from './bullybot/pushfix.mjs';

/**
 * Last step of "fix it" with a push, run after the tests of the fix. `proposal` is the JSON text of
 * the job output of the first step, nothing in it is trusted (finishFix checks it again).
 */
export async function bullybotFix({
  github,
  context,
  core,
  proposal,
  testsResult,
  testLog = '',
  fixMaxLines,
}) {
  const { owner, repo } = context.repo;
  let parsed;
  try {
    parsed = JSON.parse(proposal);
  } catch {
    core.warning('There is no usable fix proposal, nothing to do.');
    return { status: 'invalid' };
  }
  const outcome = await finishFix({
    github,
    core,
    owner,
    repo,
    proposal: parsed,
    testsResult,
    testLog,
    maxLines: clampFixMaxLines(fixMaxLines),
  });
  core.info(`Fix for thread ${parsed?.threadId}: ${outcome.status}.`);
  return outcome;
}
