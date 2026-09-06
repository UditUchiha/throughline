import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { mintEvidenceId } from '../../agent/citations';
import { ToolRegistry } from '../../agent/tools/tool-registry';
import type { AppConfigService } from '../../config/app-config.service';
import type { McpServerConfig } from '../../config/env.schema';
import { McpHostService } from './mcp-host.service';

const DEMO_VAULT = resolve(__dirname, '../../../fixtures/mcp/vault');

function stubConfig(overrides: Partial<AppConfigService> = {}): AppConfigService {
  return {
    demoMode: true,
    mcpServers: [] as McpServerConfig[],
    mcpDemoVaultPath: DEMO_VAULT,
    mcpTimeoutMs: 10_000,
    topK: 5,
    ...overrides,
  } as unknown as AppConfigService;
}

/**
 * The demo connector end to end: a real MCP server, reached through a real MCP
 * client, discovered and called exactly as a live one would be. Everything here
 * runs with no credentials and no network, which is the DEMO_MODE acceptance
 * criterion stated as a test.
 */
describe('McpHostService in demo mode', () => {
  let host: McpHostService;

  afterEach(async () => {
    await host?.onModuleDestroy();
  });

  it('discovers the demo vault tool and registers it under the connector namespace', async () => {
    host = new McpHostService(stubConfig());

    const tools = await host.discoverTools();

    expect(tools.map((tool) => tool.name)).toEqual(['obsidian_search_notes']);
    expect(tools[0].description).toContain('filed as notes');
  });

  it('produces evidence the graph can consume, with namespaced ids', async () => {
    host = new McpHostService(stubConfig());
    const [tool] = await host.discoverTools();

    const chunks = await tool.execute({ query: 'billing migration load test' });

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].source).toBe('notes');
    // The property M5 could most easily have broken: a connector's evidence id
    // must be unreachable from the corpus's integer id space.
    expect(String(chunks[0].chunkId).startsWith('obsidian:')).toBe(true);
    expect(mintEvidenceId(chunks[0].chunkId)).not.toBe(mintEvidenceId(1));
  });

  it('joins the corpus tools in one registry without a node or registry change', async () => {
    host = new McpHostService(stubConfig());
    const discovered = await host.discoverTools();

    // Exactly what agent.module.ts's AGENT_TOOLS factory does.
    const registry = new ToolRegistry([...corpusTools(), ...discovered]);

    expect(registry.names()).toContain('obsidian_search_notes');
    expect(registry.defaultToolName()).toBe('all_sources_search');
    expect(registry.describeForPlanner()).toContain('obsidian_search_notes');
  });

  it('warns rather than silently substituting when DEMO_MODE shadows a configured server', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    host = new McpHostService(
      stubConfig({
        mcpServers: [
          {
            name: 'vault',
            command: 'npx',
            args: [],
            env: {},
            source: 'notes',
            allowTools: ['search'],
          },
        ],
      }),
    );

    const tools = await host.discoverTools();

    // The configured server is not connected and the demo one stands in for it.
    // An operator who set MCP_SERVERS and forgot the flag would otherwise be
    // answered out of synthetic notes with nothing to show a swap had happened.
    expect(tools.map((tool) => tool.name)).toEqual(['obsidian_search_notes']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DEMO_MODE is on'));
    warn.mockRestore();
  });

  it('degrades to corpus-only rather than failing the boot when the vault is missing', async () => {
    host = new McpHostService(
      stubConfig({ mcpDemoVaultPath: resolve(__dirname, 'no-such-vault') }),
    );

    await expect(host.discoverTools()).resolves.toEqual([]);
  });

  it('registers nothing, quietly, when connectors are off and none are configured', async () => {
    host = new McpHostService(stubConfig({ demoMode: false }));

    await expect(host.discoverTools()).resolves.toEqual([]);
  });
});

function corpusTools() {
  return ['mail_search', 'chat_search', 'notes_search', 'all_sources_search'].map((name) => ({
    name,
    description: name,
    inputSchema: { type: 'object' },
    execute: () => Promise.resolve([]),
  }));
}
