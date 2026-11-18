/** Pure logic of the backlog cleanup: who may be touched, verdict validation, texts and report. */

export const KINDS = ['inactive', 'implemented', 'duplicate', 'superseded'];
export const STALE_LABEL = 'stale';
export const CLEANUP_MARKER = '<!-- product-owner:cleanup -->';

export const DEFAULT_STALE_DAYS = 90;
export const DEFAULT_MAX_ISSUES = 10;
const HARD_MAX_ISSUES = 50;
const MAX_STALE_DAYS = 3650;
const DAY = 24 * 60 * 60 * 1000;

const toInt = (value, fallback, max) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
};
export const clampStaleDays = (v) => toInt(v, DEFAULT_STALE_DAYS, MAX_STALE_DAYS);
export const clampMaxIssues = (v) => toInt(v, DEFAULT_MAX_ISSUES, HARD_MAX_ISSUES);

/** Whole days since the last activity; infinity when the date is unknown (never guess "fresh"). */
export function idleDays(issue, now) {
  const time = Date.parse(issue.updatedAt ?? '');
  return Number.isNaN(time) ? Infinity : Math.max(0, Math.floor((now - time) / DAY));
}

/**
 * Open issues the cleanup may look at. Epics are left alone: an epic with open sub-issues is
 * still in progress, and one without any recorded sub-issues cannot be judged from the outside.
 * Only an epic whose sub-issues are all done may be proposed (it is finished).
 */
export function eligibleIssues(issues) {
  return issues.filter((i) => {
    if (i.state !== 'open') return false;
    if (i.openSubIssues > 0) return false;
    if (i.labels.includes('epic') && i.subIssues === 0) return false;
    return true;
  });
}

const ORDER = {
  implemented: 0,
  duplicate: 1,
  superseded: 2,
  inactive: 3,
};

/** What the bot would do with an issue, derived from the verdict kind. */
function actionFor(verdict) {
  if (verdict.kind === 'implemented') return 'close_completed';
  if (verdict.kind === 'duplicate') return 'duplicate';
  if (verdict.kind === 'superseded') return 'close_not_planned';
  return verdict.closeIssue === true ? 'close_not_planned' : 'flag';
}

/**
 * Validates the verdicts of the model. Nothing the model says is trusted blindly: the issue must be
 * eligible, named issues must exist, an "inactive" verdict must be backed by the real dates.
 * Returns the proposals (capped), what was discarded and what did not fit under the cap.
 */
export function sanitizeVerdicts(raw, { issues, eligible, staleDays, now, max }) {
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const eligibleNumbers = new Set(eligible.map((i) => i.number));
  const accepted = [];
  const dropped = [];
  const seen = new Set();

  for (const v of Array.isArray(raw?.verdicts) ? raw.verdicts : []) {
    const number = Number(v?.number);
    const label = `#${Number.isInteger(number) ? number : '?'}`;
    const drop = (reason) => dropped.push({ number, reason: `${label}: ${reason}` });

    if (!eligibleNumbers.has(number)) {
      drop('not an open issue that may be cleaned up');
      continue;
    }
    if (seen.has(number)) {
      drop('named twice, the first verdict counts');
      continue;
    }
    if (!KINDS.includes(v.kind)) {
      drop(`unknown verdict "${v.kind}"`);
      continue;
    }
    const reason = String(v.reason ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!reason) {
      drop('no reason given');
      continue;
    }

    const issue = byNumber.get(number);
    const target = Number(v.target) || 0;
    if (v.kind === 'duplicate' || v.kind === 'superseded') {
      if (!byNumber.has(target) || target === number) {
        drop(`${v.kind} of #${target || '?'}, which does not exist`);
        continue;
      }
      if (v.kind === 'superseded' && target < number) {
        drop(`superseded by #${target}, which is not newer`);
        continue;
      }
    }
    if (v.kind === 'inactive') {
      const idle = idleDays(issue, now);
      if (idle < staleDays) {
        drop(`not inactive, last activity ${idle} days ago (limit ${staleDays})`);
        continue;
      }
      if (v.closeIssue !== true && issue.labels.includes(STALE_LABEL)) {
        drop(`already labeled ${STALE_LABEL}`);
        continue;
      }
    }

    seen.add(number);
    const action = actionFor(v);
    accepted.push({
      number,
      title: issue.title,
      kind: v.kind,
      action,
      target: v.kind === 'duplicate' || v.kind === 'superseded' ? target : null,
      reason,
      idle: idleDays(issue, now),
    });
  }

  // Sure verdicts first, then the oldest issues; closing before flagging within a kind
  accepted.sort(
    (a, b) =>
      ORDER[a.kind] - ORDER[b.kind] ||
      (a.action === 'flag') - (b.action === 'flag') ||
      a.number - b.number,
  );
  return { proposals: accepted.slice(0, max), dropped, deferred: accepted.slice(max) };
}

