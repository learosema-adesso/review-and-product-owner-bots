import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { applyProposal, proposalProblem } from './pushfix.mjs';

/**
 * Test step of "fix it" with a push: applies the proposal to a checkout of the pull request, so the
 * tests can run on it. Only a regular file inside the checkout is touched, and only if its original
 * lines are still exactly there. Returns { ok: true } or { ok: false, reason }.
 */
export function applyToCheckout({ proposal, root, maxLines }) {
  const problem = proposalProblem(proposal, { maxLines });
  if (problem) return { ok: false, reason: `the proposal is not valid (${problem})` };

  const base = path.resolve(root);
  const file = path.resolve(base, proposal.path);
  if (!file.startsWith(base + path.sep))
    return { ok: false, reason: 'the path leaves the checkout' };

  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return { ok: false, reason: `${proposal.path} does not exist` };
  }
  // lstat does not follow links, so a symlink is not a file here; a linked folder on the way is caught below
  if (!stat.isFile()) return { ok: false, reason: `${proposal.path} is not a regular file` };
  if (!realpathSync(file).startsWith(realpathSync(base) + path.sep))
    return { ok: false, reason: 'the path leaves the checkout through a link' };

  const applied = applyProposal(readFileSync(file, 'utf8'), proposal);
  if (!applied.ok) return applied;
  writeFileSync(file, applied.text);
  return { ok: true };
}
