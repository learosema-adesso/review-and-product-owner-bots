import * as realFs from 'node:fs';
import path from 'node:path';
import { applyProposal, proposalProblem } from './pushfix.mjs';

/**
 * Test step of "fix it" with a push: applies the proposal to a checkout of the pull request, so the
 * tests can run on it. Only a regular file inside the checkout is touched, and only if its original
 * lines are still exactly there. Returns { ok: true } or { ok: false, reason }, it never throws for a
 * file it cannot handle. `fs` is a test seam.
 */
export function applyToCheckout({ proposal, root, maxLines, fs = realFs }) {
  const problem = proposalProblem(proposal, { maxLines });
  if (problem) return { ok: false, reason: `the proposal is not valid (${problem})` };

  const base = path.resolve(root);
  const file = path.resolve(base, proposal.path);
  if (!file.startsWith(base + path.sep))
    return { ok: false, reason: 'the path leaves the checkout' };

  try {
    // lstat does not follow links, so a symlink is not a file here; a linked folder on the way is caught below
    if (!fs.lstatSync(file).isFile())
      return { ok: false, reason: `${proposal.path} is not a regular file` };
    if (!fs.realpathSync(file).startsWith(fs.realpathSync(base) + path.sep))
      return { ok: false, reason: 'the path leaves the checkout through a link' };

    const applied = applyProposal(fs.readFileSync(file, 'utf8'), proposal);
    if (!applied.ok) return applied;
    fs.writeFileSync(file, applied.text);
    return { ok: true };
  } catch (error) {
    return error?.code === 'ENOENT'
      ? { ok: false, reason: `${proposal.path} does not exist` }
      : { ok: false, reason: `${proposal.path} could not be handled (${error?.code ?? error})` };
  }
}
