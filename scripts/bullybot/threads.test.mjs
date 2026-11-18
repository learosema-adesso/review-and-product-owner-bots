import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESOLVE_FAILED_NOTE, answerThread, resolveInstruction } from './threads.mjs';
import { BOT_RESOLVED, MARKER, isSettledByBot, awaitsReply } from './review.mjs';

/** Fake client: records the mutations, the resolve mutation can be made to fail. */
function fakeGithub({ resolve = 'ok' } = {}) {
  const calls = [];
  return {
    calls,
    graphql: async (query, vars) => {
      if (query.includes('resolveReviewThread')) {
        calls.push({ type: 'resolve', threadId: vars.threadId });
        if (resolve === 'denied') throw new Error('Resource not accessible by integration');
        return {
          resolveReviewThread: { thread: { id: vars.threadId, isResolved: resolve === 'ok' } },
        };
      }
      calls.push({ type: 'reply', threadId: vars.threadId, body: vars.body });
      return { addPullRequestReviewThreadReply: { comment: { id: 'c' } } };
    },
  };
}
const core = () => ({
  warnings: [],
  warning(m) {
    this.warnings.push(m);
  },
});
const thread = { id: 'T1' };

test('with the app token a fixed thread is answered and then resolved', async () => {
  const github = fakeGithub();
  const result = await answerThread({
    github,
    core: core(),
    thread,
    verdict: 'fixed',
    reply: 'Fine, fixed.',
    canResolve: true,
  });
  assert.deepEqual(result, { settle: true, resolved: true });
  assert.deepEqual(
    github.calls.map((c) => c.type),
    ['reply', 'resolve'],
  );
  assert.equal(github.calls[1].threadId, 'T1');
  // no "settled" marker: a human who reopens the thread and replies gets an answer again
  assert.equal(github.calls[0].body, `${MARKER}\nFine, fixed.`);
  assert.equal(isSettledByBot({ comments: { nodes: [{ body: github.calls[0].body }] } }), false);
});

test('a conceded finding is resolved as well', async () => {
  const github = fakeGithub();
  const result = await answerThread({
    github,
    core: core(),
    thread,
    verdict: 'dispute_accepted',
    reply: 'I was wrong.',
    canResolve: true,
  });
  assert.equal(result.resolved, true);
});

test('a thread that is still open is only answered, never resolved', async () => {
  const github = fakeGithub();
  const result = await answerThread({
    github,
    core: core(),
    thread,
    verdict: 'still_open',
    reply: 'Nope.',
    canResolve: true,
  });
  assert.deepEqual(result, { settle: false, resolved: false });
  assert.deepEqual(
    github.calls.map((c) => c.type),
    ['reply'],
  );
  assert.equal(github.calls[0].body, `${MARKER}\nNope.`);
});

test('with the workflow token the thread is marked as settled and left to the human', async () => {
  const github = fakeGithub();
  const result = await answerThread({
    github,
    core: core(),
    thread,
    verdict: 'fixed',
    reply: 'Click Resolve.',
    canResolve: false,
  });
  assert.deepEqual(result, { settle: true, resolved: false });
  assert.deepEqual(
    github.calls.map((c) => c.type),
    ['reply'],
  ); // no attempt at all
  assert.equal(github.calls[0].body, `${MARKER}${BOT_RESOLVED}\nClick Resolve.`);
});

test('if resolving fails, he says so, marks the thread as settled and asks the human', async () => {
  for (const resolve of ['denied', 'not-resolved']) {
    const github = fakeGithub({ resolve });
    const log = core();
    const result = await answerThread({
      github,
      core: log,
      thread,
      verdict: 'fixed',
      reply: 'Closing this one.',
      canResolve: true,
    });
    assert.deepEqual(result, { settle: true, resolved: false });
    assert.deepEqual(
      github.calls.map((c) => c.type),
      ['reply', 'resolve', 'reply'],
    );
    assert.equal(github.calls[2].body, `${MARKER}${BOT_RESOLVED}\n${RESOLVE_FAILED_NOTE}`);
    assert.match(log.warnings[0], /Thread T1 could not be resolved/);
    // the second comment settles the thread: it is not judged again
    const nodes = [
      { body: `${MARKER}\nf` },
      { body: github.calls[0].body },
      { body: github.calls[2].body },
    ];
    assert.equal(isSettledByBot({ comments: { nodes } }), true);
    assert.equal(awaitsReply({ isResolved: false, comments: { nodes } }), false);
  }
});

test('the prompt only asks the human to resolve when he cannot do it himself', () => {
  assert.match(resolveInstruction(false), /telling the human to resolve the thread themselves/);
  assert.match(resolveInstruction(false), /Never claim you resolved it/);
  assert.match(resolveInstruction(true), /you close the thread yourself/);
  assert.doesNotMatch(resolveInstruction(true), /click Resolve|telling the human/);
});
