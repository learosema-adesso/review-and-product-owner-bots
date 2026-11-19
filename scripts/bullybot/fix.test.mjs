import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIX_MARKER,
  checkSuggestion,
  clampFixMaxLines,
  handleFixRequest,
  isFixRequest,
  isFixRequestText,
  lineRange,
  mayAskForFix,
  renderSuggestion,
  splitLines,
} from './fix.mjs';
import { BOT_RESOLVED, MARKER } from './review.mjs';

test('"fix it" and "fix this" are requests, in any case and inside longer sentences', () => {
  for (const text of [
    'fix it',
    'Fix this',
    'FIX IT!',
    'yes, please fix it',
    'Good catch.\nCan you fix this?',
    'ok fix it now',
  ])
    assert.equal(isFixRequestText(text), true, text);
});

test('announcements, refusals and other talk are not requests', () => {
  for (const text of [
    "I'll fix it",
    'I will fix this later',
    "don't fix it",
    'please do not fix this',
    'fix it myself, thanks',
    "we'll fix it in the next PR",
    'I can fix it',
    'no need to fix this',
    "That's not a bug, here is why",
    'prefix it',
    'fixes it',
    '',
    null,
  ])
    assert.equal(isFixRequestText(text), false, String(text));
  // a later sentence can still be a request
  assert.equal(isFixRequestText("I'll fix it myself. Actually, fix it please"), true);
});

const comment = (body, extra = {}) => ({
  body,
  author: { login: 'lea', __typename: 'User' },
  ...extra,
});
const thread = (...comments) => ({
  id: 'T1',
  path: 'src/a.mjs',
  line: 10,
  startLine: null,
  isOutdated: false,
  isResolved: false,
  comments: {
    nodes: [
      comment(`${MARKER}\nfinding`, { author: { login: 'app', __typename: 'Bot' } }),
      ...comments,
    ],
  },
});

test('only an open thread with a human request as last word counts', () => {
  assert.equal(isFixRequest(thread(comment('fix it'))), true);
  assert.equal(
    isFixRequest(
      thread(
        comment('fix it'),
        comment(`${MARKER}${FIX_MARKER}\nhere`, { author: { login: 'app', __typename: 'Bot' } }),
      ),
    ),
    false,
  );
  assert.equal(
    isFixRequest(thread(comment('fix it', { author: { login: 'dependabot', __typename: 'Bot' } }))),
    false,
  );
  assert.equal(
    isFixRequest(
      thread(comment('fix it', { author: { login: 'renovate[bot]', __typename: 'User' } })),
    ),
    false,
  );
  assert.equal(isFixRequest(thread(comment(null))), false);
  assert.equal(isFixRequest(thread(comment(`${MARKER} fix it`))), false);
  assert.equal(isFixRequest({ ...thread(comment('fix it')), isResolved: true }), false);
  assert.equal(
    isFixRequest(thread(comment('fix it'), comment(`${MARKER}${BOT_RESOLVED}\nsettled`))),
    false,
  );
  assert.equal(isFixRequest(thread()), false);
});

test('write access is checked with the role of the person who asked', async () => {
  const github = (data) => ({
    rest: { repos: { getCollaboratorPermissionLevel: async () => ({ data }) } },
  });
  const check = (data, username = 'lea') =>
    mayAskForFix({ github: github(data), owner: 'o', repo: 'r', username });
  assert.equal(await check({ role_name: 'write', permission: 'write' }), true);
  assert.equal(await check({ role_name: 'maintain', permission: 'write' }), true);
  assert.equal(await check({ role_name: 'admin', permission: 'admin' }), true);
  assert.equal(await check({ role_name: 'read', permission: 'read' }), false);
  assert.equal(await check({ role_name: 'triage', permission: 'read' }), false);
  assert.equal(await check({ role_name: 'write' }, ''), false);
  const broken = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => {
          throw new Error('404');
        },
      },
    },
  };
  assert.equal(await mayAskForFix({ github: broken, owner: 'o', repo: 'r', username: 'x' }), false);
});

test('the lines of a finding: one line, a range, or none when the code moved on', () => {
  assert.deepEqual(lineRange({ line: 7 }), { start: 7, end: 7 });
  assert.deepEqual(lineRange({ line: 9, startLine: 5 }), { start: 5, end: 9 });
  assert.equal(lineRange({ line: 7, isOutdated: true }), null);
  assert.equal(lineRange({ line: null, originalLine: 7 }), null);
  assert.equal(lineRange({ line: 3, startLine: 5 }), null);
  assert.equal(lineRange({ line: 0 }), null);
  assert.equal(lineRange({ line: -2 }), null);
  assert.deepEqual(lineRange({ line: 4, startLine: 0 }), { start: 4, end: 4 });
  assert.deepEqual(lineRange({ line: 4, startLine: -3 }), { start: 4, end: 4 });
  assert.deepEqual(splitLines('a\r\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\n\nb'), ['a', '', 'b']);
});

