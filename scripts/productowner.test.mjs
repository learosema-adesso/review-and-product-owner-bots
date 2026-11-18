import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productOwner, renderRunReport, renderPlanDetails } from './productowner.mjs';

const b64 = (s) => Buffer.from(s).toString('base64');

/** Minimal stand-in for the octokit client of actions/github-script. */
function fakeGithub({ failCreate = [], noPriorityField = false } = {}) {
  const created = [];
  const requests = [];
  const priorities = [];
  const listForRepo = async () => {};
  const listLabelsForRepo = async () => {};
  const listMilestones = async () => {};
  const files = {
    'README.md': '# Panic Planner',
    'package.json': '{"name":"x"}',
    'projects/frontend/src/app/app.ts': 'export class App {}',
    'projects/frontend/src/app/app.spec.ts': 'it("works")',
  };
  return {
    created,
    requests,
    priorities,
    graphql: async (q, vars) => {
      if (q.includes('organization(')) {
        return {
          organization: {
            issueFields: {
              nodes: noPriorityField
                ? []
                : [
                    {
                      id: 'PF',
                      name: 'Priority',
                      options: [
                        { id: 'u', name: 'Urgent' },
                        { id: 'h', name: 'High' },
                      ],
                    },
                  ],
            },
          },
        };
      }
      priorities.push(vars);
      return {};
    },
    paginate: async (fn) => {
      if (fn === listForRepo)
        return [
          {
            number: 81,
            title: 'Epic: Teams',
            state: 'open',
            body: 'goal',
            labels: [{ name: 'epic' }],
            milestone: null,
          },
          { number: 5, title: 'Sign in', state: 'closed', body: '', labels: [], milestone: null },
        ];
      if (fn === listLabelsForRepo) return [{ name: 'frontend' }, { name: 'epic' }];
      if (fn === listMilestones) return [{ number: 2, title: 'M2: Teams', description: '' }];
      throw new Error('unexpected paginate');
    },
    request: async (route, params) => requests.push({ route, params }),
    rest: {
      issues: {
        listForRepo,
        listLabelsForRepo,
        listMilestones,
        create: async (params) => {
          if (failCreate.includes(params.title)) throw new Error('nope');
          const n = 100 + created.length;
          created.push({ ...params, number: n });
          return { data: { number: n, id: n * 10, node_id: `N${n}` } };
        },
      },
      repos: {
        get: async () => ({ data: { default_branch: 'main' } }),
        listCommits: async () => ({ data: [{ commit: { message: 'feat: x\n\nbody' } }] }),
        getContent: async ({ path }) => {
          if (files[path] == null) throw new Error('404');
          return { data: { type: 'file', size: files[path].length, content: b64(files[path]) } };
        },
      },
      git: {
        getTree: async () => ({
          data: { tree: Object.keys(files).map((path) => ({ path, type: 'blob' })) },
        }),
      },
    },
  };
}

function fakeCore() {
  return {
    failed: null,
    warnings: [],
    infos: [],
    groups: [],
    startGroup(title) {
      this.groups.push(title);
    },
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
  };
}

const context = { repo: { owner: 'o', repo: 'r' } };
const answer = {
  summary: 'Voting it is.',
  epicNumber: 81,
  tickets: [
    {
      title: 'Vote on times',
      story: 'As a member, I want to vote.',
      criteria: ['One vote per option'],
      labels: ['frontend'],
      milestone: 'M2',
      size: 'S',
      priority: 'High',
    },
    { title: 'Sign in', story: 'dupe', criteria: ['x'], labels: [], size: 'S', priority: 'High' },
  ],
  skipped: [{ idea: 'Login', reason: 'exists (#5)' }],
};

