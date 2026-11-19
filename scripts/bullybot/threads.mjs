import { BOT_RESOLVED, MARKER } from './review.mjs';

/**
 * Answering a review thread. With the token of the GitHub App BullyBot may resolve a thread
 * himself, if the app has Pull requests: write AND Contents: write (with Contents: read GitHub
 * answers "Resource not accessible by integration"). The workflow token is not allowed to either,
 * then he marks the thread as settled and asks the human to click "Resolve".
 */

/** Part of the verdict prompt: what the reply says about resolving, depending on the token. */
export function resolveInstruction(canResolve) {
  return canResolve
    ? 'For "fixed" and "dispute_accepted", you close the thread yourself right after your reply: end the reply ' +
        'by saying so in your voice, briefly (vary it, e.g. "Closing this one."). Do not ask the human to do anything.'
    : 'For "fixed" and "dispute_accepted", end the reply by telling the human to resolve the thread themselves, ' +
        'in your voice: you are not allowed to click that button and you are not happy about doing their paperwork ' +
        '(vary it, e.g. "Go ahead, click Resolve. I\'ll pretend I did it."). Never claim you resolved it.';
}

/** Posted when resolving failed although BullyBot announced it. */
export const RESOLVE_FAILED_NOTE =
  "Correction: I'm not allowed to resolve this thread after all. Go ahead and click Resolve. I'll pretend I did it.";

export const postReply = (github, threadId, body) =>
  github.graphql(
    `mutation($threadId: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
        comment { id }
      }
    }`,
    { threadId, body },
  );

async function resolveThread(github, threadId) {
  const data = await github.graphql(
    `mutation($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
    }`,
    { threadId },
  );
  if (!data?.resolveReviewThread?.thread?.isResolved)
    throw new Error('GitHub did not resolve the thread');
}

/**
 * Posts BullyBot's reply and, for a settled thread, resolves it when `canResolve` is set.
 * A thread he could not resolve is marked as settled in a second comment so that it is not judged
 * again. A thread he resolved needs no marker: if a human reopens it and replies, it is answered again.
 * Returns whether the thread counts as settled and whether it was resolved.
 */
export async function answerThread({ github, core, thread, verdict, reply, canResolve = false }) {
  const settle = verdict !== 'still_open';
  await postReply(
    github,
    thread.id,
    `${MARKER}${settle && !canResolve ? BOT_RESOLVED : ''}\n${reply}`,
  );
  if (!settle || !canResolve) return { settle, resolved: false };

  try {
    await resolveThread(github, thread.id);
    return { settle, resolved: true };
  } catch (error) {
    core?.warning(`Thread ${thread.id} could not be resolved: ${error.message}`);
    await postReply(github, thread.id, `${MARKER}${BOT_RESOLVED}\n${RESOLVE_FAILED_NOTE}`);
    return { settle, resolved: false };
  }
}
