import { renderEpicBody, renderTicketBody } from './tickets.mjs';
import { parseProjectUrl, loadProject, addToProject } from './project.mjs';
import { loadIssueField, setIssueFieldOption } from './issuefields.mjs';

/** Writing to GitHub: issues, sub-issue links, the Priority issue field and the project board. */

export async function createIssue({ github, owner, repo, title, body, labels, milestone }) {
  const { data } = await github.rest.issues.create({
    owner,
    repo,
    title,
    body,
    labels,
    ...(milestone && { milestone: milestone.number }),
  });
  return data;
}

/** Creates epic, tickets and sub-issue links. A failing ticket does not stop the others. */
export async function createTickets({ github, owner, repo, plan, labels }) {
  const problems = [];
  const result = { epic: null, tickets: [], problems };

  if (plan.epic?.existing) {
    result.epic = { number: plan.epic.existing, existing: true };
  } else if (plan.epic) {
    try {
      const data = await createIssue({
        github,
        owner,
        repo,
        title: plan.epic.title,
        body: renderEpicBody(plan.epic, plan.tickets),
        labels: labels.includes('epic') ? ['epic'] : [],
      });
      result.epic = { number: data.number, id: data.id, nodeId: data.node_id, existing: false };
    } catch (error) {
      problems.push(`Epic "${plan.epic.title}" could not be created: ${error.message}`);
    }
  }

  for (const ticket of plan.tickets) {
    try {
      const data = await createIssue({
        github,
        owner,
        repo,
        title: ticket.title,
        body: renderTicketBody(ticket),
        labels: ticket.labels,
        milestone: ticket.milestone,
      });
      const created = { number: data.number, nodeId: data.node_id, ticket };
      result.tickets.push(created);

      if (result.epic) {
        try {
          await github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', {
            owner,
            repo,
            issue_number: result.epic.number,
            sub_issue_id: data.id,
          });
        } catch (error) {
          problems.push(
            `#${data.number} could not be linked to epic #${result.epic.number}: ${error.message}`,
          );
        }
      }
    } catch (error) {
      result.tickets.push({ number: null, ticket });
      problems.push(`Ticket "${ticket.title}" could not be created: ${error.message}`);
    }
  }
  return result;
}

/**
 * Sets the organization issue field "Priority" on the new issues. It is a property of the issue,
 * so the board does not matter, but the token does: the workflow token usually cannot read
 * organization issue fields, so the board token is tried first and the workflow token second.
 * Problems are returned, never thrown.
 */
export async function setPriorities({ clients, owner, created }) {
  const todo = created.tickets.filter((t) => t.number && t.ticket.priority);
  if (!todo.length) return [];

  let client, field;
  const errors = [];
  for (const candidate of clients) {
    try {
      field = await loadIssueField({ github: candidate, org: owner, name: 'Priority' });
      client = candidate;
      break;
    } catch (error) {
      errors.push(error.message.replace(/\s+/g, ' ').trim());
    }
  }
  if (!client) return [`Priority was not set on any issue: ${errors.join(' | ')}`];

  const problems = [];
  for (const { number, nodeId, ticket } of todo) {
    try {
      await setIssueFieldOption({
        github: client,
        issueNodeId: nodeId,
        field,
        optionName: ticket.priority,
      });
    } catch (error) {
      problems.push(`#${number}: priority ${ticket.priority} not set: ${error.message}`);
    }
  }
  return problems;
}

/** Puts the new issues on the project board. Needs a token with project access. */
export async function placeOnBoard({ projectGithub, projectUrl, created, core }) {
  const ref = parseProjectUrl(projectUrl);
  if (!ref) {
    return [
      'PROJECT_URL is not set or not a valid project URL, so the issues were not added to a project board ' +
        '(set the repository variable, e.g. https://github.com/users/<login>/projects/1).',
    ];
  }
  if (!projectGithub) {
    return [
      'No board token is configured (GitHub App secrets or PROJECT_TOKEN), so the issues were not ' +
        'added to the project board (the default workflow token cannot write to Projects).',
    ];
  }

  const problems = [];
  let project;
  try {
    project = await loadProject({ github: projectGithub, ref });
  } catch (error) {
    return [`Project board not usable: ${error.message}`];
  }

  const items = [
    ...(created.epic && !created.epic.existing && created.epic.nodeId
      ? [
          {
            number: created.epic.number,
            nodeId: created.epic.nodeId,
            values: { Status: 'Backlog' },
          },
        ]
      : []),
    ...created.tickets
      .filter((t) => t.number)
      .map((t) => ({
        number: t.number,
        nodeId: t.nodeId,
        values: { Status: 'Backlog', Size: t.ticket.size },
      })),
  ];

  for (const item of items) {
    try {
      const { skipped } = await addToProject({
        github: projectGithub,
        project,
        nodeId: item.nodeId,
        values: item.values,
      });
      if (skipped.length)
        problems.push(`#${item.number}: board has no option for ${skipped.join(', ')}`);
    } catch (error) {
      problems.push(`#${item.number} could not be added to the board: ${error.message}`);
    }
  }
  return problems;
}
