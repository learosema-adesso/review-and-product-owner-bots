/** Hidden marker that identifies issues written by the Product Owner bot. */
export const PO_MARKER = '<!-- product-owner-bot -->';

export const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
export const PRIORITIES = ['Urgent', 'High', 'Medium', 'Low'];

const MAX_TITLE = 100;
const MAX_CRITERIA = 12;

/** Lower-cases and strips everything but letters and digits, to compare titles loosely. */
export const normalizeTitle = (title) =>
  String(title ?? '')
    .toLowerCase()
    .replace(/^epic:\s*/, '')
    .replaceAll('&', 'and')
    .replace(/[^\p{L}\p{N}]+/gu, '');

const clean = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/** Strips list/checkbox prefixes the model sometimes adds to a criterion ("- [ ] ..."). */
const cleanItem = (s) => clean(s).replace(/^(?:[-*+](?:\s+|$))?(?:\[[ xX]\](?:\s+|$))?/, '');

const cleanList = (list, max) =>
  (Array.isArray(list) ? list : []).map(cleanItem).filter(Boolean).slice(0, max);

/** Finds a milestone by exact title or by its short prefix ("M2"). */
export function resolveMilestone(name, milestones) {
  const wanted = clean(name).toLowerCase();
  if (!wanted) return null;
  return (
    milestones.find((m) => m.title.toLowerCase() === wanted) ??
    milestones.find((m) => m.title.toLowerCase().startsWith(`${wanted}:`)) ??
    null
  );
}

/**
 * Turns the raw model answer into tickets that are safe to create:
 * unknown labels, milestones, sizes and issue references are dropped, tickets without
 * acceptance criteria or that duplicate an existing issue are rejected, and the count is capped.
 * Everything that gets rejected is returned with a reason so the run report can show it.
 */
export function sanitizePlan(raw, { labels, milestones, issues, max }) {
  const knownLabels = new Map(labels.map((l) => [l.toLowerCase(), l]));
  const knownNumbers = new Set(issues.map((i) => i.number));
  const taken = new Map(issues.map((i) => [normalizeTitle(i.title), i.number]));
  const dropped = [];
  const tickets = [];

  for (const t of raw?.tickets ?? []) {
    const title = clean(t.title).slice(0, MAX_TITLE);
    const reject = (reason) => dropped.push({ title: title || '(untitled)', reason });

    if (!title) {
      reject('no title');
      continue;
    }
    const duplicateOf = taken.get(normalizeTitle(title));
    if (duplicateOf) {
      reject(
        typeof duplicateOf === 'number'
          ? `already exists as #${duplicateOf}`
          : 'duplicate in this run',
      );
      continue;
    }
    const criteria = cleanList(t.criteria, MAX_CRITERIA);
    if (!criteria.length) {
      reject('no acceptance criteria');
      continue;
    }
    if (tickets.length >= max) {
      reject(`over the limit of ${max} tickets`);
      continue;
    }

    taken.set(normalizeTitle(title), 'new');
    tickets.push({
      title,
      story: clean(t.story),
      criteria,
      outOfScope: cleanList(t.outOfScope, 6),
      notes: String(t.notes ?? '').trim(),
      labels: [
        ...new Set(
          (t.labels ?? [])
            .map((l) => knownLabels.get(clean(l).toLowerCase()))
            .filter((l) => l && l !== 'epic'),
        ),
      ],
      milestone: resolveMilestone(t.milestone, milestones),
      size: SIZES.includes(t.size) ? t.size : null,
      priority: PRIORITIES.includes(t.priority) ? t.priority : null,
      related: [...new Set(t.relatedIssues ?? [])].filter((n) => knownNumbers.has(n)),
    });
  }

  return {
    summary: String(raw?.summary ?? '').trim(),
    epic: tickets.length ? resolveEpic(raw, issues) : null,
    tickets,
    dropped,
    skipped: (raw?.skipped ?? [])
      .map((s) => ({ idea: clean(s.idea), reason: clean(s.reason) }))
      .filter((s) => s.idea),
  };
}

/**
 * Epic choice: an existing open epic wins, otherwise a new one if the model proposed one.
 * An epic number that is not an open issue labelled "epic" is ignored (models invent numbers).
 */
function resolveEpic(raw, issues) {
  const existing = issues.find(
    (i) => i.number === raw?.epicNumber && i.state === 'open' && i.labels.includes('epic'),
  );
  if (existing) return { existing: existing.number, title: existing.title };

  const title = clean(raw?.newEpicTitle);
  if (!title) return null;
  return {
    existing: null,
    title: /^epic:/i.test(title) ? title : `Epic: ${title}`,
    goal: String(raw?.newEpicGoal ?? '').trim(),
  };
}

const list = (items) => items.map((i) => `- ${i}`).join('\n');

/** Issue body in the layout the repo already uses (and that BullyBot parses). */
export function renderTicketBody(ticket) {
  const parts = [`## Goal\n${ticket.story}`];
  parts.push(`## Acceptance criteria\n${ticket.criteria.map((c) => `- [ ] ${c}`).join('\n')}`);
  if (ticket.outOfScope.length) parts.push(`## Out of scope\n${list(ticket.outOfScope)}`);

  const notes = [
    ticket.notes,
    ticket.related.length ? `Related: ${ticket.related.map((n) => `#${n}`).join(', ')}` : '',
  ].filter(Boolean);
  if (notes.length) parts.push(`## Notes\n${notes.join('\n\n')}`);

  parts.push(`---\n${PO_MARKER}\n_Written by the Product Owner bot._`);
  return parts.join('\n\n');
}

export function renderEpicBody(epic, tickets) {
  return [
    `## Goal\n${epic.goal || epic.title}`,
    `## Scope\nTracked as sub-issues of this epic:\n${list(tickets.map((t) => t.title))}`,
    `---\n${PO_MARKER}\n_Written by the Product Owner bot._`,
  ].join('\n\n');
}
