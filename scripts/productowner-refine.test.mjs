import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productOwnerRefine } from './productowner-refine.mjs';

const b64 = (s) => Buffer.from(s).toString('base64');

const GOOD = [
  '## Goal',
  'As a member, I want to vote on meeting times, so that we find a slot together.',
  '',
  '## Acceptance criteria',
  '- [ ] One vote per option',
  '- [ ] Votes can be changed',
  '- [ ] Results are shown live',
  '- [ ] Closed polls reject votes',
].join('\n');

/** Minimal stand-in for the octokit client of actions/github-script, with a log of all writes. */
function fakeGithub({ failComment = [], failCreate = [], boardDown = false } = {}) {
  const calls = [];
  const created = [];
  const requests = [];
  const listForRepo = async () => {};
  const listLabelsForRepo = async () => {};
  const listMilestones = async () => {};
  const files = { 'README.md': '# Panic Planner', 'package.json': '{"name":"x"}' };
  const issue = (number, extra = {}) => ({
    number,
    node_id: `N${number}`,
    title: `Issue ${number}`,
    state: 'open',
    body: GOOD,
    labels: [],
    milestone: null,
    ...extra,
  });
  return {
    calls,
    created,
    requests,
    graphql: async (q, vars) => {
      if (q.includes('addProjectV2ItemById')) {
        calls.push({ type: 'board-add', node: vars.content });
        return { addProjectV2ItemById: { item: { id: `item-${vars.content}` } } };
      }
      if (q.includes('updateProjectV2ItemFieldValue')) {
        calls.push({ type: 'board-set', item: vars.item, option: vars.option });
        return {};
      }
      if (q.includes('setIssueFieldValue')) {
        calls.push({ type: 'priority', issue: vars.issue, option: vars.option });
        return {};
      }
      if (q.includes('issueFieldValues')) {
        return {
          repository: {
            i1: { issueFieldValues: { nodes: [] } },
            i2: { issueFieldValues: { nodes: [{ name: 'High', field: { name: 'Priority' } }] } },
            i3: { issueFieldValues: { nodes: [] } },
            i4: { issueFieldValues: { nodes: [] } },
          },
        };
      }
      if (q.includes('items(first: 100')) {
        if (boardDown) return { organization: null };
        return {
          organization: {
            projectV2: {
              items: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  {
                    content: { number: 2, repository: { nameWithOwner: 'o/r' } },
                    size: { name: 'XL' },
                  },
                  { content: { number: 3, repository: { nameWithOwner: 'o/r' } }, size: null },
                  {
                    content: { number: 4, repository: { nameWithOwner: 'o/r' } },
                    size: { name: 'M' },
                  },
                ],
              },
            },
          },
        };
      }
      if (q.includes('projectV2')) {
        return {
          organization: {
            projectV2: {
              id: 'P1',
              fields: {
                nodes: [
                  { id: 'FS', name: 'Status', options: [{ id: 'sb', name: 'Backlog' }] },
                  {
                    id: 'FZ',
                    name: 'Size',
                    options: ['XS', 'S', 'M', 'L', 'XL'].map((n) => ({ id: `z${n}`, name: n })),
                  },
                ],
              },
            },
          },
        };
      }
      if (q.includes('issueFields')) {
        return {
          organization: {
            issueFields: {
              nodes: [
                {
                  id: 'PF',
                  name: 'Priority',
                  options: ['Urgent', 'High', 'Medium', 'Low'].map((n) => ({
                    id: `p${n}`,
                    name: n,
                  })),
                },
              ],
            },
          },
        };
      }
      throw new Error(`unexpected query ${q.slice(0, 40)}`);
    },
    paginate: async (fn) => {
      if (fn === listForRepo)
        return [
          issue(1, { title: 'Export calendar', body: '' }),
          issue(2, { title: 'Polls', labels: ['frontend'], milestone: { title: 'M2: Teams' } }),
          issue(3, {
            title: 'Make it nicer',
            body: 'Make the thing nicer please somehow\n- [ ] works',
          }),
          issue(4),
          issue(5, { labels: ['epic'], body: '' }),
          issue(9, { state: 'closed', body: '' }),
          { ...issue(7), pull_request: {} },
        ];
      if (fn === listLabelsForRepo) return [{ name: 'frontend' }, { name: 'epic' }];
      if (fn === listMilestones) return [{ number: 2, title: 'M2: Teams', description: '' }];
      throw new Error('unexpected paginate');
    },
    request: async (route, params) => {
      requests.push({ route, params });
      calls.push({ type: 'sub-issue', parent: params.issue_number });
    },
    rest: {
      issues: {
        listForRepo,
        listLabelsForRepo,
        listMilestones,
        createLabel: async (p) => calls.push({ type: 'label-create', name: p.name }),
        addLabels: async (p) =>
          calls.push({ type: 'label', issue: p.issue_number, labels: p.labels }),
        createComment: async (p) => {
          if (failComment.includes(p.issue_number)) throw new Error('comment failed');
          calls.push({ type: 'comment', issue: p.issue_number, body: p.body });
        },
        update: async (p) => calls.push({ type: 'update', issue: p.issue_number, body: p.body }),
        create: async (p) => {
          if (failCreate.includes(p.title)) throw new Error('nope');
          const n = 100 + created.length;
          created.push({ ...p, number: n });
          calls.push({ type: 'create', title: p.title });
          return { data: { number: n, id: n * 10, node_id: `N${n}` } };
        },
      },
      repos: {
        get: async () => ({ data: { default_branch: 'main' } }),
        listCommits: async () => ({ data: [{ commit: { message: 'feat: x' } }] }),
        getContent: async ({ path }) => {
          if (files[path] == null) throw new Error('404');
          return { data: { type: 'file', size: files[path].length, content: b64(files[path]) } };
        },
      },
      git: { getTree: async () => ({ data: { tree: [{ path: 'README.md', type: 'blob' }] } }) },
    },
  };
}

