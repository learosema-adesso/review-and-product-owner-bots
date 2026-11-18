const MAX_ISSUES = 400;

/**
 * `paginate` does not complain when it gets `undefined` as the method (a typo in the method name):
 * it silently requests the API root instead. So fail loudly before that can happen.
 */
function paginateWith(github, method, params) {
  const fn = github.rest.issues[method];
  if (typeof fn !== 'function') throw new Error(`Octokit has no issues.${method}()`);
  return github.paginate(fn, params);
}
const BODY_PREVIEW = 400;

/** Loads all issues (open and closed, no PRs): closed ones tell the bot what is already built. */
export async function fetchBacklog({ github, owner, repo }) {
  const raw = await paginateWith(github, 'listForRepo', {
    owner,
    repo,
    state: 'all',
    per_page: 100,
  });
  return raw
    .filter((i) => !i.pull_request)
    .slice(0, MAX_ISSUES)
    .map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      body: i.body ?? '',
      labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
      milestone: i.milestone?.title ?? null,
      updatedAt: i.updated_at ?? null,
      // sub-issues of an epic: open ones mean the epic is still in progress
      openSubIssues: Math.max(
        0,
        (i.sub_issues_summary?.total ?? 0) - (i.sub_issues_summary?.completed ?? 0),
      ),
      subIssues: i.sub_issues_summary?.total ?? 0,
    }));
}

export async function fetchLabels({ github, owner, repo }) {
  const labels = await paginateWith(github, 'listLabelsForRepo', {
    owner,
    repo,
    per_page: 100,
  });
  return labels.map((l) => l.name);
}

export async function fetchMilestones({ github, owner, repo }) {
  const milestones = await paginateWith(github, 'listMilestones', {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });
  return milestones.map((m) => ({
    number: m.number,
    title: m.title,
    description: m.description ?? '',
  }));
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Backlog as compact text. Open issues get a short preview of their body,
 * closed ones only a title line (they are done, the code shows the rest).
 */
export function formatBacklog(issues) {
  const line = (i) => {
    const meta = [...i.labels, i.milestone].filter(Boolean).join(', ');
    return `#${i.number} ${i.title}${meta ? ` [${meta}]` : ''}`;
  };
  const open = issues.filter((i) => i.state === 'open');
  const closed = issues.filter((i) => i.state !== 'open');

  const openText = open
    .map((i) => `${line(i)}\n  ${oneLine(i.body).slice(0, BODY_PREVIEW) || '(no description)'}`)
    .join('\n');
  return {
    open: openText,
    closed: closed.map(line).join('\n'),
  };
}

export const formatMilestones = (milestones) =>
  milestones.map((m) => `- ${m.title}${m.description ? `: ${m.description}` : ''}`).join('\n');
