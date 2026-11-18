import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toJsonSchema, validateAgainstSchema } from './llm-schema.mjs';
import { PLAN_SCHEMA } from '../productowner.mjs';
import { VERDICT_SCHEMA as CLEANUP_VERDICT_SCHEMA } from '../productowner-cleanup.mjs';
import { REFINE_SCHEMA, SPLIT_SCHEMA, TRIAGE_SCHEMA } from '../productowner-refine.mjs';
import { REVIEW_SCHEMA, VERDICT_SCHEMA } from '../bullybot.mjs';

test('types become lower case, enums and required stay', () => {
  const out = toJsonSchema({
    type: 'OBJECT',
    properties: {
      a: { type: 'STRING', enum: ['x', 'y'], description: 'letter' },
      b: { type: 'ARRAY', items: { type: 'INTEGER' } },
      c: { type: 'BOOLEAN' },
    },
    required: ['a'],
  });
  assert.deepEqual(out, {
    type: 'object',
    properties: {
      a: { type: 'string', enum: ['x', 'y'], description: 'letter' },
      b: { type: 'array', items: { type: 'integer' } },
      c: { type: 'boolean' },
    },
    additionalProperties: false,
    required: ['a'],
  });
});

test('propertyOrdering decides the order of the properties and is not passed on', () => {
  const out = toJsonSchema({
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING' },
      overlaps: { type: 'ARRAY', items: { type: 'STRING' } },
      size: { type: 'STRING' },
    },
    propertyOrdering: ['overlaps', 'title', 'unknown'],
  });
  assert.deepEqual(Object.keys(out.properties), ['overlaps', 'title', 'size']);
  assert.equal('propertyOrdering' in out, false);
});

test('nullable becomes a union with null, unknown types are refused', () => {
  assert.deepEqual(toJsonSchema({ type: 'STRING', nullable: true }), { type: ['string', 'null'] });
  assert.throws(() => toJsonSchema({ type: 'DATE' }), /Unsupported schema type "DATE"/);
  assert.throws(() => toJsonSchema({}), /Unsupported schema type/);
});

test('every schema the bots use converts to standard JSON Schema', () => {
  const upper = (node) => {
    if (Array.isArray(node)) return node.some(upper);
    if (node && typeof node === 'object')
      return Object.entries(node).some(
        ([k, v]) =>
          (k === 'type' && typeof v === 'string' && v !== v.toLowerCase()) ||
          k === 'propertyOrdering' ||
          upper(v),
      );
    return false;
  };
  for (const schema of [
    PLAN_SCHEMA,
    CLEANUP_VERDICT_SCHEMA,
    REFINE_SCHEMA,
    SPLIT_SCHEMA,
    TRIAGE_SCHEMA,
    REVIEW_SCHEMA,
    VERDICT_SCHEMA,
  ]) {
    const out = toJsonSchema(schema);
    assert.equal(upper(out), false);
    JSON.stringify(out); // can be sent
  }
  // the order the ticket planner relies on survives the conversion
  const ticket = toJsonSchema(PLAN_SCHEMA).properties.tickets.items;
  assert.equal(Object.keys(ticket.properties)[0], 'overlaps');
  const refine = toJsonSchema(REFINE_SCHEMA);
  assert.equal(Object.keys(refine.properties).at(-1), 'explanation');
});

const schema = toJsonSchema({
  type: 'OBJECT',
  properties: {
    verdict: { type: 'STRING', enum: ['fixed', 'open'] },
    line: { type: 'INTEGER' },
    items: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] },
    },
  },
  required: ['verdict'],
});

test('an answer that fits the schema has no problems, extra properties are tolerated', () => {
  assert.deepEqual(
    validateAgainstSchema({ verdict: 'fixed', line: 3, items: [{ name: 'a' }], more: 1 }, schema),
    [],
  );
  assert.deepEqual(validateAgainstSchema({ verdict: 'open' }, schema), []);
});

test('an answer that does not fit says where', () => {
  assert.deepEqual(validateAgainstSchema({}, schema), ['$.verdict is missing']);
  assert.deepEqual(validateAgainstSchema({ verdict: 'maybe' }, schema), [
    '$.verdict should be one of fixed, open',
  ]);
  assert.deepEqual(validateAgainstSchema({ verdict: 'fixed', line: 1.5 }, schema), [
    '$.line should be integer',
  ]);
  assert.deepEqual(validateAgainstSchema({ verdict: 'fixed', items: [{}] }, schema), [
    '$.items[0].name is missing',
  ]);
  assert.deepEqual(validateAgainstSchema({ verdict: 'fixed', items: 'x' }, schema), [
    '$.items should be array',
  ]);
  assert.deepEqual(validateAgainstSchema([], schema), ['$ should be object']);
  assert.deepEqual(validateAgainstSchema(null, schema), ['$ should be object']);
});

test('nullable values are accepted as null', () => {
  const s = toJsonSchema({ type: 'OBJECT', properties: { a: { type: 'STRING', nullable: true } } });
  assert.deepEqual(validateAgainstSchema({ a: null }, s), []);
  assert.deepEqual(validateAgainstSchema({ a: 'x' }, s), []);
  assert.deepEqual(validateAgainstSchema({ a: 3 }, s), ['$.a should be string or null']);
});
