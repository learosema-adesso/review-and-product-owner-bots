import { isNoise, isTestFile, findRelatedTests } from './diff.mjs';

const MAX_LINKED_ISSUES = 5;
const MAX_FILE_BYTES = 60_000;
const MAX_TREE_PATHS = 1500;

/** Project rules BullyBot should know. Read from the base branch so a PR cannot rewrite them. */
const GUIDELINE_FILES = [
  '.github/bullybot.md',
  'CONTRIBUTING.md',
  'CLAUDE.md',
  'AGENTS.md',
  '.github/copilot-instructions.md',
];

/** Issue references like "#12" in a text (ignoring URL fragments and HTML entities). */
export const issueRefs = (text) =>
  [...(text ?? '').matchAll(/(?:^|[^\w&/#])#(\d+)\b/g)].map((m) => Number(m[1]));

/**
 * Concatenates sections in priority order until the character budget is used up.
 * Each section also has its own maximum so one huge section cannot crowd out the rest.
 */
export function fitSections(sections, budget) {
  let remaining = budget;
  const out = [];
  for (const { title, text, max = Infinity } of sections) {
    if (!text?.trim()) continue;
    const room = Math.min(max, remaining - title.length - 10);
    if (room < 200) {
      out.push(`## ${title}\n(omitted: context budget exhausted)`);
      continue;
    }
    const body = text.length > room ? `${text.slice(0, room)}\n… (truncated)` : text;
    out.push(`## ${title}\n${body}`);
    remaining -= body.length + title.length + 10;
  }
  return out.join('\n\n');
}

async function fetchText({ github, owner, repo, path, ref }) {
  try {
    const { data } = await github.rest.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || data.type !== 'file' || data.size > MAX_FILE_BYTES || !data.content)
      return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch {
    return null; // file does not exist (anymore) on this ref
  }
}

const fileBlock = (path, text) => `### ${path}\n\`\`\`\n${text}\n\`\`\``;

async function fetchLinkedIssues({ github, owner, repo, pr, core }) {
  const issues = new Map();
  try {
    const data = await github.graphql(
      `query($owner: String!, $repo: String!, $prNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $prNumber) {
            closingIssuesReferences(first: ${MAX_LINKED_ISSUES}) {
              nodes { number title body state parent { number title } }
            }
          }
        }
      }`,
      { owner, repo, prNumber: pr.number },
    );
    for (const i of data.repository.pullRequest.closingIssuesReferences.nodes)
      issues.set(i.number, i);
  } catch (error) {
    core.warning(`Failed to load closing issue references: ${error.message}`);
  }

  // Fallback: issues mentioned in the PR text ("Part of #12"), stop once we have enough
  for (const number of issueRefs(`${pr.title}\n${pr.body}`)) {
    if (issues.size >= MAX_LINKED_ISSUES) break;
    if (issues.has(number) || number === pr.number) continue;
    try {
      const { data } = await github.rest.issues.get({ owner, repo, issue_number: number });
      if (!data.pull_request)
        issues.set(number, {
          number,
          title: data.title,
          body: data.body,
          state: data.state.toUpperCase(),
        });
    } catch {
      // dangling reference, ignore
    }
  }
  return [...issues.values()];
}

async function fetchTree({ github, owner, repo, sha, core }) {
  try {
    const { data } = await github.rest.git.getTree({
      owner,
      repo,
      tree_sha: sha,
      recursive: 'true',
    });
    return data.tree.filter((e) => e.type === 'blob').map((e) => e.path);
  } catch (error) {
    core.warning(`Failed to load repository tree: ${error.message}`);
    return [];
  }
}

/**
 * Collects everything a reviewer needs besides the diff:
 * linked issues, PR description, commits, project rules, file tree,
 * full content of changed files and related existing tests.
 */
export async function gatherContext({ github, owner, repo, pr, core }) {
  const ref = pr.head.sha;
  const get = (path, at = ref) => fetchText({ github, owner, repo, path, ref: at });

  const [linkedIssues, changedFiles, commits, tree] = await Promise.all([
    fetchLinkedIssues({ github, owner, repo, pr, core }),
    github.paginate(github.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: pr.number,
      per_page: 100,
    }),
    github.paginate(github.rest.pulls.listCommits, {
      owner,
      repo,
      pull_number: pr.number,
      per_page: 100,
    }),
    fetchTree({ github, owner, repo, sha: ref, core }),
  ]);

  const reviewable = changedFiles.filter((f) => f.status !== 'removed' && !isNoise(f.filename));
  // tests first: they decide whether acceptance criteria count as "tested"
  reviewable.sort((a, b) => Number(isTestFile(b.filename)) - Number(isTestFile(a.filename)));
  const relatedTests = findRelatedTests(
    changedFiles.map((f) => f.filename),
    tree,
  );

  const [guidelines, packageJson, fullFiles, testFiles] = await Promise.all([
    Promise.all(GUIDELINE_FILES.map(async (p) => [p, await get(p, pr.base.sha)])),
    get('package.json'),
    Promise.all(reviewable.map(async (f) => [f.filename, await get(f.filename)])),
    Promise.all(relatedTests.map(async (p) => [p, await get(p)])),
  ]);

  const blocks = (pairs) =>
    pairs
      .filter(([, t]) => t)
      .map(([p, t]) => fileBlock(p, t))
      .join('\n\n');
  const changeList = changedFiles
    .map((f) => `- ${f.status}: ${f.filename} (+${f.additions}/-${f.deletions})`)
    .join('\n');

  return {
    linkedIssues,
    changedPaths: changedFiles.map((f) => f.filename),
    sections: {
      guidelines: blocks(guidelines),
      pr: `Title: ${pr.title}\nAuthor: ${pr.user?.login}\nBranch: ${pr.head.ref} -> ${pr.base.ref}\n\n${pr.body?.trim() || '(no description)'}`,
      commits: commits.map((c) => `- ${c.commit.message.split('\n')[0]}`).join('\n'),
      packageJson: packageJson ?? '',
      changedFiles: changeList,
      tree: tree
        .filter((p) => !isNoise(p))
        .slice(0, MAX_TREE_PATHS)
        .join('\n'),
      fullFiles: blocks(fullFiles),
      relatedTests: blocks(testFiles),
    },
  };
}
