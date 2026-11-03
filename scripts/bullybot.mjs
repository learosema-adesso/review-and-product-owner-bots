export async function bullybot({ github, context, core }) {
  const geminiApiKey = process.env.GEMINI_API_KEY;

  if (!geminiApiKey) {
    core.setFailed("GEMINI_API_KEY secret is missing!");
    return;
  }

  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const prNumber = context.issue.number;

  // 1. Check if PR is in draft mode
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
  if (pr.draft) {
    core.info("PR is in draft mode. BullyBot holds back.");
    return;
  }

  // 2. Check if bot has been silenced with "shut up"
  const { data: comments } = await github.rest.issues.listComments({ owner, repo, issue_number: prNumber });
  const isMuted = comments.some(c => c.body.toLowerCase().includes('shut up'));
  if (isMuted) {
    core.info("BullyBot was silenced with 'shut up'.");
    return;
  }

  // 3. Handle review threads (resolve outdated ones if code was fixed)
  const graphQLQuery = `
    query($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 50) {
            nodes {
              id
              isResolved
              isOutdated
            }
          }
        }
      }
    }
  `;

  try {
    const threadData = await github.graphql(graphQLQuery, { owner, repo, prNumber });
    const threads = threadData.repository.pullRequest.reviewThreads.nodes;

    for (const thread of threads) {
      if (thread.isResolved) continue;

      if (thread.isOutdated) {
        await github.graphql(`
          mutation($threadId: ID!) {
            resolveReviewThread(input: { threadId: $threadId }) {
              thread { isResolved }
            }
          }
        `, { threadId: thread.id });
        core.info(`Thread ${thread.id} resolved by BullyBot (fix committed).`);
      }
    }
  } catch (error) {
    core.warning(`Failed to process review threads: ${error.message}`);
  }

  // 4. Fetch PR diff
  const { data: diffContent } = await github.rest.pulls.get({
    owner, repo, pull_number: prNumber,
    headers: { accept: 'application/vnd.github.v3.diff' }
  });

  if (!diffContent || !diffContent.trim()) {
    core.info("No changes found in PR diff.");
    return;
  }

  const truncatedDiff = diffContent.substring(0, 30000);
  const systemInstruction = 
    "You are a brutal, hyper-critical, and deeply disappointed senior developer reviewing a junior's code. " +
    "You have zero patience for messy code, lack of comments, or bad naming conventions. " +
    "Roast the following code diff relentlessly with heavy sarcasm, wit, and condescension. " +
    "However, ensure your underlying technical points are 100% correct so they actually learn something. " +
    "Structure your roast using markdown. Start with a scathing overall summary, followed by specific bullet point roasts.";

  // 5. Generate roast using Gemini REST API
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [{ parts: [{ text: `Review this GitHub PR Diff and roast it:\n\n\`\`\`diff\n${truncatedDiff}\n\`\`\`` }] }],
          generationConfig: { temperature: 0.85 }
        })
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API Error ${res.status}: ${errText}`);
    }

    const result = await res.json();
    const roastText = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (roastText) {
      await github.rest.issues.createComment({
        issue_number: prNumber,
        owner,
        repo,
        body: `## 👺 BullyBot\n\n${roastText}`
      });
    }
  } catch (error) {
    core.setFailed(`AI Generation failed: ${error.message}`);
  }
}
