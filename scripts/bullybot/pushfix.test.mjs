import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyProposal,
  commitMessage,
  finishFix,
  hasAutoFix,
  planPushes,
  proposalProblem,
  pushBlockedReason,
  pushFix,
  summarizeTestLog,
} from './pushfix.mjs';
import { FIX_MARKER } from './fix.mjs';
import { MARKER } from './review.mjs';

const BASE = 'a'.repeat(40);
const TEXT = 'one\ntwo\nthree\nfour\n';
const proposal = (extra = {}) => ({
  v: 1,
  threadId: 'T1',
  path: 'src/a.mjs',
  startLine: 2,
  endLine: 3,
  original: ['two', 'three'],
  replacement: ['TWO', 'THREE'],
  explanation: 'Shouted at the lines.',
  baseSha: BASE,
  headRef: 'feat/x',
  prNumber: 7,
  requestedBy: 'lea',
  ...extra,
});
const sameRepoPr = (extra = {}) => ({
  number: 7,
  state: 'open',
  head: { ref: 'feat/x', sha: BASE, repo: { full_name: 'o/r' } },
  base: { repo: { full_name: 'o/r', default_branch: 'main' } },
  ...extra,
});

/** A fake GitHub with a git database in memory. `calls` records every write. */
function fakeGithub({
  pr = sameRepoPr(),
  isProtected = false,
  refSha = BASE,
  text = TEXT,
  mode = '100644',
  truncated = false,
  role = 'write',
  commits = [],
  updateRefError,
  noUser = false,
} = {}) {
  const calls = [];
  const replies = [];
  const note = (name) => (params) => {
    calls.push([name, params]);
  };
  const github = {
    calls,
    replies,
    paginate: async (fn, params) => (await fn(params)).data,
    graphql: async (q, vars) => {
      replies.push(vars.body);
      return {};
    },
    rest: {
      pulls: {
        get: async () => ({ data: pr }),
        listCommits: async () => ({ data: commits.map((message) => ({ commit: { message } })) }),
      },
      repos: {
        getBranch: async () => ({ data: { protected: isProtected } }),
        getCollaboratorPermissionLevel: async () => ({
          data: { role_name: role, permission: role },
        }),
      },
      users: {
        getByUsername: async ({ username }) => {
          if (noUser) throw new Error('Not Found');
          return { data: { id: 42, login: username } };
        },
      },
      git: {
        getRef: async () => ({ data: { object: { sha: refSha } } }),
        getCommit: async () => ({ data: { tree: { sha: 'tree0' } } }),
        getTree: async () => ({
          data: { truncated, tree: [{ path: 'src/a.mjs', type: 'blob', mode, sha: 'blob0' }] },
        }),
        getBlob: async () => ({
          data: { content: Buffer.from(text).toString('base64'), encoding: 'base64' },
        }),
        createBlob: async (p) => {
          note('createBlob')(p);
          return { data: { sha: 'blob1' } };
        },
        createTree: async (p) => {
          note('createTree')(p);
          return { data: { sha: 'tree1' } };
        },
        createCommit: async (p) => {
          note('createCommit')(p);
          return { data: { sha: 'c'.repeat(40), html_url: 'https://example.test/commit/ccc' } };
        },
        updateRef: async (p) => {
          note('updateRef')(p);
          if (updateRefError) throw updateRefError;
          return { data: {} };
        },
      },
    },
  };
  return github;
}
const names = (github) => github.calls.map(([n]) => n);

test('a proposal is only accepted with the right shape, path and size', () => {
  assert.equal(proposalProblem(proposal(), { maxLines: 5 }), null);
  const bad = (extra) => proposalProblem(proposal(extra), { maxLines: 5 });
  assert.match(bad({ v: 2 }), /unknown format/);
  assert.match(bad({ baseSha: 'main' }), /baseSha/);
  assert.match(bad({ path: '.github/workflows/ci.yml' }), /path is not allowed/);
  assert.match(bad({ path: '/etc/passwd' }), /path is not allowed/);
  assert.match(bad({ path: 'src/../../x' }), /path is not allowed/);
  assert.match(bad({ replacement: ['a', 'b', 'c', 'd', 'e', 'f'] }), /more than 5 lines/);
  assert.match(bad({ replacement: 'text' }), /bad lines/);
  assert.match(bad({ replacement: [1] }), /bad lines/);
  assert.match(bad({ endLine: 9 }), /does not fit/);
  assert.match(bad({ startLine: 3, endLine: 2 }), /bad line range/);
  assert.match(bad({ prNumber: 'x' }), /prNumber/);
  assert.match(bad({ requestedBy: '' }), /requestedBy/);
  assert.match(proposalProblem(null, { maxLines: 5 }), /unknown format/);
  assert.match(proposalProblem('x', { maxLines: 5 }), /unknown format/);
});

