import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServerConfig } from '../../config/env.schema';
import { bindDiscoveredTools } from './mcp-binding';

const SERVER: McpServerConfig = {
  name: 'vault',
  command: '',
  args: [],
  env: {},
  source: 'notes',
  allowTools: ['search_notes', 'search_collection', 'browse'],
};

/**
 * Binding decisions, made against a real server over the real protocol rather
 * than a hand-written schema object — the shapes a server actually publishes
 * (Zod-derived JSON Schema, `additionalProperties`, `$schema`) are part of what
 * is being tested.
 */
async function discover() {
  const server = new McpServer({ name: 'awkward-server', version: '1.0.0' });

  server.registerTool(
    'search_notes',
    {
      description: 'Search notes.',
      inputSchema: { query: z.string(), topK: z.number().optional() },
    },
    () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  );

  // Callable in principle, but not by us: `collection` is required and there is
  // nothing in `AgentToolInput` to put in it.
  server.registerTool(
    'search_collection',
    {
      description: 'Search one collection.',
      inputSchema: { query: z.string(), collection: z.string() },
    },
    () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  );

  // Not a search at all, and allowlisted by mistake — the query-arg resolver is
  // what has to notice, since `path` is a single required string.
  server.registerTool(
    'browse',
    { description: 'Read one note by path.', inputSchema: { path: z.string() } },
    () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  );

  server.registerTool(
    'delete_note',
    { description: 'Delete a note.', inputSchema: { path: z.string() } },
    () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools } = await client.listTools();
  return { client, server, tools };
}

describe('bindDiscoveredTools', () => {
  let harness: Awaited<ReturnType<typeof discover>>;
  let warn: jest.SpyInstance;

  beforeAll(async () => {
    harness = await discover();
  });

  afterAll(async () => {
    await harness.client.close();
    await harness.server.close();
  });

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  function bind(server: McpServerConfig = SERVER) {
    return bindDiscoveredTools(
      harness.client,
      server,
      harness.tools,
      { topK: 5, timeoutMs: 5_000 },
      new Logger('test'),
    );
  }

  // The regression. Resolving a query parameter is not the same as being able to
  // call the tool: `search_collection` would have bound, been offered to the
  // planner, and thrown `Missing required argument(s): collection` on every
  // invocation for the life of the process.
  it('skips a tool whose other required arguments it cannot supply', () => {
    const names = bind().map((tool) => tool.name);

    expect(names).toContain('vault_search_notes');
    expect(names).not.toContain('vault_search_collection');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot supply'));
  });

  it('names the argument it could not supply, so the fix is a config edit', () => {
    bind();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('collection'));
  });

  // `browse` has one required string, so the resolver adopts `path` as the query
  // and it binds. That is the documented last-resort rule working as intended —
  // and the reason `allowTools` is an operator's list rather than a heuristic.
  it('binds a single-required-string tool, which is why the allowlist is manual', () => {
    expect(bind().map((tool) => tool.name)).toContain('vault_browse');
  });

  it('never binds a tool outside the allowlist, whatever its shape', () => {
    expect(bind().map((tool) => tool.name)).not.toContain('vault_delete_note');
  });

  it('registers nothing when the allowlist names only uncallable tools', () => {
    expect(bind({ ...SERVER, allowTools: ['search_collection'] })).toEqual([]);
  });
});
