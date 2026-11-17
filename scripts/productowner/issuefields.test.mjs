import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadIssueField, setIssueFieldOption } from './issuefields.mjs';

const priority = { id: 'F', name: 'Priority', options: [{ id: 'o1', name: 'Urgent' }] };

test('loadIssueField finds a single-select field case-insensitively', async () => {
  const github = {
    graphql: async (_q, vars) => {
      assert.equal(vars.org, 'acme');
      return { organization: { issueFields: { nodes: [{}, null, priority] } } };
    },
  };
  assert.equal(await loadIssueField({ github, org: 'acme', name: 'priority' }), priority);
});

test('loadIssueField fails loudly when the field is missing or the owner is no organization', async () => {
  const none = { graphql: async () => ({ organization: { issueFields: { nodes: [] } } }) };
  await assert.rejects(
    loadIssueField({ github: none, org: 'acme', name: 'Priority' }),
    /not found/,
  );
  const user = { graphql: async () => ({ organization: null }) };
  await assert.rejects(loadIssueField({ github: user, org: 'me', name: 'Priority' }), /not found/);
  // an incomplete answer gives the same descriptive error, not a TypeError
  for (const organization of [{ issueFields: null }, { issueFields: {} }, {}]) {
    const github = { graphql: async () => ({ organization }) };
    await assert.rejects(loadIssueField({ github, org: 'acme', name: 'Priority' }), /not found/);
  }
});

test('setIssueFieldOption sends the option id and rejects unknown options', async () => {
  const calls = [];
  const github = { graphql: async (_q, vars) => calls.push(vars) };
  await setIssueFieldOption({ github, issueNodeId: 'I', field: priority, optionName: 'urgent' });
  assert.deepEqual(calls, [{ issue: 'I', field: 'F', option: 'o1' }]);
  await assert.rejects(
    setIssueFieldOption({ github, issueNodeId: 'I', field: priority, optionName: 'Soon' }),
    /no option "Soon"/,
  );
  assert.equal(calls.length, 1);
});
