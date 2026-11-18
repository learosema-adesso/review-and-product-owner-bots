import { createGeminiClient, gemini } from './lib/gemini.mjs';
import { fitSections } from './bullybot/context.mjs';
import { PERSONA } from './productowner/persona.mjs';
import { gatherProductContext } from './productowner/context.mjs';
import {
  fetchBacklog,
  fetchLabels,
  fetchMilestones,
  formatBacklog,
  formatMilestones,
} from './productowner/backlog.mjs';
import {
  sanitizePlan,
  renderTicketBody,
  SIZES,
  PRIORITIES,
  RELATIONS,
} from './productowner/tickets.mjs';
import { createTickets, setPriorities, placeOnBoard } from './productowner/publish.mjs';

const MAX_CONTEXT_CHARS = 250_000;
const MAX_DIRECTION_CHARS = 4_000;
const DEFAULT_MAX_TICKETS = 6;
const HARD_MAX_TICKETS = 12;

const INSTRUCTIONS =
  ' How to work: you get a rough direction from the stakeholder, the current backlog (open issues with previews, ' +
  'closed issues as titles), the labels and milestones, the README, package.json, project guidelines, the file tree, ' +
  'recent commits and the source of the app. Work out what already exists, then cut the direction into tickets. ' +
  'Rules for tickets: ' +
  '(1) Each ticket is one vertical slice a developer can finish in a single pull request; split anything bigger. ' +
  '(2) Never create a ticket for something that already exists in the code or the backlog (open or closed). ' +
  'An idea counts as covered only if an existing issue or the code delivers the behavior as a feature of its own, ' +
  'the way the user would experience it. Behavior that is merely possible indirectly (by configuring something ' +
  'else, or as a side effect of another feature) is NOT covered: create a small ticket for the intent and ' +
  'relate it to the existing issue with the relation "extends", saying in "why" how it differs. ' +
  'Put covered ideas into "skipped"; the reason names the issue or file and says which part of it delivers the behavior. ' +
  '(3) story: a short user story ("As a <role>, I want <goal>, so that <benefit>") followed by one or two sentences ' +
  'of context. Name real parts of the app (components, routes, files) when that helps. ' +
  '(4) criteria: 3 to 8 acceptance criteria, each one observable and testable by an automated test or a clear manual check, ' +
  'written as a statement ("The invite link expires after 7 days"), not as a task. ' +
  'Include error paths and accessibility (keyboard, labels, screen readers) where the feature has a UI. ' +
  'No vague wording like "works well" or "is user friendly". ' +
  '(5) outOfScope: what this ticket deliberately does not do, mainly where it would otherwise grow. ' +
  '(6) notes: constraints, open questions and technical hints for the developer, only if useful. ' +
  `(7) size: ${SIZES.join('/')}, priority: ${PRIORITIES.join('/')} (Urgent = blocks the product, Low = nice to have). ` +
  'labels and milestone: use only names from the lists you are given, pick the milestone the ticket fits best. ' +
  '(8) overlaps: BEFORE you write the ticket, compare its idea with EVERY open and closed issue in the backlog, ' +
  'including the newest ones, and list each issue that touches the same feature area, screen, calculation or data. ' +
  'relation: "duplicate" if that issue already fully covers the behavior (the ticket is then not created), ' +
  '"extends" if this ticket builds on it or changes what it assumes, "related" if it only touches the same area. ' +
  'why: one short phrase. Use only issue numbers from the backlog. An empty list is correct only if nothing in the backlog is related. ' +
  '(9) Follow the conventions and decisions in the project guidelines and existing issues. ' +
  '(10) Describe behavior, not implementation: do not prescribe API routes, field names, data models, libraries or ' +
  'architecture unless the project guidelines or an existing issue already decide them. Put open design questions ' +
  'into the notes of the ticket as questions for the developers. ' +
  'Epic: if the tickets belong to an existing open epic from the backlog, set epicNumber to its number, ' +
  'else if there are three or more tickets that form a theme, set newEpicTitle and newEpicGoal, ' +
  'otherwise leave epicNumber 0 and the new epic fields empty. ' +
  'Write all tickets in English, in the tone of the existing issues. Be concise: no filler, no repetition. ' +
  `Create only as many tickets as the direction needs, never more than the limit you are given. ` +
  'summary: two to four friendly sentences for the stakeholder: how you read the direction, what you decided and why, ' +
  'and anything you need them to clarify. Do not start with a heading. ' +
  'If the direction is too vague or contradicts the product, return few or no tickets and say what you need in the summary.';

