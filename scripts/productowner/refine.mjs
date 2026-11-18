import { PRIORITIES, SIZES } from './tickets.mjs';

/** Pure logic of ticket refinement: finding candidates, validating the model, merging text. */

export const REFINE_MARKER = '<!-- product-owner:refine -->';
export const NEEDS_INFO_LABEL = 'needs-info';

export const BIG_SIZES = ['L', 'XL'];
export const MAX_CRITERIA_BEFORE_SPLIT = 8;
const MAX_CRITERIA = 12;
const MAX_QUESTIONS = 5;
const MAX_SPLIT_TICKETS = 6;
const MIN_DESCRIPTION_WORDS = 6;

export const DEFAULT_MAX_ISSUES = 5;
const HARD_MAX_ISSUES = 20;
export const clampMaxIssues = (value) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, HARD_MAX_ISSUES) : DEFAULT_MAX_ISSUES;
};

/** `issue` input: a positive issue number, or "scan" (also the default for empty input). */
export function parseIssueInput(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/^#/, '');
  if (!text || text.toLowerCase() === 'scan') return { scan: true };
  return /^\d+$/.test(text) && Number(text) > 0 ? { number: Number(text) } : { invalid: text };
}

const clean = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const cleanItem = (s) => clean(s).replace(/^(?:[-*+](?:\s+|$))?(?:\[[ xX]\](?:\s+|$))?/, '');
const cleanList = (list, max) =>
  (Array.isArray(list) ? list : []).map(cleanItem).filter(Boolean).slice(0, max);

const HEADING = /^\s*#{1,6}\s/;
const CRITERIA_HEADING = /^\s*#{1,6}\s*acceptance criteria\s*:?\s*$/i;
const CHECKBOX = /^\s*[-*+]\s+\[[ xX]\]\s+(.+?)\s*$/;
const BULLET = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/;

/**
 * Acceptance criteria of a ticket. Under an "Acceptance criteria" heading every list item counts,
 * without such a heading only checkbox items do.
 */
export function parseCriteria(body) {
  const lines = String(body ?? '').split('\n');
  const start = lines.findIndex((l) => CRITERIA_HEADING.test(l));
  if (start === -1) return lines.map((l) => l.match(CHECKBOX)?.[1]).filter(Boolean);
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (HEADING.test(line)) break;
    const item = line.match(BULLET)?.[1];
    if (item) items.push(item);
  }
  return items;
}

