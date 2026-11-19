import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bullybotFix } from './bullybot-fix.mjs';

const context = { repo: { owner: 'o', repo: 'r' } };
const proposal = {
  v: 1,
  threadId: 'T1',
  path: 'src/a.mjs',
  startLine: 1,
  endLine: 1,
  original: ['a'],
  replacement: ['b'],
  explanation: 'Changed it.',
  baseSha: 'a'.repeat(40),
  headRef: 'feat/x',
  prNumber: 7,
  requestedBy: 'lea',
};

function setup(prState = 'closed') {
  const messages = [];
  return {
    messages,
    core: { info: (m) => messages.push(m), warning: (m) => messages.push(`warning: ${m}`) },
    github: {
      graphql: async () => ({}),
      rest: { pulls: { get: async () => ({ data: { state: prState } }) } },
    },
  };
}

test('text that is not a proposal is ignored with a warning', async () => {
  for (const text of ['', 'not json', undefined]) {
    const { github, core, messages } = setup();
    const result = await bullybotFix({
      github,
      context,
      core,
      proposal: text,
      testsResult: 'success',
    });
    assert.deepEqual(result, { status: 'invalid' });
    assert.match(messages[0], /warning: There is no usable fix proposal/);
  }
});

test('a proposal is handed over to the logic with the limit of the repository', async () => {
  const { github, core } = setup('closed');
  const ok = await bullybotFix({
    github,
    context,
    core,
    proposal: JSON.stringify(proposal),
    testsResult: 'success',
  });
  assert.deepEqual(ok, { status: 'closed' }); // it got as far as looking at the pull request

  // a replacement longer than the limit is refused before anything is looked at
  const long = { ...proposal, replacement: Array.from({ length: 6 }, () => 'x') };
  const refused = await bullybotFix({
    github,
    context,
    core,
    proposal: JSON.stringify(long),
    testsResult: 'success',
    fixMaxLines: '5',
  });
  assert.equal(refused.status, 'invalid');
});
