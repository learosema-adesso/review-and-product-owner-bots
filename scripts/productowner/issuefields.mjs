/**
 * Organization issue fields (Priority, Effort, ...) live on the issue itself, not on a project
 * board, so they are read and written through the issue APIs and not through the project.
 */
export async function loadIssueField({ github, org, name }) {
  const data = await github.graphql(
    `query($org: String!) {
      organization(login: $org) {
        issueFields(first: 30) {
          nodes { ... on IssueFieldSingleSelect { id name options { id name } } }
        }
      }
    }`,
    { org },
  );
  const field = data.organization?.issueFields.nodes.find(
    (f) => f?.options && f.name.toLowerCase() === name.toLowerCase(),
  );
  if (!field) throw new Error(`Issue field "${name}" not found in organization ${org}`);
  return field;
}

/** Sets a single-select issue field by option name. Throws if the option does not exist. */
export async function setIssueFieldOption({ github, issueNodeId, field, optionName }) {
  const option = field.options.find((o) => o.name.toLowerCase() === optionName.toLowerCase());
  if (!option) throw new Error(`"${field.name}" has no option "${optionName}"`);
  await github.graphql(
    `mutation($issue: ID!, $field: ID!, $option: ID!) {
      setIssueFieldValue(input: {
        issueId: $issue,
        issueFields: [{ fieldId: $field, singleSelectOptionId: $option }]
      }) { clientMutationId }
    }`,
    { issue: issueNodeId, field: field.id, option: option.id },
  );
}