test('the fix applies only if the original lines are still there, and keeps line endings', () => {
  assert.deepEqual(applyProposal(TEXT, proposal()), { ok: true, text: 'one\nTWO\nTHREE\nfour\n' });
  // no final newline stays without one
  assert.equal(applyProposal('one\ntwo\nthree', proposal()).text, 'one\nTWO\nTHREE');
  // CRLF stays CRLF
  assert.equal(
    applyProposal('one\r\ntwo\r\nthree\r\nfour\r\n', proposal()).text,
    'one\r\nTWO\r\nTHREE\r\nfour\r\n',
  );
  // the replacement can be longer or shorter than the original
  assert.equal(applyProposal(TEXT, proposal({ replacement: ['x'] })).text, 'one\nx\nfour\n');
  assert.deepEqual(applyProposal('one\ntwo\nCHANGED\nfour\n', proposal()), {
    ok: false,
    reason: 'the lines have changed since I looked at them',
  });
  assert.deepEqual(applyProposal('one\ntwo\n', proposal()), {
    ok: false,
    reason: 'the file is shorter now',
  });
});

test('the commit message names the finding, the thread and the person who asked', () => {
  const message = commitMessage(proposal(), 'lea <42+lea@users.noreply.github.com>');
  assert.equal(
    message,
    'BullyBot: fix src/a.mjs:2\n\nShouted at the lines.\n\n' +
      'BullyBot-Fix: T1\nCo-authored-by: lea <42+lea@users.noreply.github.com>',
  );
  // without a co-author there is no empty trailer
  assert.doesNotMatch(commitMessage(proposal(), null), /Co-authored-by/);
  // a model cannot smuggle in its own trailers
  const sneaky = commitMessage(
    proposal({ explanation: 'Fine.\nCo-authored-by: evil <e@example.com>\nBullyBot-Fix: T9' }),
    null,
  );
  assert.doesNotMatch(sneaky, /evil|T9/);
  assert.match(sneaky, /BullyBot-Fix: T1/);
});

test('forks, the default branch and protected branches are not pushed to', async () => {
  const check = (pr, extra) =>
    pushBlockedReason({ github: fakeGithub({ pr, ...extra }), owner: 'o', repo: 'r', pr });
  assert.equal(await check(sameRepoPr()), null);
  assert.match(
    await check(sameRepoPr({ head: { ref: 'x', sha: BASE, repo: { full_name: 'fork/r' } } })),
    /fork/,
  );
  assert.match(await check(sameRepoPr({ head: { ref: 'x', sha: BASE, repo: null } })), /fork/);
  assert.match(
    await check(sameRepoPr({ head: { ref: 'main', sha: BASE, repo: { full_name: 'o/r' } } })),
    /default branch/,
  );
  assert.match(await check(sameRepoPr(), { isProtected: true }), /protected/);
  const broken = fakeGithub();
  broken.rest.repos.getBranch = async () => {
    throw new Error('boom');
  };
  assert.match(
    await pushBlockedReason({ github: broken, owner: 'o', repo: 'r', pr: sameRepoPr() }),
    /could not look at the branch \(boom\)/,
  );
});

test('a thread gets one automatic fix, found through the marker in the commits', async () => {
  const find = (commits) =>
    hasAutoFix({
      github: fakeGithub({ commits }),
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      threadId: 'T1',
    });
  assert.equal(await find([]), false);
  assert.equal(await find(['feat: something']), false);
  assert.equal(await find(['BullyBot: fix a\n\nBullyBot-Fix: T2']), false);
  assert.equal(await find(['BullyBot: fix a\n\nBullyBot-Fix: T1\nCo-authored-by: x']), true);
});

test('per run, only the first request may become a proposal', async () => {
  const github = fakeGithub();
  const plan = await planPushes({ github, owner: 'o', repo: 'r', pr: sameRepoPr(), enabled: true });
  assert.deepEqual(await plan({ id: 'T1' }), { enabled: true, blockedReason: null });
  assert.deepEqual(await plan({ id: 'T2' }), {
    enabled: true,
    blockedReason: 'only one fix is pushed per run',
  });
});

