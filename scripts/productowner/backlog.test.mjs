import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchBacklog, formatBacklog, formatMilestones } from './backlog.mjs';

test('fetchBacklog drops pull requests and flattens labels and milestones', async () => {
  const listForRepo = async () => {};
  const github = {
    rest: { issues: { listForRepo } },
    paginate: async (fn, opts) => {
      assert.equal(fn, listForRepo);
      assert.equal(opts.state, 'all');
      return [
        {
          number: 1,
          title: 'A',
          state: 'open',
          body: null,
          labels: [{ name: 'epic' }, 'qa'],
          milestone: { title: 'M1' },
        },
        { number: 2, title: 'PR', state: 'open', labels: [], pull_request: {} },
      ];
    },
  };
  assert.deepEqual(await fetchBacklog({ github, owner: 'o', repo: 'r' }), [
    { number: 1, title: 'A', state: 'open', body: '', labels: ['epic', 'qa'], milestone: 'M1' },
  ]);
});

test('formatBacklog previews open issues and lists closed ones as titles only', () => {
  const { open, closed } = formatBacklog([
    {
      number: 1,
      title: 'Open one',
      state: 'open',
      body: 'line one\n\nline   two',
      labels: ['qa'],
      milestone: 'M1',
    },
    { number: 2, title: 'Open empty', state: 'open', body: '', labels: [], milestone: null },
    {
      number: 3,
      title: 'Done',
      state: 'closed',
      body: 'secret details',
      labels: [],
      milestone: null,
    },
  ]);
  assert.equal(
    open,
    '#1 Open one [qa, M1]\n  line one line two\n#2 Open empty\n  (no description)',
  );
  assert.equal(closed, '#3 Done');
});

test('formatMilestones shows descriptions when present', () => {
  assert.equal(
    formatMilestones([
      { title: 'M1', description: 'MVP' },
      { title: 'M2', description: '' },
    ]),
    '- M1: MVP\n- M2',
  );
});