test('a suggestion is checked before it is posted', () => {
  const base = { path: 'src/a.mjs', current: ['  x = 1;'], maxLines: 3 };
  assert.deepEqual(checkSuggestion({ ...base, replacement: ['  x = 2;'] }), {
    ok: true,
    lines: ['  x = 2;'],
  });
  assert.match(
    checkSuggestion({ ...base, replacement: ['  x = 1;'] }).reason,
    /would not change anything/,
  );
  assert.match(checkSuggestion({ ...base, replacement: [] }).reason, /empty/);
  assert.match(checkSuggestion({ ...base, replacement: ['', '  '] }).reason, /empty/);
  assert.match(checkSuggestion({ ...base, replacement: undefined }).reason, /empty/);
  assert.match(
    checkSuggestion({ ...base, replacement: ['a', 'b', 'c', 'd'] }).reason,
    /4 lines and my limit is 3/,
  );
  assert.match(
    checkSuggestion({ ...base, path: '.github/workflows/x.yml', replacement: ['y'] }).reason,
    /under \.github/,
  );
  assert.equal(clampFixMaxLines(undefined), 40);
  assert.equal(clampFixMaxLines('12'), 12);
  assert.equal(clampFixMaxLines('9999'), 200);
});

test('the suggestion fence cannot be broken out of', () => {
  const plain = renderSuggestion('Done.', ['a', 'b']);
  assert.equal(plain, `${MARKER}${FIX_MARKER}\nDone.\n\n\`\`\`suggestion\na\nb\n\`\`\``);
  const tricky = renderSuggestion('Done.', ['const s = "```";']);
  assert.match(tricky, /````suggestion\nconst s = "```";\n````$/);
});

// ---- the flow

const FILE = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');

function fakeGithub({ role = 'write', file = FILE, fail = false } = {}) {
  const replies = [];
  const reads = [];
  return {
    replies,
    reads,
    graphql: async (q, vars) => {
      replies.push(vars.body);
      return {};
    },
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => ({
          data: { role_name: role, permission: role },
        }),
        getContent: async (params) => {
          reads.push(params);
          if (fail) throw new Error('Not Found');
          return { data: { content: Buffer.from(file).toString('base64') } };
        },
      },
    },
  };
}
const pr = { head: { sha: 'abc', repo: { owner: { login: 'fork-owner' }, name: 'fork-repo' } } };
const run = (github, ask, t = thread(comment('fix it')), extra = {}) =>
  handleFixRequest({
    github,
    core: { info() {} },
    ask,
    persona: 'PERSONA',
    owner: 'o',
    repo: 'r',
    pr,
    thread: t,
    maxLines: 5,
    ...extra,
  });
const suggest = (lines) => async () => ({ decision: 'suggest', lines, explanation: 'Swapped it.' });

test('a request from someone with write access gets a suggestion for exactly the lines of the finding', async () => {
  const github = fakeGithub();
  let prompt;
  const result = await run(github, async (opts) => {
    prompt = opts;
    return { decision: 'suggest', lines: ['line 10 fixed'], explanation: 'Swapped it.' };
  });
  assert.deepEqual(result, { status: 'suggested' });
  assert.equal(github.replies.length, 1);
  assert.equal(
    github.replies[0],
    `${MARKER}${FIX_MARKER}\nSwapped it.\n\n\`\`\`suggestion\nline 10 fixed\n\`\`\``,
  );
  // read from the head of the PR, in the repository of the fork
  assert.deepEqual(github.reads[0], {
    owner: 'fork-owner',
    repo: 'fork-repo',
    path: 'src/a.mjs',
    ref: 'abc',
  });
  assert.match(prompt.prompt, /lines 10 to 10 of src\/a\.mjs/);
  assert.match(prompt.prompt, /Lines to replace:\n10: line 10$/);
  assert.match(prompt.prompt, /4: line 4\n/); // context before
  assert.match(prompt.system, /^PERSONA/);
});

test('a thread without comments is refused instead of crashing', async () => {
  const github = fakeGithub();
  const empty = { ...thread(), comments: { nodes: [] } };
  const result = await run(
    github,
    async () => {
      throw new Error('must not ask');
    },
    empty,
  );
  assert.equal(result.status, 'no_rights');
});

test('a comment without a body does not break the request', async () => {
  const github = fakeGithub();
  let prompt;
  const t = thread(comment(null), comment('fix it'));
  await run(
    github,
    async (opts) => {
      prompt = opts;
      return { decision: 'suggest', lines: ['x'], explanation: 'Done.' };
    },
    t,
  );
  assert.match(prompt.prompt, /Human \(lea\): \n\nHuman \(lea\): fix it/);
});

test('a range of lines is replaced as a whole', async () => {
  const github = fakeGithub();
  let prompt;
  await run(
    github,
    async (opts) => {
      prompt = opts;
      return { decision: 'suggest', lines: ['x', 'y'], explanation: 'Merged.' };
    },
    { ...thread(comment('fix it')), line: 12, startLine: 11 },
  );
  assert.match(prompt.prompt, /Lines to replace:\n11: line 11\n12: line 12$/);
});

test('someone without write access gets a refusal and the model is not asked', async () => {
  const github = fakeGithub({ role: 'read' });
  let asked = false;
  const result = await run(github, async () => {
    asked = true;
  });
  assert.equal(result.status, 'no_rights');
  assert.equal(asked, false);
  assert.match(github.replies[0], /Only people with write access/);
  assert.equal(github.reads.length, 0);
});