/** True when there is more than a title's worth of text outside of headings and checkboxes. */
export function hasDescription(body) {
  const text = String(body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter(
      (l) => !HEADING.test(l) && !CHECKBOX.test(l) && !/^\s*(---+|_Written by.*_)\s*$/.test(l),
    )
    .join(' ');
  return text.split(/\s+/).filter(Boolean).length >= MIN_DESCRIPTION_WORDS;
}

/** Issues a scan may pick: open, not an epic (labelled or with sub-issues). */
export function refinable(issue) {
  return (
    issue.state === 'open' &&
    !issue.labels.includes('epic') &&
    issue.subIssues === 0 &&
    issue.openSubIssues === 0
  );
}

/**
 * Why an issue needs refinement, judged by the code. "Vague wording" is a judgment call and comes
 * from the model, see `findCandidates`. `sizes` maps issue numbers to their board size.
 */
export function refinementReasons(issue, size) {
  const reasons = [];
  if (!hasDescription(issue.body)) reasons.push('no description');
  const criteria = parseCriteria(issue.body);
  if (!criteria.length) reasons.push('no acceptance criteria');
  if (criteria.length > MAX_CRITERIA_BEFORE_SPLIT) reasons.push(`${criteria.length} criteria`);
  if (BIG_SIZES.includes(size)) reasons.push(`size ${size}`);
  return reasons;
}

/**
 * Candidates for a scan, most obvious first: objective reasons before pure "vague wording".
 * Issues waiting for an answer (`needs-info`) are left alone until someone answers, which
 * means removing the label.
 */
export function findCandidates({ issues, sizes = new Map(), vague = [], max }) {
  const vagueSet = new Set(vague);
  return issues
    .filter((i) => refinable(i) && !i.labels.includes(NEEDS_INFO_LABEL))
    .map((issue) => {
      const reasons = refinementReasons(issue, sizes.get(issue.number));
      const objective = reasons.length;
      if (vagueSet.has(issue.number)) reasons.push('vague wording');
      return { issue, reasons, objective };
    })
    .filter((c) => c.reasons.length)
    .sort(
      (a, b) =>
        b.objective - a.objective ||
        b.reasons.length - a.reasons.length ||
        a.issue.number - b.issue.number,
    )
    .slice(0, max);
}

/**
 * Splits must carry every criterion of the original ticket exactly once. The text of the
 * criteria comes from the original, the model only decides where each one goes (by number) and
 * may add criteria of its own (`extraCriteria`).
 */
export function validateSplit(raw, criteria) {
  const tickets = Array.isArray(raw?.tickets) ? raw.tickets : [];
  if (tickets.length < 2) return { error: 'a split needs at least two sub-tickets' };
  if (tickets.length > MAX_SPLIT_TICKETS)
    return { error: `more than ${MAX_SPLIT_TICKETS} sub-tickets` };
  if (criteria.length < 2) return { error: 'the ticket has fewer than two criteria to distribute' };

  const owner = new Map();
  const result = [];
  for (const [index, t] of tickets.entries()) {
    const title = clean(t?.title).slice(0, 100);
    if (!title) return { error: `sub-ticket ${index + 1} has no title` };
    const covers = [...new Set(Array.isArray(t.covers) ? t.covers.map(Number) : [])];
    for (const n of covers) {
      if (!Number.isInteger(n) || n < 1 || n > criteria.length)
        return { error: `sub-ticket "${title}" names criterion ${n}, which does not exist` };
      if (owner.has(n))
        return { error: `criterion ${n} is in "${owner.get(n)}" and in "${title}"` };
      owner.set(n, title);
    }
    const extra = cleanList(t.extraCriteria, MAX_CRITERIA);
    const own = covers.sort((a, b) => a - b).map((n) => criteria[n - 1]);
    if (!own.length && !extra.length) return { error: `sub-ticket "${title}" has no criteria` };
    result.push({
      title,
      story: clean(t.story),
      criteria: [...own, ...extra],
      covers,
      size: SIZES.includes(t.size) ? t.size : null,
      priority: PRIORITIES.includes(t.priority) ? t.priority : null,
    });
  }
  const lost = criteria.map((_, i) => i + 1).filter((n) => !owner.has(n));
  if (lost.length) return { error: `criteria ${lost.join(', ')} are in no sub-ticket` };
  if (new Set(result.map((r) => r.title.toLowerCase())).size !== result.length)
    return { error: 'two sub-tickets have the same title' };
  return { reason: clean(raw.reason), tickets: result };
}

const sectionCriteria = (criteria) =>
  `## Acceptance criteria\n${criteria.map((c) => `- [ ] ${c}`).join('\n')}`;

/**
 * Turns the model's answer for ONE issue into a safe plan:
 *  - well-formed human text is left alone, missing sections are appended below it
 *  - a rewrite is accepted only for text that exists, and only if it still has checkbox criteria
 *  - a question never changes any text
 *  - the split has to carry every criterion exactly once, otherwise only the split is discarded
 * `problems` lists everything that was dropped, so the report can show it.
 */
export function sanitizeRefinement(raw, issue) {
  const problems = [];
  const body = String(issue.body ?? '').trim();
  const explanation = clean(raw?.explanation);
  const result = {
    action: 'none',
    explanation,
    newBody: null,
    rewritten: false,
    added: [],
    questions: [],
    split: null,
    size: SIZES.includes(raw?.size) ? raw.size : null,
    priority: PRIORITIES.includes(raw?.priority) ? raw.priority : null,
    problems,
  };

  if (raw?.assessment === 'needs_info') {
    result.questions = cleanList(raw.questions, MAX_QUESTIONS);
    if (!result.questions.length) problems.push('needs_info without questions, ignored');
    else result.action = 'ask';
    result.size = null;
    result.priority = null;
    return result;
  }
  if (raw?.assessment !== 'refine') return { ...result, size: null, priority: null };

  const newCriteria = cleanList(raw.criteria, MAX_CRITERIA);
  const rewritten = String(raw.rewrittenBody ?? '').trim();

  if (rewritten) {
    if (!body) {
      problems.push(
        'rewrite ignored: there is no text to rewrite, the missing sections are added instead',
      );
    } else if (rewritten === body) {
      problems.push('rewrite ignored: identical to the original');
    } else {
      let next = rewritten;
      if (!parseCriteria(next).length && newCriteria.length)
        next = `${next}\n\n${sectionCriteria(newCriteria)}`;
      if (parseCriteria(next).length) {
        result.newBody = next;
        result.rewritten = true;
        result.added.push('rewrote the unclear text');
      } else {
        problems.push('rewrite discarded: it has no acceptance criteria as checkboxes');
      }
    }
  }

  if (!result.rewritten) {
    const parts = [];
    if (!hasDescription(body)) {
      const goal = String(raw.goal ?? '').trim();
      if (goal) {
        parts.push(`## Goal\n${goal}`);
        result.added.push('added a goal');
      } else problems.push('the ticket has no description and the model wrote no goal');
    }
    if (!parseCriteria(body).length) {
      if (newCriteria.length) {
        parts.push(sectionCriteria(newCriteria));
        result.added.push('added acceptance criteria');
      } else problems.push('the ticket has no acceptance criteria and the model wrote none');
    }
    if (parts.length) result.newBody = [body, ...parts].filter(Boolean).join('\n\n');
  }

  if (raw.split) {
    const effective = parseCriteria(result.newBody ?? body);
    const checked = validateSplit(raw.split, effective);
    if (checked.error) problems.push(`split discarded: ${checked.error}`);
    else result.split = checked;
  }

  if (result.newBody || result.split) result.action = 'refine';
  else {
    result.size = null;
    result.priority = null;
  }
  return result;
}

// ---------------------------------------------------------------- texts

/** Wraps text in a code fence that is longer than any fence inside of it. */
function fenced(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}markdown\n${text}\n${fence}`;
}

const subTicketBlock = (t, created) =>
  [
    `**${created ? `#${created.number} ` : ''}${t.title}**`,
    t.story,
    t.criteria.map((c) => `- [ ] ${c}`).join('\n'),
    `Size: ${t.size ?? '-'} | Priority: ${t.priority ?? '-'}`,
  ]
    .filter(Boolean)
    .join('\n');

/** The comment under the refined issue. The original text is kept here before a rewrite. */
export function renderRefineComment({ issue, result, original, notes = [] }) {
  const lines = [REFINE_MARKER, '🌟 Product Owner here, I took a look at this ticket.'];
  if (result.explanation) lines.push(result.explanation);

  if (result.action === 'ask') {
    lines.push(
      'I could not settle these from the code, the backlog or the guidelines, so I did not change the text. Could you answer them?',
      result.questions.map((q) => `- ${q}`).join('\n'),
      `I labeled the issue \`${NEEDS_INFO_LABEL}\`. Remove the label once the answers are in, then it can be refined.`,
    );
  } else if (result.added.length) {
    lines.push(`What I did:\n${result.added.map((a) => `- ${a}`).join('\n')}`);
  }
  if (result.rewritten)
    lines.push(
      `<details><summary>Original text</summary>\n\n${fenced(String(original ?? '').trim())}\n\n</details>`,
    );
  if (notes.length) lines.push(notes.join('\n'));
  return lines.join('\n\n');
}

