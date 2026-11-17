import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProjectUrl, findOption, loadProject, addToProject } from './project.mjs';

const project = {
  id: 'P',
  fields: [
    {
      id: 'F1',
      name: 'Status',
      options: [
        { id: 'o1', name: 'Backlog' },
        { id: 'o2', name: 'Ready' },
      ],
    },
    { id: 'F2', name: 'Size', options: [{ id: 'o3', name: 'M' }] },
  ],
};

test('parseProjectUrl understands user and organization boards', () => {
  assert.deepEqual(parseProjectUrl('https://github.com/users/lea/projects/1'), {
    kind: 'user',
    login: 'lea',
    number: 1,
  });
  assert.deepEqual(parseProjectUrl('https://github.com/orgs/acme/projects/12/views/3'), {
    kind: 'organization',
    login: 'acme',
    number: 12,
  });
  assert.equal(parseProjectUrl('https://github.com/acme/repo'), null);
  assert.equal(parseProjectUrl(undefined), null);
});

test('findOption matches field and option case-insensitively', () => {
  assert.deepEqual(findOption(project, 'status', 'backlog'), { fieldId: 'F1', optionId: 'o1' });
  assert.equal(findOption(project, 'Status', 'Nope'), null);
  assert.equal(findOption(project, 'Priority', 'P1'), null);
  assert.equal(findOption(project, 'Status', null), null);
});

test('loadProject queries the right owner kind and fails loudly if the board is missing', async () => {
  let query;
  const github = {
    graphql: async (q) => {
      query = q;
      return {
        user: {
          projectV2: { id: 'P', fields: { nodes: [{}, { id: 'F', name: 'Status', options: [] }] } },
        },
      };
    },
  };
  const loaded = await loadProject({ github, ref: { kind: 'user', login: 'lea', number: 1 } });
  assert.match(query, /user\(login: \$login\)/);
  assert.deepEqual(
    loaded.fields.map((f) => f.id),
    ['F'],
  );

  const empty = { graphql: async () => ({ user: null }) };
  await assert.rejects(
    loadProject({ github: empty, ref: { kind: 'user', login: 'x', number: 9 } }),
    /not found/,
  );
});

test('addToProject sets known fields and reports unknown options', async () => {
  const calls = [];
  const github = {
    graphql: async (q, vars) => {
      calls.push(vars);
      return q.includes('addProjectV2ItemById')
        ? { addProjectV2ItemById: { item: { id: 'I' } } }
        : {};
    },
  };
  const out = await addToProject({
    github,
    project,
    nodeId: 'N',
    values: { Status: 'Backlog', Priority: 'P1', Size: null },
  });
  assert.deepEqual(out, { itemId: 'I', skipped: ['Priority=P1'] });
  assert.equal(calls.length, 2); // add + Status only
  assert.deepEqual(calls[1], { project: 'P', item: 'I', field: 'F1', option: 'o1' });
});
