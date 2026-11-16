import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAcceptanceCriteria,
  withCriterionIds,
  criteriaPrompt,
  renderAcceptanceReport,
  acceptanceSummaryLine,
} from './acceptance.mjs';

const BODY = `## Goal
Users can move between months.

- [ ] not a criterion, it's in the goal section

## Acceptance criteria
- [ ] Previous / next / today buttons
- [x] Heading announced to screen readers
* [ ] Month in the URL

## Notes
- [ ] also not a criterion`;

test('parseAcceptanceCriteria only reads the acceptance criteria section', () => {
  assert.deepEqual(parseAcceptanceCriteria(BODY), [
    { text: 'Previous / next / today buttons', checked: false },
    { text: 'Heading announced to screen readers', checked: true },
    { text: 'Month in the URL', checked: false },
  ]);
});

test('parseAcceptanceCriteria keeps criteria under sub-headings of the section', () => {
  const body = [
    '## Acceptance criteria',
    '- [ ] general',
    '### Feature A',
    '- [ ] a1',
    '#### Edge cases',
    '- [ ] a2',
    '### Feature B',
    '- [x] b1',
    '## Notes',
    '- [ ] not a criterion',
    '# Appendix',
    '- [ ] not one either',
  ].join('\n');
  assert.deepEqual(
    parseAcceptanceCriteria(body).map((c) => c.text),
    ['general', 'a1', 'a2', 'b1'],
  );
});

test('parseAcceptanceCriteria ends a level-3 section at the next level-2 or level-3 heading', () => {
  const body =
    '## Goal\n### Acceptance criteria\n- [ ] in\n#### Detail\n- [ ] also in\n### Notes\n- [ ] out';
  assert.deepEqual(
    parseAcceptanceCriteria(body).map((c) => c.text),
    ['in', 'also in'],
  );
});

test('parseAcceptanceCriteria does not treat "#hashtag" lines as headings', () => {
  assert.deepEqual(
    parseAcceptanceCriteria('## Acceptance criteria\n#nospace\n- [ ] still in').map((c) => c.text),
    ['still in'],
  );
});

test('parseAcceptanceCriteria falls back to all checkboxes without a heading', () => {
  assert.deepEqual(parseAcceptanceCriteria('- [ ] one\ntext\n- [X] two'), [
    { text: 'one', checked: false },
    { text: 'two', checked: true },
  ]);
});

test('parseAcceptanceCriteria handles empty, null and CRLF bodies', () => {
  assert.deepEqual(parseAcceptanceCriteria(null), []);
  assert.deepEqual(parseAcceptanceCriteria(''), []);
  assert.deepEqual(parseAcceptanceCriteria('## Acceptance criteria\r\n- [ ] a\r\n'), [
    { text: 'a', checked: false },
  ]);
});

test('parseAcceptanceCriteria accepts German and "definition of done" headings', () => {
  assert.equal(parseAcceptanceCriteria('### Akzeptanzkriterien\n- [ ] x').length, 1);
  assert.equal(parseAcceptanceCriteria('# Definition of Done\n- [ ] x').length, 1);
});

test('withCriterionIds numbers criteria per issue', () => {
  const issue = withCriterionIds({ number: 12, title: 'Nav', body: BODY });
  assert.deepEqual(
    issue.criteria.map((c) => c.id),
    ['12.1', '12.2', '12.3'],
  );
});

test('criteriaPrompt includes ids, parent epic and a hint when there are no criteria', () => {
  const prompt = criteriaPrompt([
    withCriterionIds({
      number: 12,
      title: 'Nav',
      body: BODY,
      parent: { number: 3, title: 'Epic: Calendar' },
    }),
    withCriterionIds({ number: 13, title: 'Empty', body: '' }),
  ]);
  assert.match(prompt, /#12 Nav \(part of #3 Epic: Calendar\)/);
  assert.match(prompt, /\[12\.1\] Previous \/ next \/ today buttons/);
  assert.match(prompt, /#13 Empty\n\(empty issue body\)/);
  assert.match(prompt, /no acceptance criteria listed/);
});

test('renderAcceptanceReport asks for a linked issue when there is none', () => {
  assert.match(renderAcceptanceReport([]), /Closes #<issue>/);
});

test('renderAcceptanceReport renders a table with totals and marks unassessed criteria', () => {
  const issues = [withCriterionIds({ number: 12, title: 'Nav | URL', body: BODY })];
  const report = renderAcceptanceReport(issues, [
    { id: '12.1', implemented: 'yes', tested: 'yes', evidence: 'calendar.ts adds the buttons' },
    { id: '12.2', implemented: 'partial', tested: 'n_a', evidence: 'aria-live\nmissing' },
    { id: '99.1', implemented: 'yes', tested: 'yes', evidence: 'hallucinated id is ignored' },
  ]);
  assert.match(report, /\*\*1\/3\*\* implemented, \*\*1\/2\*\* tested/);
  assert.match(report, /#12 Nav \\\| URL/);
  assert.match(
    report,
    /\| 12\.1 \| Previous \/ next \/ today buttons \| ✅ yes \| ✅ yes \| calendar\.ts adds the buttons \|/,
  );
  assert.match(report, /\| 12\.2 \| .* \| 🟡 partly \| ➖ n\/a \| aria-live missing \|/);
  assert.match(report, /\| 12\.3 \| Month in the URL \| ❔ not assessed \| ❔ not assessed \|  \|/);
  assert.doesNotMatch(report, /hallucinated/);
});

test('renderAcceptanceReport mentions issues without criteria', () => {
  const report = renderAcceptanceReport([
    withCriterionIds({ number: 5, title: 'Thing', body: 'just text' }),
  ]);
  assert.match(report, /No acceptance criteria in this issue/);
});

test('acceptanceSummaryLine lists open criteria, or none when everything is done', () => {
  const issues = [withCriterionIds({ number: 1, title: 'x', body: '- [ ] a\n- [ ] b\n- [ ] c' })];
  const done = { implemented: 'yes', tested: 'yes', evidence: '' };
  assert.equal(acceptanceSummaryLine([withCriterionIds({ number: 2, title: 'y', body: '' })]), '');
  assert.match(
    acceptanceSummaryLine(issues, [
      { id: '1.1', ...done },
      { id: '1.2', ...done, tested: 'partial' },
    ]),
    /2 of 3 not fully implemented and tested \(1\.2, 1\.3\)/,
  );
  assert.match(
    acceptanceSummaryLine(issues, [
      { id: '1.1', ...done },
      { id: '1.2', ...done, tested: 'n_a' },
      { id: '1.3', ...done },
    ]),
    /all 3 implemented and tested/,
  );
});