test('planning: off stays off, a blocked pull request blocks every request, a fixed thread is skipped', async () => {
  const off = await planPushes({
    github: fakeGithub(),
    owner: 'o',
    repo: 'r',
    pr: sameRepoPr(),
    enabled: false,
  });
  assert.deepEqual(off({ id: 'T1' }), { enabled: false });

  const fork = await planPushes({
    github: fakeGithub(),
    owner: 'o',
    repo: 'r',
    pr: sameRepoPr({ head: { ref: 'x', sha: BASE, repo: { full_name: 'fork/r' } } }),
    enabled: true,
  });
  assert.match((await fork({ id: 'T1' })).blockedReason, /fork/);

  const fixed = await planPushes({
    github: fakeGithub({ commits: ['x\n\nBullyBot-Fix: T1'] }),
    owner: 'o',
    repo: 'r',
    pr: sameRepoPr(),
    enabled: true,
  });
  assert.match((await fixed({ id: 'T1' })).blockedReason, /already pushed/);
  // a thread that was not fixed yet can still be, and the slot is not used up by the skipped one
  assert.equal((await fixed({ id: 'T2' })).blockedReason, null);
});

test('pushing: the commit sits on the base commit, keeps the file mode and is not forced', async () => {
  const github = fakeGithub({ mode: '100755' });
  const result = await pushFix({ github, owner: 'o', repo: 'r', proposal: proposal() });
  assert.deepEqual(result, {
    status: 'pushed',
    sha: 'c'.repeat(40),
    url: 'https://example.test/commit/ccc',
  });
  assert.deepEqual(names(github), ['createBlob', 'createTree', 'createCommit', 'updateRef']);
  const get = (name) => github.calls.find(([n]) => n === name)[1];
  assert.equal(get('createBlob').content, 'one\nTWO\nTHREE\nfour\n');
  assert.deepEqual(get('createTree'), {
    owner: 'o',
    repo: 'r',
    base_tree: 'tree0',
    tree: [{ path: 'src/a.mjs', mode: '100755', type: 'blob', sha: 'blob1' }],
  });
  assert.deepEqual(get('createCommit').parents, [BASE]);
  assert.match(
    get('createCommit').message,
    /Co-authored-by: lea <42\+lea@users\.noreply\.github\.com>/,
  );
  assert.match(get('createCommit').message, /BullyBot-Fix: T1/);
  assert.deepEqual(get('updateRef'), {
    owner: 'o',
    repo: 'r',
    ref: 'heads/feat/x',
    sha: 'c'.repeat(40),
    force: false,
  });
});

test('pushing without a known co-author still works, there is just no trailer', async () => {
  const github = fakeGithub({ noUser: true });
  const result = await pushFix({ github, owner: 'o', repo: 'r', proposal: proposal() });
  assert.equal(result.status, 'pushed');
  assert.doesNotMatch(
    github.calls.find(([n]) => n === 'createCommit')[1].message,
    /Co-authored-by/,
  );
});

test('a branch that moved is not pushed to, before and while the commit is made', async () => {
  const before = fakeGithub({ refSha: 'b'.repeat(40) });
  assert.equal(
    (await pushFix({ github: before, owner: 'o', repo: 'r', proposal: proposal() })).status,
    'moved',
  );
  assert.deepEqual(names(before), []); // not even a blob was written

  const during = fakeGithub({
    updateRefError: Object.assign(new Error('not a fast forward'), { status: 422 }),
  });
  assert.equal(
    (await pushFix({ github: during, owner: 'o', repo: 'r', proposal: proposal() })).status,
    'moved',
  );
  assert.equal(names(during).filter((n) => n === 'updateRef').length, 1); // no second try
});

test('a refused push is reported with the reason, never thrown', async () => {
  const github = fakeGithub({
    updateRefError: Object.assign(new Error('Resource not accessible by integration'), {
      status: 403,
    }),
  });
  const result = await pushFix({ github, owner: 'o', repo: 'r', proposal: proposal() });
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /Resource not accessible by integration/);
});

test('files that cannot or should not be rewritten are refused', async () => {
  const run = (extra, p = proposal()) =>
    pushFix({ github: fakeGithub(extra), owner: 'o', repo: 'r', proposal: p });
  assert.equal((await run({ text: 'one\nCHANGED\nthree\nfour\n' })).status, 'does_not_apply');
  assert.match((await run({ mode: '120000' })).reason, /not a regular file/);
  assert.match((await run({ truncated: true })).reason, /too big/);
  assert.match(
    (await run({}, proposal({ path: 'src/missing.mjs' }))).reason,
    /not in the repository/,
  );
});