function fakeCore() {
  return {
    failed: null,
    warnings: [],
    infos: [],
    startGroup() {},
    endGroup() {},
    info(m) {
      this.infos.push(m);
    },
    warning(m) {
      this.warnings.push(m);
    },
    setFailed(m) {
      this.failed = m;
    },
    summary: {
      addRaw(text) {
        this.text = text;
        return this;
      },
      async write() {},
    },
  };
}

const context = { repo: { owner: 'o', repo: 'r' } };
const PROJECT_URL = 'https://github.com/orgs/o/projects/1';

const answers = {
  1: {
    assessment: 'refine',
    explanation: 'Wrote the missing goal and criteria.',
    goal: 'As a user, I want to export my calendar, so that I can share it.',
    criteria: ['A file is downloaded', 'An empty calendar shows a hint'],
    size: 'S',
    priority: 'Medium',
  },
  2: {
    assessment: 'refine',
    explanation: 'Too big for one pull request.',
    size: 'M',
    priority: 'Urgent',
    split: {
      reason: 'Voting and results are independent.',
      tickets: [
        {
          title: 'Cast votes',
          story: 'As a member, I want to vote.',
          covers: [1, 2, 4],
          size: 'S',
          priority: 'High',
        },
        {
          title: 'Show results',
          story: 'As a member, I want to see results.',
          covers: [3],
          size: 'S',
          priority: 'High',
        },
      ],
    },
  },
  3: {
    assessment: 'needs_info',
    explanation: 'Cannot tell what "nicer" means.',
    questions: ['Which screen is meant?'],
  },
  4: { assessment: 'ok', explanation: 'Looks good as it is.' },
};

