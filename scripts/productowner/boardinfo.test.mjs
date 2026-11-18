import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPriorities, fetchSizes } from './boardinfo.mjs';

const ref = { kind: 'organization', login: 'o', number: 1 };

test('fetchSizes follows the pages and ignores items of other repositories', async () => {
  const pages = [
    {
      pageInfo: { hasNextPage: true, endCursor: 'c1' },
      nodes: [
        { content: { number: 1, repository: { nameWithOwner: 'o/r' } }, size: { name: 'M' } },
        { content: { number: 2, repository: { nameWithOwner: 'o/other' } }, size: { name: 'L' } },
      ],
    },
    {
      pageInfo: { hasNextPage: false },
      nodes: [
        { content: { number: 3, repository: { nameWithOwner: 'o/r' } }, size: null },
        { content: {}, size: null }, // draft item or pull request
        null,
      ],
    },
  ];
  const cursors = [];
  const github = {
    graphql: async (q, vars) => {
      cursors.push(vars.cursor);
      return { organization: { projectV2: { items: pages.shift() } } };
    },
  };
  const sizes = await fetchSizes({ github, ref, owner: 'o', repo: 'r' });
  assert.deepEqual(
    [...sizes],
    [
      [1, 'M'],
      [3, null],
    ],
  );
  assert.deepEqual(cursors, [null, 'c1']);
});

test('fetchSizes fails loudly when the board is not accessible', async () => {
  const github = { graphql: async () => ({ organization: null }) };
  await assert.rejects(
    fetchSizes({ github, ref, owner: 'o', repo: 'r' }),
    /not found or not accessible/,
  );
});

test('fetchPriorities reads the Priority field and ignores other issue fields', async () => {
  const queries = [];
  const github = {
    graphql: async (q) => {
      queries.push(q);
      return {
        repository: {
          i1: { issueFieldValues: { nodes: [{ name: 'High', field: { name: 'Priority' } }] } },
          i2: { issueFieldValues: { nodes: [{ name: 'Big', field: { name: 'Effort' } }] } },
          i3: { issueFieldValues: { nodes: [] } },
        },
      };
    },
  };
  const result = await fetchPriorities({ github, owner: 'o', repo: 'r', numbers: [1, 2, 3] });
  assert.deepEqual(
    [...result],
    [
      [1, 'High'],
      [2, null],
      [3, null],
    ],
  );
  assert.equal(queries.length, 1);
});

test('fetchPriorities asks in chunks', async () => {
  let calls = 0;
  const github = {
    graphql: async () => {
      calls++;
      return { repository: {} };
    },
  };
  await fetchPriorities({
    github,
    owner: 'o',
    repo: 'r',
    numbers: Array.from({ length: 45 }, (_, i) => i + 1),
  });
  assert.equal(calls, 3);
});
