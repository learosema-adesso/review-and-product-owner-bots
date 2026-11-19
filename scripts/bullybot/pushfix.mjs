import { MARKER } from './review.mjs';
import { postReply } from './threads.mjs';
import { FIX_MARKER, isProtectedPath, mayAskForFix, renderSuggestion, splitLines } from './fix.mjs';

/**
 * "Fix it for me", phase 2: after a human asked for a fix, BullyBot can commit it to the branch of
 * the pull request himself, if the tests pass first. This file is the logic, the workflow runs it in
 * three steps with different rights:
 *
 *   1. propose  (bullybot.mjs)   the model writes the fix, the result is a "proposal" (data only)
 *   2. test     (workflow)       the proposal is applied in a scratch checkout, the tests run there
 *   3. finish   (finishFix)      with the tests green the commit is made, otherwise the thread gets the suggestion
 *
 * The code of the pull request only runs in step 2, which never has a token that can write.
 */

export const FIX_TRAILER = 'BullyBot-Fix';
const SHA = /^[0-9a-f]{40}$/;
const WRITABLE_MODES = new Set(['100644', '100755']);
const LOG_TAIL_LINES = 25;
const LOG_TAIL_CHARS = 1500;

const errorText = (error) => String(error?.message ?? error).replace(/\s+/g, ' ');

/** Why a fix cannot be pushed to this pull request, or null if it can. Forks and protected branches get the suggestion. */
export async function pushBlockedReason({ github, owner, repo, pr }) {
  const head = pr.head?.repo;
  const base = pr.base?.repo;
  if (!head || !base || head.full_name !== base.full_name)
    return 'the pull request comes from a fork, and I never push there';
  if (pr.head.ref === base.default_branch)
    return 'the branch is the default branch of the repository';
  try {
    const { data } = await github.rest.repos.getBranch({ owner, repo, branch: pr.head.ref });
    if (data.protected) return 'the branch is protected';
  } catch (error) {
    return `I could not look at the branch (${errorText(error)})`;
  }
  return null;
}

