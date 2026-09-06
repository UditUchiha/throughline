/**
 * Reading an MCP server's declared tool schema, and checking our own arguments
 * against it before we send them.
 *
 * Both halves exist because an MCP server is a stranger. It names its parameters
 * whatever it likes (`query`, `q`, `pattern`), and the failure mode of guessing
 * wrong is not an error — a server handed an unrecognised property typically
 * searches for nothing and returns an empty, successful result. That is
 * indistinguishable from "no matches" at every layer above.
 */

/** Property names a search tool plausibly calls its query. Order is preference. */
const QUERY_CANDIDATES = ['query', 'q', 'search', 'searchQuery', 'search_query', 'text'];

/** Property names a search tool plausibly calls its result cap. */
const TOP_K_CANDIDATES = ['topK', 'top_k', 'limit', 'maxResults', 'max_results', 'count', 'n'];

interface JsonSchemaProperty {
  type?: unknown;
  [key: string]: unknown;
}

export interface ToolSchemaShape {
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  additionalProperties: boolean;
}

/**
 * Reads the subset of JSON Schema an MCP tool's `inputSchema` actually uses.
 *
 * Not a general JSON Schema parser and not trying to be: `$ref`, `oneOf` and
 * friends do not appear in tool input schemas in practice, and a partial
 * implementation of them would be worse than an honest refusal — see
 * {@link validateToolArguments}, which fails closed on anything it cannot read.
 */
export function readToolSchema(inputSchema: unknown): ToolSchemaShape | null {
  if (!isRecord(inputSchema)) return null;
  if (inputSchema.type !== undefined && inputSchema.type !== 'object') return null;

  const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((name): name is string => typeof name === 'string')
    : [];

  const parsed: Record<string, JsonSchemaProperty> = {};
  for (const [name, value] of Object.entries(properties)) {
    parsed[name] = isRecord(value) ? value : {};
  }

  return {
    properties: parsed,
    required,
    // Absent means "allowed" in JSON Schema. We only ever send properties the
    // schema declares, so this only matters for the error message.
    additionalProperties: inputSchema.additionalProperties !== false,
  };
}

/**
 * Which property the search query goes in.
 *
 * The configured `queryArg` wins and is checked rather than trusted — a typo
 * there would otherwise produce a connector that runs, reports success, and
 * finds nothing forever. Failing to resolve returns null, and the caller
 * declines to register the tool: a tool that cannot be called correctly is worse
 * than one that is absent, because the planner will keep choosing it.
 */
export function resolveQueryArg(schema: ToolSchemaShape, configured?: string): string | null {
  if (configured) {
    return schema.properties[configured] ? configured : null;
  }

  for (const candidate of QUERY_CANDIDATES) {
    if (isStringProperty(schema.properties[candidate])) return candidate;
  }

  // Last resort: exactly one required string parameter is unambiguous. Two are
  // not, and picking one at random is how you search a file path for a sentence.
  const requiredStrings = schema.required.filter((name) =>
    isStringProperty(schema.properties[name]),
  );
  return requiredStrings.length === 1 ? requiredStrings[0] : null;
}

/** Which property caps the result count, if the server takes one at all. */
export function resolveTopKArg(schema: ToolSchemaShape): string | null {
  for (const candidate of TOP_K_CANDIDATES) {
    if (isNumberProperty(schema.properties[candidate])) return candidate;
  }
  return null;
}

/**
 * Checks the arguments we are about to send against the server's own schema.
 *
 * PLAN.md §5/M5 requires that tool-call arguments derived from retrieved content
 * be schema-validated and never free-form. The structural half of that guarantee
 * is upstream of here — {@link import('../../agent/tools/agent-tool').AgentTool}
 * only carries `{query, topK}`, so there is no path from a document's text to an
 * arbitrary MCP parameter at all. This is the second half: it proves the two
 * values we *do* send are the ones the server declared, and it fails closed.
 *
 * Deliberately a small explicit checker rather than a JSON Schema library. It
 * covers exactly what MCP search tools declare — object, primitive properties,
 * `required` — and a reader can confirm what it does and does not enforce in one
 * sitting, which matters more for a security gate than breadth does.
 */
export function validateToolArguments(
  args: Record<string, unknown>,
  schema: ToolSchemaShape,
): void {
  for (const [name, value] of Object.entries(args)) {
    const property = schema.properties[name];
    if (!property) {
      throw new Error(`Argument "${name}" is not declared by the tool's input schema`);
    }
    if (!matchesType(value, property.type)) {
      throw new Error(`Argument "${name}" must be ${String(property.type)}, got ${typeof value}`);
    }
  }

  const missing = schema.required.filter((name) => args[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`Missing required argument(s): ${missing.join(', ')}`);
  }
}

function matchesType(value: unknown, type: unknown): boolean {
  // An undeclared type means the schema permits anything there.
  if (typeof type !== 'string') return true;

  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    default:
      return true;
  }
}

function isStringProperty(property: JsonSchemaProperty | undefined): boolean {
  return property !== undefined && (property.type === 'string' || property.type === undefined);
}

function isNumberProperty(property: JsonSchemaProperty | undefined): boolean {
  return property !== undefined && (property.type === 'number' || property.type === 'integer');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