const STRING_ARRAY = { type: 'ARRAY', items: { type: 'STRING' } };

const PLAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    epicNumber: { type: 'INTEGER' },
    newEpicTitle: { type: 'STRING' },
    newEpicGoal: { type: 'STRING' },
    tickets: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          overlaps: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                number: { type: 'INTEGER' },
                relation: { type: 'STRING', enum: RELATIONS },
                why: { type: 'STRING' },
              },
              required: ['number', 'relation', 'why'],
            },
          },
          title: { type: 'STRING' },
          story: { type: 'STRING' },
          criteria: STRING_ARRAY,
          outOfScope: STRING_ARRAY,
          notes: { type: 'STRING' },
          labels: STRING_ARRAY,
          milestone: { type: 'STRING' },
          size: { type: 'STRING', enum: SIZES },
          priority: { type: 'STRING', enum: PRIORITIES },
        },
        // generated in this order: the overlap check comes before the text of the ticket
        propertyOrdering: [
          'overlaps',
          'title',
          'story',
          'criteria',
          'outOfScope',
          'notes',
          'labels',
          'milestone',
          'size',
          'priority',
        ],
        required: ['overlaps', 'title', 'story', 'criteria', 'labels', 'size', 'priority'],
      },
    },
    skipped: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { idea: { type: 'STRING' }, reason: { type: 'STRING' } },
        required: ['idea', 'reason'],
      },
    },
  },
  required: ['summary', 'tickets'],
};

const clampTickets = (value) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, HARD_MAX_TICKETS) : DEFAULT_MAX_TICKETS;
};

/** Markdown report for the job summary (shown on the workflow run page). */
export function renderRunReport({ direction, plan, created, dryRun }) {
  const lines = [`## 🌟 Product Owner${dryRun ? ' (dry run, nothing was created)' : ''}`];
  lines.push(`> ${direction.replace(/\n/g, '\n> ')}`);
  if (plan.summary) lines.push(plan.summary);

  if (plan.epic)
    lines.push(
      `**Epic:** ${plan.epic.existing ? `existing #${plan.epic.existing} ${plan.epic.title}` : `new, ${plan.epic.title}`}`,
    );

  if (plan.tickets.length) {
    const rows = plan.tickets.map((t, i) => {
      const issue = created?.tickets[i];
      const ref = issue?.number ? `#${issue.number} ` : '';
      return `| ${ref}${t.title.replace(/\|/g, '\\|')} | ${t.priority ?? '-'} | ${t.size ?? '-'} | ${t.milestone?.title ?? '-'} | ${t.criteria.length} |`;
    });
    lines.push(
      '| Ticket | Priority | Size | Milestone | Criteria |\n|---|---|---|---|---|\n' +
        rows.join('\n'),
    );
  }
  if (plan.skipped.length)
    lines.push(
      '**Not turned into tickets:**\n' +
        plan.skipped.map((s) => `- ${s.idea}: ${s.reason}`).join('\n'),
    );
  if (plan.dropped.length)
    lines.push(
      '**Discarded drafts:**\n' + plan.dropped.map((d) => `- ${d.title}: ${d.reason}`).join('\n'),
    );
  if (created?.problems.length)
    lines.push('**Problems:**\n' + created.problems.map((p) => `- ${p}`).join('\n'));
  return lines.join('\n\n');
}

/** Full text of every planned ticket, so a dry run can be judged without creating anything. */
export function renderPlanDetails(plan) {
  return plan.tickets
    .map((t) => {
      const meta = [
        `Priority: ${t.priority ?? '-'}`,
        `Size: ${t.size ?? '-'}`,
        `Milestone: ${t.milestone?.title ?? '-'}`,
        `Labels: ${t.labels.join(', ') || '-'}`,
      ].join(' | ');
      return `### ${t.title}\n${meta}\n\n${renderTicketBody(t)}`;
    })
    .join('\n\n');
}