test('an outdated finding, a vanished line and an unreadable file are explained, not guessed', async () => {
  const never = async () => {
    throw new Error('must not ask');
  };
  let github = fakeGithub();
  assert.equal(
    (await run(github, never, { ...thread(comment('fix it')), isOutdated: true })).status,
    'outdated',
  );
  assert.match(github.replies[0], /code around this finding has changed/);

  github = fakeGithub({ file: 'one\ntwo' });
  assert.equal((await run(github, never)).status, 'outdated');

  github = fakeGithub({ fail: true });
  assert.equal((await run(github, never)).status, 'unreadable');
  assert.match(github.replies[0], /could not read src\/a\.mjs \(Not Found\)/);
});

test('files under .github are never suggested, and the model is not even asked', async () => {
  const github = fakeGithub();
  const result = await run(
    github,
    async () => {
      throw new Error('must not ask');
    },
    { ...thread(comment('fix it')), path: '.github/workflows/x.yml' },
  );
  assert.equal(result.status, 'protected');
  assert.equal(github.reads.length, 0);
});

test('a finding that needs more than the lines is too big, and nothing is suggested', async () => {
  const github = fakeGithub();
  const result = await run(github, async () => ({
    decision: 'too_big',
    lines: ['ignored'],
    explanation: 'It touches three files.',
  }));
  assert.equal(result.status, 'too_big');
  assert.match(
    github.replies[0],
    /^<!-- bullybot -->\nToo big for a suggestion\. It touches three files\.$/,
  );
  assert.equal(github.replies[0].includes('suggestion\n'), false);
});

test('a suggestion that fails the checks is refused with the reason', async () => {
  for (const [lines, reason] of [
    [['line 10'], /would not change anything/],
    [[], /empty/],
    [['a', 'b', 'c', 'd', 'e', 'f'], /6 lines and my limit is 5/],
  ]) {
    const github = fakeGithub();
    const result = await run(github, suggest(lines));
    assert.equal(result.status, 'refused');
    assert.match(github.replies[0], reason);
    assert.match(github.replies[0], /^<!-- bullybot -->\nI would rather not suggest this/);
  }
});

test('his own answer carries the fix marker, so the thread is not answered a second time', async () => {
  const github = fakeGithub();
  await run(github, suggest(['better']));
  const answered = thread(
    comment('fix it'),
    comment(github.replies[0], { author: { login: 'app', __typename: 'Bot' } }),
  );
  assert.equal(isFixRequest(answered), false);
  assert.ok(github.replies[0].includes(FIX_MARKER));
});

const pushPr = {
  number: 7,
  head: { sha: 'a'.repeat(40), ref: 'feat/x', repo: { owner: { login: 'o' }, name: 'r' } },
};

test('with push on, a fix that passes the checks becomes a proposal and nothing is posted', async () => {
  const github = fakeGithub();
  const result = await run(github, suggest(['line 10 fixed']), thread(comment('fix it')), {
    pr: pushPr,
    pushPlan: { enabled: true, blockedReason: null },
  });
  assert.equal(result.status, 'proposed');
  assert.deepEqual(result.proposal, {
    v: 1,
    threadId: 'T1',
    path: 'src/a.mjs',
    startLine: 10,
    endLine: 10,
    original: ['line 10'],
    replacement: ['line 10 fixed'],
    explanation: 'Swapped it.',
    baseSha: 'a'.repeat(40),
    headRef: 'feat/x',
    prNumber: 7,
    requestedBy: 'lea',
  });
  assert.deepEqual(github.replies, []);
});

test('with push on but not possible here, the suggestion is posted and says why', async () => {
  const github = fakeGithub();
  const result = await run(github, suggest(['line 10 fixed']), thread(comment('fix it')), {
    pr: pushPr,
    pushPlan: { enabled: true, blockedReason: 'the branch is protected' },
  });
  assert.equal(result.status, 'suggested');
  assert.match(github.replies[0], /```suggestion\nline 10 fixed\n```/);
  assert.match(github.replies[0], /I did not push it myself: the branch is protected\./);
});

test('with push on, the refusals before a proposal are the same as without', async () => {
  const plan = { enabled: true, blockedReason: null };
  const noRights = fakeGithub({ role: 'read' });
  assert.equal(
    (await run(noRights, suggest(['x']), thread(comment('fix it')), { pr: pushPr, pushPlan: plan }))
      .status,
    'no_rights',
  );
  const tooBig = fakeGithub();
  assert.equal(
    (
      await run(
        tooBig,
        async () => ({ decision: 'too_big', explanation: 'Needs another file.' }),
        thread(comment('fix it')),
        { pr: pushPr, pushPlan: plan },
      )
    ).status,
    'too_big',
  );
  const empty = fakeGithub();
  assert.equal(
    (await run(empty, suggest(['   ']), thread(comment('fix it')), { pr: pushPr, pushPlan: plan }))
      .status,
    'refused',
  );
  assert.equal(empty.replies.length, 1);
});