const ACTION_TEXT = {
  close_completed: 'close as completed',
  close_not_planned: 'close as not planned',
  duplicate: 'close as duplicate',
  flag: `label "${STALE_LABEL}"`,
};

export const describeAction = (p) =>
  p.action === 'duplicate' ? `close as duplicate of #${p.target}` : ACTION_TEXT[p.action];

/** Comment under the issue, written before anything changes. */
export function renderComment(p) {
  const intro = '🌟 Product Owner here, tidying up the backlog.';
  const closing =
    p.action === 'flag'
      ? `I labeled this issue \`${STALE_LABEL}\`. If it is still wanted, a comment with the current state is enough to keep it alive.`
      : `I closed it as ${
          p.action === 'duplicate'
            ? `a duplicate of #${p.target}`
            : p.action === 'close_completed'
              ? 'completed'
              : p.kind === 'superseded'
                ? `not planned (superseded by #${p.target})`
                : 'not planned'
        }. If that is wrong, reopen it and tell us why.`;
  return `${CLEANUP_MARKER}\n${intro}\n\n${p.reason}\n\n${closing}`;
}

const cell = (s) => String(s).replace(/\|/g, '\\|');

/** Markdown report for the job log and summary. */
export function renderCleanupReport({
  proposals,
  dropped,
  deferred,
  applied,
  problems,
  dryRun,
  staleDays,
}) {
  const lines = [`## 🧹 Product Owner cleanup${dryRun ? ' (dry run, nothing was changed)' : ''}`];
  lines.push(`Inactive means no activity for ${staleDays} days or more.`);

  if (proposals.length) {
    const rows = proposals.map((p) => {
      const status = dryRun ? 'proposed' : applied?.has(p.number) ? 'done' : 'failed';
      return `| #${p.number} ${cell(p.title)} | ${p.kind} | ${describeAction(p)} | ${cell(p.reason)} | ${status} |`;
    });
    lines.push(
      '| Issue | Why | Action | Reason | Status |\n|---|---|---|---|---|\n' + rows.join('\n'),
    );
  } else {
    lines.push('Nothing to clean up. The backlog looks tidy. ✨');
  }
  if (deferred.length)
    lines.push(
      `**Over the cap, left for the next run:** ${deferred.map((p) => `#${p.number} (${describeAction(p)})`).join(', ')}`,
    );
  if (dropped.length)
    lines.push('**Discarded verdicts:**\n' + dropped.map((d) => `- ${d.reason}`).join('\n'));
  if (problems?.length) lines.push('**Problems:**\n' + problems.map((p) => `- ${p}`).join('\n'));
  return lines.join('\n\n');
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
const BODY_PREVIEW = 300;

/** Compact list of the open issues with their age, plus the closed ones as titles. */
export function formatCleanupBacklog(issues, now) {
  const open = issues
    .filter((i) => i.state === 'open')
    .map((i) => {
      const idle = idleDays(i, now);
      const meta = [...i.labels, `idle ${Number.isFinite(idle) ? idle : '?'} days`].join(', ');
      return `#${i.number} ${i.title} [${meta}]\n  ${oneLine(i.body).slice(0, BODY_PREVIEW) || '(no description)'}`;
    });
  const closed = issues.filter((i) => i.state !== 'open').map((i) => `#${i.number} ${i.title}`);
  return { open: open.join('\n'), closed: closed.join('\n') };
}