/** Prints text as a collapsible group in the job log (plain output where groups do not exist). */
function logGroup(core, title, text) {
  core.startGroup?.(title);
  core.info(text);
  core.endGroup?.();
}

export async function productOwner({
  github,
  projectGithub,
  context,
  core,
  direction: directionInput,
  maxTickets: maxTicketsInput,
  dryRun = false,
  projectUrl,
  ask: askOverride, // test seam: replaces the Gemini call
}) {
  const { owner, repo } = context.repo;
  const direction = String(directionInput ?? '')
    .trim()
    .slice(0, MAX_DIRECTION_CHARS);
  if (!direction) {
    core.setFailed('No direction given. Tell me roughly what you want to build.');
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    core.setFailed('GEMINI_API_KEY secret is missing!');
    return;
  }
  const ask = askOverride ?? ((opts) => gemini({ ai: createGeminiClient(apiKey), ...opts }));
  const max = clampTickets(maxTicketsInput);

  // 1. What do we have? Backlog, labels, milestones and the product itself.
  let issues, labels, milestones, ctx;
  try {
    [issues, labels, milestones, ctx] = await Promise.all([
      fetchBacklog({ github, owner, repo }),
      fetchLabels({ github, owner, repo }),
      fetchMilestones({ github, owner, repo }),
      gatherProductContext({ github, owner, repo, core }),
    ]);
  } catch (error) {
    core.setFailed(`Could not load the project: ${error.message}`);
    return;
  }
  core.info(
    `Backlog: ${issues.length} issues, ${labels.length} labels, ${milestones.length} milestones.`,
  );

  const backlog = formatBacklog(issues);
  const s = ctx.sections;
  const contextText = fitSections(
    [
      { title: 'Project guidelines', text: s.guidelines, max: 20_000 },
      { title: 'Open issues (backlog)', text: backlog.open, max: 60_000 },
      { title: 'Closed issues (already done)', text: backlog.closed, max: 25_000 },
      { title: 'Milestones', text: formatMilestones(milestones), max: 3_000 },
      { title: 'Labels', text: labels.join(', '), max: 2_000 },
      { title: 'README', text: s.readme, max: 10_000 },
      { title: 'package.json', text: s.packageJson, max: 5_000 },
      { title: `Recent commits on ${ctx.defaultBranch}`, text: s.commits, max: 5_000 },
      { title: 'Repository files', text: s.tree, max: 30_000 },
      { title: 'Source of the app', text: s.sources, max: 120_000 },
    ],
    MAX_CONTEXT_CHARS,
  );

  // 2. Think
  let raw;
  try {
    raw = await ask({
      temperature: 0.6,
      schema: PLAN_SCHEMA,
      system: PERSONA + INSTRUCTIONS,
      prompt:
        `# Context\n\n${contextText}\n\n# Ticket limit\n${max}\n\n` +
        `# Direction from the stakeholder\n${direction}`,
    });
  } catch (error) {
    core.setFailed(`AI generation failed: ${error.message}`);
    return;
  }

  logGroup(core, 'Raw answer of the model', JSON.stringify(raw, null, 2));
  const plan = sanitizePlan(raw, { labels, milestones, issues, max });
  core.info(`Plan: ${plan.tickets.length} tickets, ${plan.dropped.length} discarded.`);

  // 3. Write it down
  let created = null;
  if (!dryRun && plan.tickets.length) {
    created = await createTickets({ github, owner, repo, plan, labels });
    created.problems.push(
      ...(await setPriorities({
        clients: [projectGithub, github].filter(Boolean),
        owner,
        created,
      })),
      ...(await placeOnBoard({ projectGithub, projectUrl, created, core })),
    );
    for (const p of created.problems) core.warning(p);
    if (!created.tickets.some((t) => t.number)) core.setFailed('No ticket could be created.');
  }

  // The report goes to the job log AND the job summary: the log is what people (and tools) can read
  const report = renderRunReport({ direction, plan, created, dryRun });
  const details = renderPlanDetails(plan);
  core.info(`\n${report}`);
  if (details) logGroup(core, 'Planned tickets in full', details);
  if (core.summary) {
    try {
      await core.summary.addRaw(details ? `${report}\n\n${details}` : report, true).write();
    } catch (error) {
      core.warning(`Writing the job summary failed: ${error.message}`);
    }
  }
  return { plan, created };
}