/** The model: one answer per ticket, and the triage names #3 as vague. */
const askWith =
  (overrides = {}) =>
  async ({ schema, prompt }) => {
    if (schema.properties.vague) return { vague: [3] };
    const number = Number(prompt.match(/# Ticket to refine\n#(\d+)/)[1]);
    const answer = overrides[number] ?? answers[number];
    if (answer instanceof Error) throw answer;
    return answer;
  };

const run = (github, core, extra = {}) =>
  productOwnerRefine({
    github,
    projectGithub: github,
    context,
    core,
    projectUrl: PROJECT_URL,
    issue: 'scan',
    ask: askWith(),
    ...extra,
  });

test.beforeEach(() => {
  process.env.GEMINI_API_KEY = 'k';
});

test('a dry run scans, proposes and changes nothing', async () => {
  const github = fakeGithub();
  const core = fakeCore();
  const { outcomes } = await run(github, core, { dryRun: true });

  assert.deepEqual(
    outcomes.map((o) => [o.issue.number, o.result.action]),
    [
      [1, 'refine'],
      [2, 'refine'],
      [3, 'ask'],
    ],
  );
  assert.deepEqual(github.calls, []);
  assert.match(core.summary.text, /dry run, nothing was changed/);
  assert.match(
    core.summary.text,
    /\| #1 Export calendar \| no description, no acceptance criteria \|/,
  );
  assert.match(core.summary.text, /New text:/);
  assert.equal(core.failed, null);
});

test('size and priority are set only where they are empty', async () => {
  const outcomes = (await run(fakeGithub(), fakeCore(), { dryRun: true })).outcomes;
  const by = Object.fromEntries(outcomes.map((o) => [o.issue.number, o]));
  assert.deepEqual([by[1].size, by[1].priority], ['S', 'Medium']); // nothing set yet
  assert.deepEqual([by[2].size, by[2].priority], [null, null]); // XL and High are already there
});

test('a real run comments first, then edits the text, and sets size and priority', async () => {
  const github = fakeGithub();
  const core = fakeCore();
  await run(github, core, { dryRun: false, issue: '1' });

  assert.deepEqual(
    github.calls.map((c) => c.type),
    ['comment', 'update', 'board-add', 'board-set', 'board-set', 'priority'],
  );
  const update = github.calls.find((c) => c.type === 'update');
  assert.equal(
    update.body,
    '## Goal\nAs a user, I want to export my calendar, so that I can share it.\n\n## Acceptance criteria\n- [ ] A file is downloaded\n- [ ] An empty calendar shows a hint',
  );
  assert.match(github.calls[0].body, /Wrote the missing goal and criteria\./);
  assert.deepEqual(
    github.calls.filter((c) => c.type === 'board-set').map((c) => c.option),
    ['sb', 'zS'], // not on the board yet: Status Backlog and Size
  );
  assert.equal(github.calls.find((c) => c.type === 'priority').option, 'pMedium');
  assert.equal(core.failed, null);
});

test('a question posts a comment, labels the issue and leaves the text alone', async () => {
  const github = fakeGithub();
  await run(github, fakeCore(), { dryRun: false, issue: '3' });
  assert.deepEqual(
    github.calls.map((c) => c.type),
    ['label-create', 'comment', 'label'],
  );
  assert.match(github.calls[1].body, /Which screen is meant\?/);
  assert.deepEqual(github.calls[2].labels, ['needs-info']);
});

test('without apply a split is only proposed in a comment', async () => {
  const github = fakeGithub();
  const core = fakeCore();
  await run(github, core, { dryRun: false, issue: '2' });
  assert.deepEqual(github.created, []);
  const comments = github.calls.filter((c) => c.type === 'comment');
  assert.equal(comments.length, 2);
  assert.match(comments[1].body, /Nothing was created/);
  assert.match(comments[1].body, /\*\*Cast votes\*\*/);
  assert.equal(
    github.calls.some((c) => c.type === 'update'),
    false,
  );
});

test('with apply the split creates sub-issues that carry every criterion once', async () => {
  const github = fakeGithub();
  const core = fakeCore();
  await run(github, core, { dryRun: false, apply: true, issue: '2' });

  assert.deepEqual(
    github.created.map((c) => [c.title, c.milestone, c.labels]),
    [
      ['Cast votes', 2, ['frontend']],
      ['Show results', 2, ['frontend']],
    ],
  );
  assert.match(
    github.created[0].body,
    /- \[ \] One vote per option\n- \[ \] Votes can be changed\n- \[ \] Closed polls reject votes/,
  );
  assert.match(github.created[1].body, /- \[ \] Results are shown live/);
  assert.match(github.created[0].body, /Split off from #2\./);
  assert.deepEqual(
    github.requests.map((r) => r.params.issue_number),
    [2, 2], // linked as sub-issues of the original ticket
  );
  const board = github.calls.filter((c) => c.type === 'board-add').map((c) => c.node);
  assert.deepEqual(board, ['N100', 'N101']);
  const last = github.calls.filter((c) => c.type === 'comment').at(-1);
  assert.match(last.body, /\*\*#100 Cast votes\*\*/);
  assert.equal(core.failed, null);
});

test('a failing ticket does not stop the others, and all failing fails the job', async () => {
  let github = fakeGithub({ failComment: [1] });
  let core = fakeCore();
  await run(github, core, { dryRun: false });
  assert.equal(core.failed, null);
  assert.ok(core.warnings.some((w) => /#1 could not be refined: comment failed/.test(w)));
  assert.ok(github.calls.some((c) => c.type === 'label' && c.issue === 3));
  assert.equal(
    github.calls.some((c) => c.type === 'update'),
    false,
  ); // never edited without the comment

  github = fakeGithub({ failComment: [1, 2, 3] });
  core = fakeCore();
  await run(github, core, { dryRun: false });
  assert.equal(core.failed, 'No ticket could be refined.');
});

test('a model error for one ticket is reported and the others go on', async () => {
  const core = fakeCore();
  const { outcomes } = await run(fakeGithub(), core, {
    dryRun: true,
    ask: askWith({ 1: new Error('overloaded') }),
  });
  assert.deepEqual(
    outcomes.map((o) => [o.issue.number, o.status]),
    [
      [1, 'failed'],
      [2, 'proposed'],
      [3, 'proposed'],
    ],
  );
  assert.ok(core.warnings.some((w) => /#1 could not be refined: overloaded/.test(w)));
});

test('the cap limits how many tickets are looked at', async () => {
  const { outcomes } = await run(fakeGithub(), fakeCore(), { dryRun: true, maxIssues: 1 });
  assert.equal(outcomes.length, 1);
});

test('without board access nothing is set, and the report says why', async () => {
  const github = fakeGithub();
  const core = fakeCore();
  const { outcomes } = await run(github, core, { dryRun: true, projectGithub: null });
  assert.deepEqual([outcomes[0].size, outcomes[0].priority], [null, null]);
  assert.ok(core.warnings.some((w) => /No board access/.test(w)));
  // sizes are unknown, so #2 is no longer found by its size
  assert.equal(
    outcomes.some((o) => o.issue.number === 2),
    false,
  );
});

test('a board that cannot be read is a warning, not a crash', async () => {
  const core = fakeCore();
  const { outcomes } = await run(fakeGithub({ boardDown: true }), core, { dryRun: true });
  assert.ok(outcomes.length > 0);
  assert.ok(core.warnings.some((w) => /Project board not usable/.test(w)));
});

test('explicit issues must be open and not an epic, and the input must make sense', async () => {
  for (const [input, message] of [
    ['5', /epic/],
    ['9', /not an open issue/],
    ['7', /not an open issue/], // pull request
    ['404', /not an open issue/],
    ['everything', /neither an issue number nor "scan"/],
  ]) {
    const core = fakeCore();
    await run(fakeGithub(), core, { issue: input });
    assert.match(core.failed, message);
  }
});

test('an issue that is fine is left alone when asked for explicitly', async () => {
  const github = fakeGithub();
  const { outcomes } = await run(github, fakeCore(), { dryRun: false, issue: '4' });
  assert.equal(outcomes[0].result.action, 'none');
  assert.deepEqual(github.calls, []);
});

test('issue text cannot instruct the bot: it only reaches the model as fenced data', async () => {
  const prompts = [];
  await run(fakeGithub(), fakeCore(), {
    dryRun: true,
    issue: '3',
    ask: async ({ prompt }) => {
      prompts.push(prompt);
      return { assessment: 'ok', explanation: 'fine' };
    },
  });
  assert.match(prompts[0], /<<<TICKET\nMake the thing nicer please somehow/);
  assert.match(prompts[0], /TICKET>>>/);
});

test('a missing API key fails early', async () => {
  delete process.env.GEMINI_API_KEY;
  const core = fakeCore();
  await run(fakeGithub(), core, { ask: undefined });
  assert.match(core.failed, /GEMINI_API_KEY/);
});

test('a scan does not reword a well-formed ticket, an explicit request may', async () => {
  const rewrite = {
    assessment: 'refine',
    explanation: 'Reworded.',
    rewrittenBody:
      '## Goal\nVote on times.\n\n## Acceptance criteria\n- [ ] One vote per option\n- [ ] More',
  };
  // #2 is picked by the scan because of its size, not because of unclear wording
  const scan = await run(fakeGithub(), fakeCore(), { dryRun: true, ask: askWith({ 2: rewrite }) });
  const two = scan.outcomes.find((o) => o.issue.number === 2);
  assert.equal(two.result.newBody, null);
  assert.match(two.result.problems[0], /not picked for unclear wording/);

  const explicit = await run(fakeGithub(), fakeCore(), {
    dryRun: true,
    issue: '2',
    ask: askWith({ 2: rewrite }),
  });
  assert.equal(explicit.outcomes[0].result.rewritten, true);
});

test('the explanation is generated after the fields it describes', async () => {
  const { REFINE_SCHEMA } = await import('./productowner-refine.mjs');
  assert.equal(REFINE_SCHEMA.propertyOrdering.at(-1), 'explanation');
});
