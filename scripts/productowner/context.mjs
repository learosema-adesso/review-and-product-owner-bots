import { isNoise } from '../bullybot/diff.mjs';
import { detectSourceDirs, parseSourceDirs, selectSourceFiles } from './sources.mjs';
import { GUIDELINE_FILES, fetchText, fetchTree, fileBlock } from '../bullybot/context.mjs';

const MAX_SOURCE_FILES = 60;
const MAX_TREE_PATHS = 1500;
const MAX_COMMITS = 40;

/**
 * Collects what a product owner needs to know about the current state of the product:
 * README, package.json, project guidelines, file tree, recent commits and the source of the app.
 * Everything is read from the default branch.
 */
export async function gatherProductContext({
  github,
  owner,
  repo,
  core,
  sourcePaths = process.env.PRODUCT_SOURCE_PATHS,
}) {
  const { data: repoData } = await github.rest.repos.get({ owner, repo });
  const ref = repoData.default_branch;
  const get = (path) => fetchText({ github, owner, repo, path, ref });

  const [tree, commits] = await Promise.all([
    fetchTree({ github, owner, repo, sha: ref, core }),
    github.rest.repos
      .listCommits({ owner, repo, sha: ref, per_page: MAX_COMMITS })
      .then((r) => r.data)
      .catch((error) => {
        core.warning(`Failed to load commits: ${error.message}`);
        return [];
      }),
  ]);

  const dirs = detectSourceDirs(tree, parseSourceDirs(sourcePaths));
  core.info(`Source of the app: ${dirs ? dirs.join(', ') : 'the whole repository'}`);
  const sourceFiles = selectSourceFiles(tree, dirs).slice(0, MAX_SOURCE_FILES);
  const [readme, packageJson, guidelines, sources] = await Promise.all([
    get('README.md'),
    get('package.json'),
    Promise.all(GUIDELINE_FILES.map(async (p) => [p, await get(p)])),
    Promise.all(sourceFiles.map(async (p) => [p, await get(p)])),
  ]);

  const blocks = (pairs) =>
    pairs
      .filter(([, t]) => t)
      .map(([p, t]) => fileBlock(p, t))
      .join('\n\n');

  return {
    defaultBranch: ref,
    sections: {
      guidelines: blocks(guidelines),
      readme: readme ?? '',
      packageJson: packageJson ?? '',
      commits: commits.map((c) => `- ${c.commit.message.split('\n')[0]}`).join('\n'),
      tree: tree
        .filter((p) => !isNoise(p))
        .slice(0, MAX_TREE_PATHS)
        .join('\n'),
      sources: blocks(sources),
    },
  };
}
