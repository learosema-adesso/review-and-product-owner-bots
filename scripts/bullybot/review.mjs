export const MARKER = '<!-- bullybot -->';
export const BOT_RESOLVED = '<!-- bullybot:resolved -->';
export const ACCEPTANCE_MARKER = '<!-- bullybot:acceptance -->';

const SEVERITY_RANK = { critical: 0, major: 1, minor: 2 };
const UNKNOWN_SEVERITY_RANK = 3;
const DUPLICATE_DISTANCE = 3; // lines: a new finding this close to an existing thread counts as a repeat

/** Line of a review thread; outdated threads only have their original line. */
export const threadLine = (t) => t.line ?? t.originalLine ?? null;

/**
 * BullyBot already conceded or confirmed the fix in this thread. The workflow token can't
 * resolve threads, so it stays open until a human clicks "Resolve": it counts as done anyway.
 */
export const isSettledByBot = (t) => t.comments.nodes.some((c) => c.body?.includes(BOT_RESOLVED));

/** An open, unsettled BullyBot thread where a human had the last word. */
export const awaitsReply = (t) =>
  !t.isResolved &&
  !isSettledByBot(t) &&
  t.comments.nodes.length > 0 &&
  !t.comments.nodes.at(-1).body?.includes(MARKER);

/** Status of a known finding, as passed to the model so it doesn't raise it again. */
export const threadStatus = (t) => {
  if (isSettledByBot(t)) return 'settled (fixed, or BullyBot conceded): never raise again';
  if (t.isResolved) return 'DISMISSED by the human as false positive: never raise again';
  return 'open';
};

/** Events that only re-check existing threads instead of running a full review. */
export const isThreadsOnlyEvent = (eventName) => eventName === 'pull_request_review_comment';

const severityRank = (f) => SEVERITY_RANK[f.severity] ?? UNKNOWN_SEVERITY_RANK;

/**
 * Deterministic safety net for model findings: keeps only findings on commentable diff lines,
 * drops repeats of existing BullyBot threads and keeps the most severe ones up to `max`.
 */
export function selectFindings(findings, { files, botThreads, max }) {
  const isRepeat = (f) =>
    botThreads.some(
      (t) =>
        t.path === f.path &&
        threadLine(t) !== null &&
        Math.abs(threadLine(t) - f.line) <= DUPLICATE_DISTANCE,
    );

  return (findings ?? [])
    .filter((f) => files.get(f.path)?.valid.has(f.line))
    .filter((f) => !isRepeat(f))
    .sort((a, b) => severityRank(a) - severityRank(b))
    .slice(0, max);
}

/**
 * Creates or updates the single acceptance criteria checklist comment on the PR,
 * so every push refreshes it instead of adding noise.
 * Returns what happened: 'created', 'updated' or 'unchanged'.
 */
export async function upsertAcceptanceComment({ github, owner, repo, prNumber, comments, report }) {
  const body = `${MARKER}${ACCEPTANCE_MARKER}\n${report}`;
  const existing = comments.find((c) => c.body?.includes(ACCEPTANCE_MARKER));
  if (existing?.body === body) return 'unchanged';
  if (existing) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    return 'updated';
  }
  await github.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
  return 'created';
}
