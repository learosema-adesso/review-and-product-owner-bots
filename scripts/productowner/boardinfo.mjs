/** Reads what is already set on issues: the board field Size and the issue field Priority. */

const CHUNK = 20;

/**
 * Size of every issue of this repository that is on the board.
 * Issues that are on the board without a size map to null, issues that are not on it are missing.
 */
export async function fetchSizes({ github, ref, owner, repo }) {
  const sizes = new Map();
  let cursor = null;
  do {
    const data = await github.graphql(
      `query($login: String!, $number: Int!, $cursor: String) {
        ${ref.kind}(login: $login) {
          projectV2(number: $number) {
            items(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                content { ... on Issue { number repository { nameWithOwner } } }
                size: fieldValueByName(name: "Size") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
              }
            }
          }
        }
      }`,
      { login: ref.login, number: ref.number, cursor },
    );
    const items = data[ref.kind]?.projectV2?.items;
    if (!items) throw new Error(`Project ${ref.login}/${ref.number} not found or not accessible`);
    for (const node of items.nodes) {
      const issue = node?.content;
      if (!issue?.number || issue.repository?.nameWithOwner !== `${owner}/${repo}`) continue;
      sizes.set(issue.number, node.size?.name ?? null);
    }
    cursor = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
  } while (cursor);
  return sizes;
}

/** Current value of the issue field Priority for the given issue numbers (null when empty). */
export async function fetchPriorities({ github, owner, repo, numbers }) {
  const result = new Map();
  for (let i = 0; i < numbers.length; i += CHUNK) {
    const chunk = numbers.slice(i, i + CHUNK);
    const fields = chunk
      .map(
        (n) => `i${n}: issue(number: ${Number(n)}) {
          issueFieldValues(first: 10) {
            nodes { ... on IssueFieldSingleSelectValue { name field { ... on IssueFieldSingleSelect { name } } } }
          }
        }`,
      )
      .join('\n');
    const data = await github.graphql(
      `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${fields} } }`,
      { owner, repo },
    );
    for (const n of chunk) {
      const nodes = data.repository?.[`i${n}`]?.issueFieldValues?.nodes ?? [];
      const priority = nodes.find((v) => v?.field?.name?.toLowerCase() === 'priority');
      result.set(n, priority?.name ?? null);
    }
  }
  return result;
}