/** Second comment: the proposed split, or the sub-tickets that were created from it. */
export function renderSplitComment({ result, createdTickets }) {
  const lines = [REFINE_MARKER];
  const subs = result.split.tickets;
  if (createdTickets) {
    lines.push(
      '🌟 I split this ticket into sub-issues. Every criterion of this ticket is in exactly one of them:',
    );
  } else {
    lines.push(
      '🌟 This ticket looks too big for one pull request. This is my proposal for a split. ' +
        'Nothing was created: the Product Owner refine workflow creates the sub-issues when it runs with `apply`.',
    );
  }
  if (result.split.reason) lines.push(result.split.reason);
  lines.push(subs.map((t, i) => subTicketBlock(t, createdTickets?.[i])).join('\n\n'));
  return lines.join('\n\n');
}

const cell = (s) => String(s).replace(/\|/g, '\\|');

/** Markdown report for the job log and summary. */
export function renderRefineReport({ outcomes, dryRun, apply, problems = [] }) {
  const lines = [
    `## ✨ Product Owner refinement${dryRun ? ' (dry run, nothing was changed)' : ''}${apply && !dryRun ? ' (splits applied)' : ''}`,
  ];
  if (!outcomes.length) lines.push('Nothing to refine. The tickets look good. ✨');
  else {
    const rows = outcomes.map((o) => {
      const what = [];
      if (o.result.action === 'ask')
        what.push(`${o.result.questions.length} question(s), label ${NEEDS_INFO_LABEL}`);
      what.push(...o.result.added);
      if (o.result.split) what.push(`split into ${o.result.split.tickets.length}`);
      if (o.size) what.push(`size ${o.size}`);
      if (o.priority) what.push(`priority ${o.priority}`);
      return `| #${o.issue.number} ${cell(o.issue.title)} | ${cell(o.reasons.join(', ') || '-')} | ${cell(what.join(', ') || 'nothing to do')} | ${o.status} |`;
    });
    lines.push('| Issue | Why | What | Status |\n|---|---|---|---|\n' + rows.join('\n'));
  }
  const dropped = outcomes.flatMap((o) =>
    o.result.problems.map((p) => `- #${o.issue.number}: ${p}`),
  );
  if (dropped.length) lines.push('**Discarded parts of the answers:**\n' + dropped.join('\n'));
  if (problems.length) lines.push('**Problems:**\n' + problems.map((p) => `- ${p}`).join('\n'));
  return lines.join('\n\n');
}

/** Full text of what would be written, so a dry run can be judged. */
export function renderRefineDetails(outcomes) {
  return outcomes
    .filter((o) => o.result.action !== 'none')
    .map((o) => {
      const parts = [`### #${o.issue.number} ${o.issue.title}`, o.result.explanation];
      if (o.result.questions.length)
        parts.push('Questions:\n' + o.result.questions.map((q) => `- ${q}`).join('\n'));
      if (o.result.newBody) parts.push(`New text:\n\n${o.result.newBody}`);
      if (o.result.split) parts.push(renderSplitComment({ result: o.result }));
      return parts.filter(Boolean).join('\n\n');
    })
    .join('\n\n');
}
