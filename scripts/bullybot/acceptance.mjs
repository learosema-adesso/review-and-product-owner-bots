const CHECKBOX = /^\s*[-*+]\s+\[( |x|X)\]\s+(.+?)\s*$/;
const HEADING = /^\s*(#{1,6})\s+/;
const AC_TITLE = /^(acceptance criteria|akzeptanzkriterien|definition of done)\b/i;

/** Heading level (1-6) of a markdown line, or 0 if it is not a heading. */
const headingLevel = (line) => line.match(HEADING)?.[1].length ?? 0;

/**
 * Reads the acceptance criteria (checkbox list) from an issue body.
 * If there is an "Acceptance criteria" heading, only that section counts, including its
 * sub-headings, up to the next heading of the same or a higher level.
 * Otherwise every checkbox in the body is taken.
 */
export function parseAcceptanceCriteria(body) {
  const lines = (body ?? '').split(/\r?\n/);
  const start = lines.findIndex(
    (l) => headingLevel(l) > 0 && AC_TITLE.test(l.replace(HEADING, '')),
  );
  let scope = lines;
  if (start !== -1) {
    const level = headingLevel(lines[start]);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => {
      const lvl = headingLevel(l);
      return lvl > 0 && lvl <= level;
    });
    scope = end === -1 ? rest : rest.slice(0, end);
  }
  return scope
    .map((l) => l.match(CHECKBOX))
    .filter(Boolean)
    .map((m) => ({ text: m[2], checked: m[1] !== ' ' }));
}

/** Assigns stable ids like "<issue>.<n>" that the model uses to refer to criteria. */
export const withCriterionIds = (issue) => ({
  ...issue,
  criteria: parseAcceptanceCriteria(issue.body).map((c, i) => ({
    ...c,
    id: `${issue.number}.${i + 1}`,
  })),
});

/** Criteria as a numbered list for the prompt. */
export const criteriaPrompt = (issues) =>
  issues
    .map((i) => {
      const parent = i.parent ? ` (part of #${i.parent.number} ${i.parent.title})` : '';
      const criteria = i.criteria.length
        ? i.criteria.map((c) => `  [${c.id}] ${c.text}`).join('\n')
        : '  (no acceptance criteria listed: judge against the issue description)';
      return `#${i.number} ${i.title}${parent}\n${i.body?.trim() || '(empty issue body)'}\n\nAcceptance criteria:\n${criteria}`;
    })
    .join('\n\n---\n\n');

const ICON = { yes: '✅', partial: '🟡', no: '❌', n_a: '➖' };
const LABEL = { yes: 'yes', partial: 'partly', no: 'no', n_a: 'n/a' };
const cell = (s) =>
  String(s ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
const show = (v) => (v in ICON ? `${ICON[v]} ${LABEL[v]}` : '❔ not assessed');

/**
 * Builds the markdown report from the issues (with criterion ids) and the model's assessments.
 * Criterion text comes from the issue, never from the model response, so nothing can be made up.
 */
export function renderAcceptanceReport(issues, assessments = []) {
  if (!issues.length) {
    return (
      '### 📋 Acceptance criteria\n\n' +
      'No linked issue found. Add `Closes #<issue>` to the PR description so I know what this PR is supposed to do.'
    );
  }

  const byId = new Map(assessments.map((a) => [a.id, a]));
  const all = issues.flatMap((i) => i.criteria);
  const count = (key, val) => all.filter((c) => byId.get(c.id)?.[key] === val).length;
  const testable = all.filter((c) => byId.get(c.id)?.tested !== 'n_a').length;

  const sections = issues.map((issue) => {
    if (!issue.criteria.length)
      return `#### #${issue.number} ${cell(issue.title)}\n\n_No acceptance criteria in this issue._`;
    const rows = issue.criteria.map((c) => {
      const a = byId.get(c.id);
      return `| ${c.id} | ${cell(c.text)} | ${show(a?.implemented)} | ${show(a?.tested)} | ${cell(a?.evidence)} |`;
    });
    return (
      `#### #${issue.number} ${cell(issue.title)}\n\n` +
      '| | Criterion | Implemented | Tested | Evidence |\n|---|---|---|---|---|\n' +
      rows.join('\n')
    );
  });

  const totals = all.length
    ? `**${count('implemented', 'yes')}/${all.length}** implemented, **${count('tested', 'yes')}/${testable}** tested.\n\n`
    : '';
  return `### 📋 Acceptance criteria\n\n${totals}${sections.join('\n\n')}`;
}

/** One-line summary for the review body. */
export function acceptanceSummaryLine(issues, assessments = []) {
  const all = issues.flatMap((i) => i.criteria);
  if (!all.length) return '';
  const byId = new Map(assessments.map((a) => [a.id, a]));
  const open = all.filter(
    (c) =>
      byId.get(c.id)?.implemented !== 'yes' || !['yes', 'n_a'].includes(byId.get(c.id)?.tested),
  );
  return open.length
    ? `**Acceptance criteria:** ${open.length} of ${all.length} not fully implemented and tested (${open.map((c) => c.id).join(', ')}). See the checklist comment.`
    : `**Acceptance criteria:** all ${all.length} implemented and tested. I checked twice. Annoying.`;
}