/** True if BullyBot already pushed a fix for this thread (a thread gets one automatic fix). */
export async function hasAutoFix({ github, owner, repo, prNumber, threadId }) {
  const commits = await github.paginate(github.rest.pulls.listCommits, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  return commits.some((c) => String(c.commit?.message).includes(`${FIX_TRAILER}: ${threadId}`));
}

/**
 * What may happen to the fix requests of this run: the first one may become a proposal, the others
 * (and every one that cannot be pushed) get the suggestion. Returns `plan(thread)`.
 */
export async function planPushes({ github, owner, repo, pr, enabled }) {
  if (!enabled) return () => ({ enabled: false });
  const blocked = await pushBlockedReason({ github, owner, repo, pr });
  let taken = false;
  return async (thread) => {
    if (blocked) return { enabled: true, blockedReason: blocked };
    if (taken) return { enabled: true, blockedReason: 'only one fix is pushed per run' };
    try {
      if (await hasAutoFix({ github, owner, repo, prNumber: pr.number, threadId: thread.id }))
        return { enabled: true, blockedReason: 'I already pushed a fix for this thread' };
    } catch (error) {
      return {
        enabled: true,
        blockedReason: `I could not check the commits (${errorText(error)})`,
      };
    }
    taken = true;
    return { enabled: true, blockedReason: null };
  };
}

const isLines = (v) => Array.isArray(v) && v.every((l) => typeof l === 'string');
const isLine = (n) => Number.isInteger(n) && n >= 1;

/** Checks a proposal that came through a job output. Nothing in it is trusted. Returns an error text or null. */
export function proposalProblem(p, { maxLines }) {
  if (!p || typeof p !== 'object' || p.v !== 1) return 'unknown format';
  for (const key of ['threadId', 'path', 'headRef', 'requestedBy', 'explanation'])
    if (typeof p[key] !== 'string' || !p[key]) return `${key} is missing`;
  if (!SHA.test(String(p.baseSha))) return 'baseSha is not a commit';
  if (!isLine(p.prNumber)) return 'prNumber is not a number';
  if (!isLine(p.startLine) || !isLine(p.endLine) || p.startLine > p.endLine)
    return 'bad line range';
  if (!isLines(p.original) || !isLines(p.replacement) || !p.original.length) return 'bad lines';
  if (p.original.length !== p.endLine - p.startLine + 1) return 'the range does not fit the lines';
  if (p.replacement.length > maxLines) return `more than ${maxLines} lines`;
  if (p.path.startsWith('/') || p.path.split('/').includes('..') || isProtectedPath(p.path))
    return 'path is not allowed';
  return null;
}

/**
 * Applies the proposal to the text of the file. Only if the original lines are still exactly there.
 * Line endings (LF or CRLF) and the final newline stay as they were.
 */
export function applyProposal(text, p) {
  const crlf = text.includes('\r\n');
  const finalNewline = /\n$/.test(text);
  const lines = splitLines(text);
  if (p.endLine > lines.length) return { ok: false, reason: 'the file is shorter now' };
  const current = lines.slice(p.startLine - 1, p.endLine);
  if (current.join('\n') !== p.original.join('\n'))
    return { ok: false, reason: 'the lines have changed since I looked at them' };
  const next = [...lines.slice(0, p.startLine - 1), ...p.replacement, ...lines.slice(p.endLine)];
  const eol = crlf ? '\r\n' : '\n';
  return { ok: true, text: next.join(eol) + (finalNewline ? eol : '') };
}

/** Message of the fix commit. The trailers are ours: lines of the explanation that look like trailers are dropped. */
export function commitMessage(p, coAuthor) {
  const body = p.explanation
    .split('\n')
    .filter((l) => !/^\s*(co-authored-by|bullybot-fix|signed-off-by)\s*:/i.test(l))
    .join('\n')
    .trim();
  const trailers = [`${FIX_TRAILER}: ${p.threadId}`, coAuthor && `Co-authored-by: ${coAuthor}`];
  return [`BullyBot: fix ${p.path}:${p.startLine}`, body, trailers.filter(Boolean).join('\n')]
    .filter(Boolean)
    .join('\n\n');
}

async function coAuthorOf(github, login) {
  try {
    const { data } = await github.rest.users.getByUsername({ username: login });
    return `${login} <${data.id}+${login}@users.noreply.github.com>`;
  } catch {
    return null;
  }
}

/**
 * Creates the commit on the branch of the pull request, as the identity of the token (the GitHub
 * App), on top of the commit the tests ran on. The ref is updated without force: if the branch moved
 * in the meantime GitHub refuses, and nothing is retried.
 * Returns { status: 'pushed', sha, url } or { status: 'moved' | 'does_not_apply' | 'refused', reason }.
 */
export async function pushFix({ github, owner, repo, proposal: p }) {
  const git = github.rest.git;
  try {
    const { data: ref } = await git.getRef({ owner, repo, ref: `heads/${p.headRef}` });
    if (ref.object.sha !== p.baseSha) return { status: 'moved', reason: 'the branch has moved on' };

    const { data: base } = await git.getCommit({ owner, repo, commit_sha: p.baseSha });
    const { data: tree } = await git.getTree({
      owner,
      repo,
      tree_sha: base.tree.sha,
      recursive: 'true',
    });
    if (tree.truncated) return { status: 'refused', reason: 'the file tree is too big to read' };
    const entry = tree.tree.find((e) => e.path === p.path && e.type === 'blob');
    if (!entry) return { status: 'refused', reason: `${p.path} is not in the repository` };
    if (!WRITABLE_MODES.has(entry.mode))
      return { status: 'refused', reason: `${p.path} is not a regular file` };

    const { data: blob } = await git.getBlob({ owner, repo, file_sha: entry.sha });
    const text = Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8').toString(
      'utf8',
    );
    const applied = applyProposal(text, p);
    if (!applied.ok) return { status: 'does_not_apply', reason: applied.reason };

    const { data: newBlob } = await git.createBlob({
      owner,
      repo,
      content: applied.text,
      encoding: 'utf-8',
    });
    const { data: newTree } = await git.createTree({
      owner,
      repo,
      base_tree: base.tree.sha,
      tree: [{ path: p.path, mode: entry.mode, type: 'blob', sha: newBlob.sha }],
    });
    const { data: commit } = await git.createCommit({
      owner,
      repo,
      message: commitMessage(p, await coAuthorOf(github, p.requestedBy)),
      tree: newTree.sha,
      parents: [p.baseSha],
    });
    try {
      await git.updateRef({
        owner,
        repo,
        ref: `heads/${p.headRef}`,
        sha: commit.sha,
        force: false,
      });
    } catch (error) {
      if (error.status === 422) return { status: 'moved', reason: 'the branch has moved on' };
      throw error;
    }
    return { status: 'pushed', sha: commit.sha, url: commit.html_url };
  } catch (error) {
    return { status: 'refused', reason: `GitHub said no (${errorText(error)})` };
  }
}

