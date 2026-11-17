/** Reads "https://github.com/users/<login>/projects/<n>" or ".../orgs/<login>/projects/<n>". */
export function parseProjectUrl(url) {
  const m = String(url ?? '').match(/github\.com\/(users|orgs)\/([^/]+)\/projects\/(\d+)/);
  return m
    ? { kind: m[1] === 'users' ? 'user' : 'organization', login: m[2], number: Number(m[3]) }
    : null;
}

/** Finds a single-select option ("Status" -> "Backlog") case-insensitively. */
export function findOption(project, fieldName, optionName) {
  if (!optionName) return null;
  const field = project.fields.find(
    (f) => f.options && f.name.toLowerCase() === fieldName.toLowerCase(),
  );
  const option = field?.options.find((o) => o.name.toLowerCase() === optionName.toLowerCase());
  return field && option ? { fieldId: field.id, optionId: option.id } : null;
}

export async function loadProject({ github, ref }) {
  const data = await github.graphql(
    `query($login: String!, $number: Int!) {
      ${ref.kind}(login: $login) {
        projectV2(number: $number) {
          id
          fields(first: 50) {
            nodes { ... on ProjectV2SingleSelectField { id name options { id name } } }
          }
        }
      }
    }`,
    { login: ref.login, number: ref.number },
  );
  const project = data[ref.kind]?.projectV2;
  if (!project) throw new Error(`Project ${ref.login}/${ref.number} not found or not accessible`);
  return { id: project.id, fields: project.fields.nodes.filter((f) => f?.id) };
}

/**
 * Puts an issue on the board and fills Status/Priority/Size.
 * A value the board has no option for is skipped, the issue still lands on the board.
 */
export async function addToProject({ github, project, nodeId, values }) {
  const { addProjectV2ItemById } = await github.graphql(
    `mutation($project: ID!, $content: ID!) {
      addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
    }`,
    { project: project.id, content: nodeId },
  );
  const itemId = addProjectV2ItemById.item.id;

  const skipped = [];
  for (const [fieldName, optionName] of Object.entries(values)) {
    const hit = findOption(project, fieldName, optionName);
    if (!hit) {
      if (optionName) skipped.push(`${fieldName}=${optionName}`);
      continue;
    }
    await github.graphql(
      `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $project, itemId: $item, fieldId: $field,
          value: { singleSelectOptionId: $option }
        }) { projectV2Item { id } }
      }`,
      { project: project.id, item: itemId, field: hit.fieldId, option: hit.optionId },
    );
  }
  return { itemId, skipped };
}
