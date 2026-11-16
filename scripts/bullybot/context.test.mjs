import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueRefs, fitSections, gatherContext } from './context.mjs';

test('issueRefs finds issue references but ignores URL fragments, entities and ##', () => {
  assert.deepEqual(issueRefs('Closes #5, part of #12.\n#7 first'), [5, 12, 7]);
  assert.deepEqual(issueRefs('see page.html#3 and &#39; and ##4'), []);
  assert.deepEqual(issueRefs(null), []);
});

test('fitSections keeps priority order, truncates per section and skips empty ones', () => {
  const out = fitSections(
    [
      { title: 'A', text: 'a'.repeat(500), max: 300 },
      { title: 'Empty', text: '  ' },
      { title: 'B', text: 'b'.repeat(250) },
    ],
    10_000,
  );
  assert.match(out, /^## A\na{300}\n… \(truncated\)\n\n## B\nb{250}$/);
});

test('fitSections marks sections that no longer fit into the budget', () => {
  const out = fitSections(
    [
      { title: 'A', text: 'a'.repeat(900) },
      { title: 'B', text: 'b'.repeat(900) },
    ],
    1000,
  );
  assert.match(out, /## A\na+/);
  assert.match(out, /## B\n\(omitted: context budget exhausted\)/);
});

/** Minimal stand-in for the octokit client of actions/github-script. */
function fakeGithub({ files, closing = [], issues = {}, failGraphql = false }) {
  const b64 = (s) => Buffer.from(s).toString('base64');
  const listFiles = async () => {};
  const listCommits = async () => {};
  return {
    graphql: async () => {
      if (failGraphql) throw new Error('boom');
      return { repository: { pullRequest: { closingIssuesReferences: { nodes: closing } } } };
    },
    paginate: async (fn) => {
      if (fn === listFiles)
        return Object.keys(files).map((filename) => ({
          filename,
          status: files[filename] === null ? 'removed' : 'modified',
          additions: 1,
          deletions: 0,
        }));
      if (fn === listCommits) return [{ commit: { message: 'feat: add nav\n\nbody' } }];
      throw new Error('unexpected paginate');
    },
    rest: {
      pulls: { listFiles, listCommits },
      issues: {
        get: async ({ issue_number }) => {
          if (!issues[issue_number]) throw new Error('404');
          return { data: issues[issue_number] };
        },
      },
      git: {
        getTree: async () => ({
          data: {
            tree: [...Object.keys(files), 'src/nav.spec.ts', 'package-lock.json'].map((path) => ({
              path,
              type: 'blob',
            })),
          },
        }),
      },
      repos: {
        getContent: async ({ path, ref }) => {
          const all = {
            ...files,
            'src/nav.spec.ts': 'it("navigates")',
            'package.json': '{"name":"x"}',
            'CONTRIBUTING.md': `rules@${ref}`,
          };
          if (all[path] == null) throw new Error('404');
          return { data: { type: 'file', size: all[path].length, content: b64(all[path]) } };
        },
      },
    },
  };
}

const PR = {
  number: 20,
  title: 'Calendar navigation',
  body: 'Closes #5\nAlso related to #6 and #20 and #404 and #21',
  user: { login: 'lea' },
  head: { sha: 'HEAD', ref: 'feat/nav' },
  base: { sha: 'BASE', ref: 'main' },
};
const core = {
  warnings: [],
  warning(m) {
    this.warnings.push(m);
  },
};

test('gatherContext collects issues, files, related tests and guidelines from the right refs', async () => {
  const github = fakeGithub({
    files: { 'src/nav.ts': 'export const nav = 1;', 'src/old.ts': null, 'package-lock.json': '{}' },
    closing: [{ number: 5, title: 'Nav', body: '- [ ] a', parent: { number: 1, title: 'Epic' } }],
    issues: {
      6: { title: 'Layout', body: '- [ ] b', state: 'open' },
      21: { title: 'A PR', body: '', state: 'open', pull_request: {} },
    },
  });
  const ctx = await gatherContext({ github, owner: 'o', repo: 'r', pr: PR, core });

  assert.deepEqual(
    ctx.linkedIssues.map((i) => i.number),
    [5, 6],
  );
  assert.equal(ctx.linkedIssues[0].parent.title, 'Epic');
  assert.match(ctx.sections.pr, /Branch: feat\/nav -> main/);
  assert.equal(ctx.sections.commits, '- feat: add nav');
  assert.match(ctx.sections.fullFiles, /### src\/nav\.ts\n```\nexport const nav = 1;/);
  assert.doesNotMatch(ctx.sections.fullFiles, /old\.ts|package-lock/);
  assert.match(ctx.sections.relatedTests, /src\/nav\.spec\.ts/);
  assert.match(ctx.sections.guidelines, /rules@BASE/);
  assert.match(ctx.sections.changedFiles, /- removed: src\/old\.ts/);
  assert.doesNotMatch(ctx.sections.tree, /package-lock/);
});

test('gatherContext falls back to issues mentioned in the PR body when GraphQL fails', async () => {
  core.warnings = [];
  const github = fakeGithub({
    files: { 'a.ts': 'x' },
    failGraphql: true,
    issues: { 5: { title: 'Nav', body: '', state: 'open' } },
  });
  const ctx = await gatherContext({ github, owner: 'o', repo: 'r', pr: PR, core });
  assert.deepEqual(
    ctx.linkedIssues.map((i) => i.number),
    [5],
  );
  assert.match(core.warnings[0], /closing issue references/);
});