test.beforeEach(() => {
  process.env.GEMINI_API_KEY = 'k';
  for (const name of ['LLM_PROVIDER', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_BASE_URL'])
    delete process.env[name];
});

test('creates tickets, links them to the epic and skips duplicates of existing issues', async () => {
  const github = fakeGithub();
  const core = fakeCore();
  const seen = {};
  const result = await productOwner({
    github,
    context,
    core,
    direction: 'voting',
    maxTickets: '3',
    ask: async (opts) => {
      seen.prompt = opts.prompt;
      return answer;
    },
  });

  assert.equal(core.failed, null);
  assert.match(seen.prompt, /Sign in/); // closed issues are part of the context
  assert.match(seen.prompt, /class App/); // and so is the source code
  assert.doesNotMatch(seen.prompt, /it\("works"\)/); // but not spec files
  assert.equal(github.created.length, 1);
  assert.deepEqual(github.created[0].labels, ['frontend']);
  assert.equal(github.created[0].milestone, 2);
  assert.match(github.created[0].body, /## Acceptance criteria\n- \[ \] One vote per option/);
  assert.equal(github.requests[0].params.issue_number, 81);
  assert.equal(github.requests[0].params.sub_issue_id, 1000);
  assert.deepEqual(
    result.plan.dropped.map((d) => d.reason),
    ['already exists as #5'],
  );
});

test('dry run creates nothing', async () => {
  const github = fakeGithub();
  const core = fakeCore();
  await productOwner({
    github,
    context,
    core,
    direction: 'x',
    dryRun: true,
    ask: async () => answer,
  });
  assert.equal(github.created.length, 0);
  assert.equal(github.requests.length, 0);
});

test('a new epic is created first and tickets are linked to it', async () => {
  const github = fakeGithub();
  const raw = { ...answer, epicNumber: 0, newEpicTitle: 'Voting', newEpicGoal: 'Decide together' };
  await productOwner({ github, context, core: fakeCore(), direction: 'x', ask: async () => raw });
  assert.deepEqual(
    github.created.map((c) => c.title),
    ['Epic: Voting', 'Vote on times'],
  );
  assert.deepEqual(github.created[0].labels, ['epic']);
  assert.equal(github.requests[0].params.issue_number, 100);
});

test('puts new issues on the board with status and size', async () => {
  const github = fakeGithub();
  const calls = [];
  const projectGithub = {
    graphql: async (q, vars) => {
      calls.push({ q, vars });
      if (q.includes('projectV2(number')) {
        return {
          user: {
            projectV2: {
              id: 'P',
              fields: {
                nodes: [
                  { id: 'S', name: 'Status', options: [{ id: 'b', name: 'Backlog' }] },
                  { id: 'Z', name: 'Size', options: [{ id: 's', name: 'S' }] },
                ],
              },
            },
          },
        };
      }
      return q.includes('addProjectV2ItemById')
        ? { addProjectV2ItemById: { item: { id: 'I' } } }
        : {};
    },
  };
  const core = fakeCore();
  await productOwner({
    github,
    projectGithub,
    context,
    core,
    direction: 'x',
    ask: async () => answer,
    projectUrl: 'https://github.com/users/lea/projects/1',
  });
  const updates = calls.filter((c) => c.vars.field).map((c) => c.vars.field);
  assert.deepEqual(updates, ['S', 'Z']);
  assert.deepEqual(core.warnings, []);
  assert.equal(core.failed, null);
});

test('without a project token tickets are still created and the gap is reported', async () => {
  const github = fakeGithub();
  const core = fakeCore();
  await productOwner({
    github,
    context,
    core,
    direction: 'x',
    ask: async () => answer,
    projectUrl: 'https://github.com/users/lea/projects/1',
  });
  assert.equal(github.created.length, 1);
  assert.ok(core.warnings.some((w) => /PROJECT_TOKEN/.test(w)));
  assert.equal(core.failed, null);
});

test('sets the organization Priority field on the new issues, with or without a board', async () => {
  const github = fakeGithub();
  await productOwner({
    github,
    context,
    core: fakeCore(),
    direction: 'x',
    ask: async () => answer,
  });
  assert.deepEqual(github.priorities, [{ issue: 'N100', field: 'PF', option: 'h' }]);
});

/** A board-token client that only knows the organization issue field. */
function boardClient({ fail = false } = {}) {
  const priorities = [];
  return {
    priorities,
    graphql: async (q, vars) => {
      if (fail) throw new Error('Resource not accessible by integration');
      if (q.includes('organization(')) {
        return {
          organization: {
            issueFields: {
              nodes: [{ id: 'PF', name: 'Priority', options: [{ id: 'h', name: 'High' }] }],
            },
          },
        };
      }
      priorities.push(vars);
      return {};
    },
  };
}

test('Priority is set with the board token when there is one', async () => {
  const github = fakeGithub({ noPriorityField: true }); // the workflow token could not do it
  const projectGithub = boardClient();
  const core = fakeCore();
  await productOwner({
    github,
    projectGithub,
    context,
    core,
    direction: 'x',
    ask: async () => answer,
  });
  assert.deepEqual(projectGithub.priorities, [{ issue: 'N100', field: 'PF', option: 'h' }]);
  assert.deepEqual(github.priorities, []);
  assert.ok(!core.warnings.some((w) => /Priority/.test(w)));
});

test('Priority falls back to the workflow token when the board token cannot do it', async () => {
  const github = fakeGithub();
  const core = fakeCore();
  await productOwner({
    github,
    projectGithub: boardClient({ fail: true }),
    context,
    core,
    direction: 'x',
    ask: async () => answer,
  });
  assert.deepEqual(github.priorities, [{ issue: 'N100', field: 'PF', option: 'h' }]);
  assert.ok(!core.warnings.some((w) => /Priority/.test(w)));
});

test('when no token can set Priority, one warning names every failure', async () => {
  const github = fakeGithub({ noPriorityField: true });
  const core = fakeCore();
  await productOwner({
    github,
    projectGithub: boardClient({ fail: true }),
    context,
    core,
    direction: 'x',
    ask: async () => answer,
  });
  const warnings = core.warnings.filter((w) => /Priority was not set/.test(w));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Resource not accessible by integration \| .*not found/);
});

test('a missing Priority field is reported once and does not stop the run', async () => {
  const github = fakeGithub({ noPriorityField: true });
  const core = fakeCore();
  await productOwner({ github, context, core, direction: 'x', ask: async () => answer });
  assert.equal(github.created.length, 1);
  assert.equal(core.warnings.filter((w) => /Priority was not set/.test(w)).length, 1);
  assert.equal(core.failed, null);
});

test('a priority the field has no option for is reported per issue', async () => {
  const github = fakeGithub();
  const core = fakeCore();
  const low = { ...answer, tickets: [{ ...answer.tickets[0], priority: 'Low' }] };
  await productOwner({ github, context, core, direction: 'x', ask: async () => low });
  assert.ok(core.warnings.some((w) => /#100: priority Low not set/.test(w)));
  assert.deepEqual(github.priorities, []);
});

test('without a project URL tickets are created and the missing board is reported', async () => {
  const github = fakeGithub();
  const core = fakeCore();
  const projectGithub = {
    graphql: async () => {
      throw new Error('must not be called');
    },
  };
  await productOwner({
    github,
    projectGithub,
    context,
    core,
    direction: 'x',
    ask: async () => answer,
  });
  assert.equal(github.created.length, 1);
  assert.ok(core.warnings.some((w) => /PROJECT_URL/.test(w)));
  assert.equal(core.failed, null);
});

test('one failing ticket does not stop the rest, but all failing fails the run', async () => {
  const two = { ...answer, tickets: [answer.tickets[0], { ...answer.tickets[0], title: 'Other' }] };
  const partial = fakeCore();
  await productOwner({
    github: fakeGithub({ failCreate: ['Other'] }),
    context,
    core: partial,
    direction: 'x',
    ask: async () => two,
  });
  assert.equal(partial.failed, null);
  assert.ok(partial.warnings.some((w) => /Other/.test(w)));

  const none = fakeCore();
  await productOwner({
    github: fakeGithub({ failCreate: ['Vote on times', 'Other'] }),
    context,
    core: none,
    direction: 'x',
    ask: async () => two,
  });
  assert.match(none.failed, /No ticket could be created/);
});

test('fails early without direction or API key', async () => {
  const noDirection = fakeCore();
  await productOwner({ github: fakeGithub(), context, core: noDirection, direction: '  ' });
  assert.match(noDirection.failed, /No direction/);

  delete process.env.GEMINI_API_KEY;
  const noKey = fakeCore();
  await productOwner({ github: fakeGithub(), context, core: noKey, direction: 'x' });
  assert.match(noKey.failed, /LLM_API_KEY/);
});

test('model failure fails the run without creating anything', async () => {
  const github = fakeGithub();
  const core = fakeCore();
  await productOwner({
    github,
    context,
    core,
    direction: 'x',
    ask: async () => {
      throw new Error('overloaded');
    },
  });
  assert.match(core.failed, /AI generation failed: overloaded/);
  assert.equal(github.created.length, 0);
});

test('renderRunReport shows tickets, skipped ideas and discarded drafts', () => {
  const plan = {
    summary: 'Hello.',
    epic: { existing: 81, title: 'Epic: Teams' },
    tickets: [
      { title: 'A | B', priority: 'High', size: 'S', milestone: { title: 'M2' }, criteria: ['x'] },
    ],
    skipped: [{ idea: 'Login', reason: 'exists' }],
    dropped: [{ title: 'Dupe', reason: 'duplicate' }],
  };
  const report = renderRunReport({
    direction: 'a\nb',
    plan,
    created: { tickets: [{ number: 7 }], problems: ['oops'] },
    dryRun: false,
  });
  assert.match(report, /> a\n> b/);
  assert.match(report, /existing #81/);
  assert.match(report, /\| #7 A \\\| B \| High \| S \| M2 \| 1 \|/);
  assert.match(report, /- Login: exists/);
  assert.match(report, /- Dupe: duplicate/);
  assert.match(report, /- oops/);
  assert.match(renderRunReport({ direction: 'x', plan, created: null, dryRun: true }), /dry run/);
});

test('the plan is printed to the job log, in full, even in a dry run', async () => {
  const core = fakeCore();
  await productOwner({
    github: fakeGithub(),
    context,
    core,
    direction: 'voting',
    dryRun: true,
    ask: async () => answer,
  });
  const log = core.infos.join('\n');
  assert.match(log, /dry run, nothing was created/);
  assert.match(log, /\*\*Not turned into tickets:\*\*\n- Login: exists \(#5\)/);
  assert.match(
    log,
    /### Vote on times\nPriority: High \| Size: S \| Milestone: M2: Teams \| Labels: frontend/,
  );
  assert.match(log, /- \[ \] One vote per option/);
  assert.deepEqual(core.groups, ['Raw answer of the model', 'Planned tickets in full']);
  assert.match(log, /"epicNumber": 81/);
});

test('a failing job summary is a warning, not a failure', async () => {
  const core = fakeCore();
  core.summary = {
    addRaw() {
      return this;
    },
    write: async () => {
      throw new Error('no summary file');
    },
  };
  await productOwner({
    github: fakeGithub(),
    context,
    core,
    direction: 'x',
    dryRun: true,
    ask: async () => answer,
  });
  assert.ok(core.warnings.some((w) => /Writing the job summary failed: no summary file/.test(w)));
  assert.equal(core.failed, null);
});

test('renderPlanDetails is empty without tickets', () => {
  assert.equal(renderPlanDetails({ tickets: [] }), '');
});

test('the model must do the overlap check first, and a duplicate overlap discards the ticket', async () => {
  const core = fakeCore();
  let schema;
  const duplicate = {
    ...answer,
    tickets: [
      {
        ...answer.tickets[0],
        overlaps: [{ number: 81, relation: 'duplicate', why: 'the epic already covers it' }],
      },
    ],
  };
  const result = await productOwner({
    github: fakeGithub(),
    context,
    core,
    direction: 'x',
    dryRun: true,
    ask: async (opts) => {
      schema = opts.schema.properties.tickets.items;
      return duplicate;
    },
  });
  assert.equal(schema.propertyOrdering[0], 'overlaps');
  assert.ok(schema.required.includes('overlaps'));
  assert.deepEqual(result.plan.tickets, []);
  assert.deepEqual(result.plan.dropped, [
    { title: 'Vote on times', reason: 'duplicate of #81: the epic already covers it' },
  ]);
  assert.match(core.infos.join('\n'), /Discarded drafts:\*\*\n- Vote on times: duplicate of #81/);
});

test('the prompt defines "covered" and does not accept indirect possibilities as coverage', async () => {
  let system;
  await productOwner({
    github: fakeGithub(),
    context,
    core: fakeCore(),
    direction: 'x',
    dryRun: true,
    ask: async (opts) => {
      system = opts.system;
      return answer;
    },
  });
  assert.match(system, /Never create a ticket for something that already exists/);
  assert.match(
    system,
    /only if an existing issue or the code delivers the behavior as a feature of its own/,
  );
  assert.match(system, /merely possible indirectly/);
  assert.match(system, /NOT covered/);
  assert.match(system, /relation "extends"/);
  assert.match(system, /says which part of it delivers the behavior/);
});