/** The end of a test log for the thread: colors removed, a few lines, in a fence the log cannot break out of. */
export function summarizeTestLog(log) {
  const clean = String(log ?? '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r/g, '');
  const lines = clean.split('\n').filter((l) => l.trim());
  const tail = lines.slice(-LOG_TAIL_LINES).join('\n').slice(-LOG_TAIL_CHARS);
  if (!tail) return '';
  const longest = Math.max(2, ...[...tail.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${tail}\n${fence}`;
}

const TESTS_NOT_GREEN = {
  failure: 'The tests failed with the change, so I pushed nothing.',
  cancelled: 'The test run was cancelled, so I pushed nothing.',
  skipped: 'The tests did not run, and I do not push untested code.',
};

/**
 * The last step of a fix request that became a proposal. Tests green: push the commit. Anything else:
 * the thread gets the suggestion and the reason. Always replies once, never throws for a refusal.
 * Returns { status } (pushed, tests_failed, blocked, moved, does_not_apply, refused, invalid, no_rights, closed).
 */
export async function finishFix({
  github,
  core,
  owner,
  repo,
  proposal,
  testsResult,
  testLog = '',
  maxLines,
}) {
  const problem = proposalProblem(proposal, { maxLines });
  if (problem) {
    core?.warning(`The fix proposal was not used: ${problem}.`);
    return { status: 'invalid', reason: problem };
  }
  const say = (text) => postReply(github, proposal.threadId, text);
  const suggest = (reason, extra = '') =>
    say(
      renderSuggestion(
        `${reason}${extra ? `\n\n${extra}` : ''}\n\nHere is the change as a suggestion, you can apply it yourself:\n\n${proposal.explanation}`,
        proposal.replacement,
      ),
    );

  const { data: pr } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: proposal.prNumber,
  });
  if (pr.state !== 'open') return { status: 'closed' };

  if (!(await mayAskForFix({ github, owner, repo, username: proposal.requestedBy }))) {
    await say(
      `${MARKER}\nOnly people with write access can have me push, and ${proposal.requestedBy} has lost it.`,
    );
    return { status: 'no_rights' };
  }

  if (testsResult !== 'success') {
    const summary = testsResult === 'failure' ? summarizeTestLog(testLog) : '';
    await suggest(
      TESTS_NOT_GREEN[testsResult] ?? TESTS_NOT_GREEN.skipped,
      summary && `The end of the log:\n\n${summary}`,
    );
    return { status: 'tests_failed' };
  }

  const blocked = await pushBlockedReason({ github, owner, repo, pr });
  if (blocked) {
    await suggest(`I did not push: ${blocked}.`);
    return { status: 'blocked', reason: blocked };
  }
  if (await hasAutoFix({ github, owner, repo, prNumber: pr.number, threadId: proposal.threadId })) {
    await suggest('I did not push: I already pushed a fix for this thread.');
    return { status: 'blocked', reason: 'already fixed' };
  }

  const result = await pushFix({ github, owner, repo, proposal });
  if (result.status === 'pushed') {
    await say(
      `${MARKER}${FIX_MARKER}\nCommitted: ${result.url}. The tests passed before I pushed it. ` +
        'Now I will have a look at my own finding again.',
    );
    core?.info(`Pushed the fix for ${proposal.path} as ${result.sha}.`);
    return { status: 'pushed', sha: result.sha };
  }
  const why =
    result.status === 'moved'
      ? `The branch moved while I was working, so I pushed nothing and I will not try again on my own (${result.reason}).`
      : `I did not push: ${result.reason}.`;
  await suggest(why);
  return { status: result.status, reason: result.reason };
}