test('the end of a test log is shown without colors and cannot break out of its fence', () => {
  assert.equal(summarizeTestLog(''), '');
  assert.equal(summarizeTestLog(null), '');
  assert.equal(summarizeTestLog('\u001b[31mFAIL\u001b[0m a\r\nok\n'), '```\nFAIL a\nok\n```');
  const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const tail = summarizeTestLog(long);
  assert.match(tail, /line 99/);
  assert.doesNotMatch(tail, /line 10\b/);
  assert.match(summarizeTestLog('a ```` b'), /^`{5}\n/);
});

const finish = (github, extra = {}) =>
  finishFix({
    github,
    core: { info() {}, warning() {} },
    owner: 'o',
    repo: 'r',
    proposal: proposal(),
    testsResult: 'success',
    maxLines: 5,
    ...extra,
  });

test('green tests: the fix is pushed and the thread gets the commit', async () => {
  const github = fakeGithub();
  const result = await finish(github);
  assert.deepEqual(result, { status: 'pushed', sha: 'c'.repeat(40) });
  assert.equal(github.replies.length, 1);
  assert.ok(github.replies[0].startsWith(`${MARKER}${FIX_MARKER}`));
  assert.match(github.replies[0], /https:\/\/example\.test\/commit\/ccc/);
  assert.ok(names(github).includes('updateRef'));
});

test('failed or missing tests: nothing is pushed, the thread gets the log and the suggestion', async () => {
  for (const [testsResult, text] of [
    ['failure', /tests failed/],
    ['cancelled', /cancelled/],
    ['skipped', /did not run/],
    [undefined, /did not run/],
  ]) {
    const github = fakeGithub();
    const result = await finish(github, { testsResult, testLog: 'Error: boom\n  at x' });
    assert.equal(result.status, 'tests_failed');
    assert.deepEqual(names(github), []);
    assert.match(github.replies[0], text);
    assert.match(github.replies[0], /```suggestion\nTWO\nTHREE\n```/);
    // the log only for a failure, not for a run that never happened
    assert.equal(/Error: boom/.test(github.replies[0]), testsResult === 'failure');
  }
});

test('a fork, a protected branch or an earlier fix get the suggestion and the reason', async () => {
  const cases = [
    [{ pr: sameRepoPr({ head: { ref: 'x', sha: BASE, repo: { full_name: 'fork/r' } } }) }, /fork/],
    [{ isProtected: true }, /protected/],
    [{ commits: ['x\n\nBullyBot-Fix: T1'] }, /already pushed a fix/],
  ];
  for (const [extra, text] of cases) {
    const github = fakeGithub(extra);
    const result = await finish(github);
    assert.equal(result.status, 'blocked');
    assert.deepEqual(names(github), []);
    assert.match(github.replies[0], text);
    assert.match(github.replies[0], /```suggestion/);
  }
});

test('a moved branch, a refused push and a patch that no longer applies fall back to the suggestion', async () => {
  const moved = fakeGithub({ refSha: 'b'.repeat(40) });
  assert.equal((await finish(moved)).status, 'moved');
  assert.match(moved.replies[0], /moved while I was working/);
  assert.match(moved.replies[0], /```suggestion/);

  const refused = fakeGithub({ updateRefError: Object.assign(new Error('403'), { status: 403 }) });
  assert.equal((await finish(refused)).status, 'refused');
  assert.match(refused.replies[0], /did not push/);

  const stale = fakeGithub({ text: 'one\nCHANGED\nthree\nfour\n' });
  assert.equal((await finish(stale)).status, 'does_not_apply');
  assert.match(stale.replies[0], /have changed since/);
});

test('rights are checked again, a closed pull request is left alone, a bad proposal is not used', async () => {
  const noRights = fakeGithub({ role: 'read' });
  assert.equal((await finish(noRights)).status, 'no_rights');
  assert.deepEqual(names(noRights), []);
  assert.match(noRights.replies[0], /lost it/);

  const closed = fakeGithub({ pr: sameRepoPr({ state: 'closed' }) });
  assert.equal((await finish(closed)).status, 'closed');
  assert.deepEqual(closed.replies, []);

  const warnings = [];
  const github = fakeGithub();
  const invalid = await finishFix({
    github,
    core: { warning: (m) => warnings.push(m) },
    owner: 'o',
    repo: 'r',
    proposal: proposal({ path: '.github/workflows/ci.yml' }),
    testsResult: 'success',
    maxLines: 5,
  });
  assert.equal(invalid.status, 'invalid');
  assert.deepEqual([...names(github), ...github.replies], []);
  assert.match(warnings[0], /path is not allowed/);
});
