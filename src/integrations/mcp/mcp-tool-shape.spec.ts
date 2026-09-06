import {
  readToolSchema,
  resolveQueryArg,
  resolveTopKArg,
  validateToolArguments,
  type ToolSchemaShape,
} from './mcp-tool-shape';

function schema(inputSchema: unknown): ToolSchemaShape {
  const parsed = readToolSchema(inputSchema);
  if (!parsed) throw new Error('expected the schema to be readable');
  return parsed;
}

describe('readToolSchema', () => {
  it('reads properties and required from a tool input schema', () => {
    const parsed = schema({
      type: 'object',
      properties: { query: { type: 'string' }, topK: { type: 'number' } },
      required: ['query'],
    });

    expect(Object.keys(parsed.properties)).toEqual(['query', 'topK']);
    expect(parsed.required).toEqual(['query']);
  });

  it('refuses anything that is not an object schema', () => {
    expect(readToolSchema({ type: 'string' })).toBeNull();
    expect(readToolSchema(null)).toBeNull();
    expect(readToolSchema('nonsense')).toBeNull();
  });
});

describe('resolveQueryArg', () => {
  it('prefers a conventional name', () => {
    const parsed = schema({
      type: 'object',
      properties: { query: { type: 'string' }, path: { type: 'string' } },
      required: ['query'],
    });

    expect(resolveQueryArg(parsed)).toBe('query');
  });

  it('accepts a configured name only when the server actually declares it', () => {
    const parsed = schema({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    });

    expect(resolveQueryArg(parsed, 'q')).toBe('q');
    // A typo in config would otherwise produce a connector that connects, reports
    // success and finds nothing for the life of the process.
    expect(resolveQueryArg(parsed, 'querry')).toBeNull();
  });

  it('falls back to a single required string parameter', () => {
    const parsed = schema({
      type: 'object',
      properties: { pattern: { type: 'string' }, caseSensitive: { type: 'boolean' } },
      required: ['pattern'],
    });

    expect(resolveQueryArg(parsed)).toBe('pattern');
  });

  it('refuses to guess between two required strings', () => {
    const parsed = schema({
      type: 'object',
      properties: { pattern: { type: 'string' }, directory: { type: 'string' } },
      required: ['pattern', 'directory'],
    });

    expect(resolveQueryArg(parsed)).toBeNull();
  });
});

describe('resolveTopKArg', () => {
  it('finds a result cap under any of its usual names', () => {
    expect(
      resolveTopKArg(schema({ type: 'object', properties: { limit: { type: 'integer' } } })),
    ).toBe('limit');
  });

  it('reports none when the server takes no cap', () => {
    expect(
      resolveTopKArg(schema({ type: 'object', properties: { query: { type: 'string' } } })),
    ).toBeNull();
  });
});

describe('validateToolArguments', () => {
  const parsed = schema({
    type: 'object',
    properties: { query: { type: 'string' }, topK: { type: 'integer' } },
    required: ['query'],
  });

  it('accepts the arguments the tool actually declares', () => {
    expect(() => validateToolArguments({ query: 'helios', topK: 5 }, parsed)).not.toThrow();
  });

  // PLAN.md §5/M5: arguments must be schema-validated, never free-form. The
  // structural half of that is upstream — AgentTool carries only {query, topK} —
  // and this is the half that fails closed if anything else ever gets here.
  it('rejects an argument the schema never declared', () => {
    expect(() => validateToolArguments({ query: 'x', path: '/etc/passwd' }, parsed)).toThrow(
      'not declared',
    );
  });

  it('rejects an argument of the wrong type', () => {
    expect(() => validateToolArguments({ query: 42 }, parsed)).toThrow('must be string');
  });

  it('rejects a call missing a required argument', () => {
    expect(() => validateToolArguments({ topK: 5 }, parsed)).toThrow('Missing required');
  });
});
