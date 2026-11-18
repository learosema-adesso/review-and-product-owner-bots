/**
 * The bots describe the answer they want in the schema dialect of Gemini (upper-case types,
 * `propertyOrdering`). Other providers speak standard JSON Schema. This module converts between
 * the two and checks an answer against the result.
 */

const TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean']);

/** Converts a Gemini-style schema to standard JSON Schema. */
export function toJsonSchema(schema) {
  const type = String(schema?.type ?? '').toLowerCase();
  if (!TYPES.has(type)) throw new Error(`Unsupported schema type "${schema?.type}"`);

  const out = { type: schema.nullable ? [type, 'null'] : type };
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.nullable ? [...schema.enum, null] : [...schema.enum];

  if (schema.properties) {
    // The order of the properties is the order in which a model writes them: keep it, because the
    // prompts rely on it (e.g. the overlap check before the ticket, the explanation last)
    const names = Object.keys(schema.properties);
    const ordered = [
      ...(schema.propertyOrdering ?? []).filter((n) => names.includes(n)),
      ...names.filter((n) => !(schema.propertyOrdering ?? []).includes(n)),
    ];
    out.properties = Object.fromEntries(
      ordered.map((n) => [n, toJsonSchema(schema.properties[n])]),
    );
    out.additionalProperties = false;
  }
  if (schema.required) out.required = [...schema.required];
  if (schema.items) out.items = toJsonSchema(schema.items);
  return out;
}

const matchesType = (value, type) => {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object')
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
};

/**
 * Checks a value against a standard JSON Schema (the subset the bots use: type, enum, properties,
 * required, items). Returns the problems, an empty list means the value is fine. Properties the
 * schema does not know are tolerated: they are harmless and not worth a second request.
 */
export function validateAgainstSchema(value, schema, path = '$') {
  const types = [].concat(schema.type ?? []);
  if (types.length && !types.some((t) => matchesType(value, t)))
    return [`${path} should be ${types.join(' or ')}`];
  if (schema.enum && !schema.enum.includes(value))
    return [`${path} should be one of ${schema.enum.join(', ')}`];

  const problems = [];
  if (matchesType(value, 'object')) {
    for (const name of schema.required ?? [])
      if (value[name] === undefined) problems.push(`${path}.${name} is missing`);
    for (const [name, sub] of Object.entries(schema.properties ?? {}))
      if (value[name] !== undefined)
        problems.push(...validateAgainstSchema(value[name], sub, `${path}.${name}`));
  }
  if (Array.isArray(value) && schema.items)
    value.forEach((item, i) =>
      problems.push(...validateAgainstSchema(item, schema.items, `${path}[${i}]`)),
    );
  return problems;
}
