import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentTool } from '../../agent/tools/agent-tool';
import type { CorpusSource } from '../../common/types/knowledge.types';
import { AppConfigService } from '../../config/app-config.service';
import type { McpServerConfig } from '../../config/env.schema';
import { bindDiscoveredTools } from './mcp-binding';
import {
  createDemoVaultServer,
  DEMO_VAULT_TOOL_NAME,
  loadVault,
} from './demo/obsidian-demo.server';

/** Identity this client presents to every server it connects to. */
const CLIENT_INFO = { name: 'throughline', version: '1.0.0' };

/** The demo connector's registry prefix and `evidenceId` namespace. */
const DEMO_VAULT_NAME = 'obsidian';
const DEMO_VAULT_SOURCE: CorpusSource = 'notes';

interface Connection {
  name: string;
  client: Client;
  /** Set only for in-process demo servers; a stdio server closes with its transport. */
  server?: McpServer;
}

/**
 * The MCP client host (PLAN.md §5/M5).
 *
 * Connects to the configured servers, asks each what it can do, and hands back
 * plain {@link AgentTool}s. Nothing above this service knows MCP exists — that is
 * the payoff of M1's uniform tool shape, and the reason `src/agent/nodes/` is
 * untouched by this milestone.
 *
 * Three decisions worth knowing before changing it:
 *
 * - **Discovery is boot-time only.** `ToolRegistry` builds its map in its
 *   constructor and the planner reads a stable menu; a server that is down when
 *   the API starts is skipped for the life of the process rather than appearing
 *   later. Making the registry mutable would be an abstraction with one caller
 *   (PLAN.md §0.4), and the problem it would solve — an operator restarting a
 *   local MCP server — is already solved by restarting the API.
 * - **A failed connection is a warning, not a boot failure.** The corpus tools
 *   are unaffected, and an agent answering from three sources instead of four is
 *   better than an API that will not start.
 * - **DEMO_MODE swaps the transport and the data, not the code path.** The demo
 *   connector is a real MCP server reached through the real client, so discovery,
 *   argument validation and result adaptation are all exercised by the deployed
 *   demo rather than bypassed by it.
 */
@Injectable()
export class McpHostService implements OnModuleDestroy {
  private readonly logger = new Logger(McpHostService.name);
  private readonly connections: Connection[] = [];

  constructor(private readonly config: AppConfigService) {}

  /**
   * Connects every configured server and returns the tools they expose.
   *
   * Called once, by the `AGENT_TOOLS` factory in `agent.module.ts`. That factory
   * is async purely because this is — a Nest `useFactory` may return a promise
   * and the module waits, which is what lets a runtime-discovered tool reach a
   * registry otherwise built from a static `inject` array.
   */
  async discoverTools(): Promise<AgentTool[]> {
    if (this.config.demoMode) {
      const ignored = this.config.mcpServers;
      if (ignored.length > 0) {
        // Silence here would be the expensive kind: an operator who configured a
        // live vault and forgot the flag would be answered out of synthetic notes
        // with nothing to indicate a substitution had happened.
        this.logger.warn(
          `DEMO_MODE is on — ignoring ${ignored.length} configured MCP server(s): ` +
            `${ignored.map((server) => server.name).join(', ')}. Set DEMO_MODE=false to connect them.`,
        );
      }
      return this.connectDemoConnectors();
    }

    const servers = this.config.mcpServers;
    if (servers.length === 0) {
      this.logger.log('No MCP servers configured; the agent runs on corpus tools only');
      return [];
    }

    const discovered = await Promise.all(servers.map((server) => this.connectLive(server)));
    return discovered.flat();
  }

  async onModuleDestroy(): Promise<void> {
    // Closing the client closes its transport, and for a stdio transport that
    // kills the child process. Skipping it leaks one process per dev-server
    // reload, which is only noticeable once there are twenty of them.
    for (const connection of this.connections) {
      try {
        await connection.client.close();
        await connection.server?.close();
      } catch (error) {
        this.logger.warn(`Failed to close MCP connection "${connection.name}": ${message(error)}`);
      }
    }
    this.connections.length = 0;
  }

  /**
   * The synthetic connectors DEMO_MODE serves.
   *
   * One today. Gmail and Slack each get a counterpart here when their live
   * connector lands (PLAN.md §5/M5 orders them Obsidian → Gmail → Slack), which
   * is why this returns a list rather than a single tool.
   *
   * Everything is inside the guard, not just the vault load. `discoverTools` is
   * awaited by the `AGENT_TOOLS` factory, so anything thrown here rejects that
   * factory and takes the whole boot with it — and this is the *default* path,
   * so it was the more exercised of the two and the less protected. Degrading to
   * corpus-only is the same choice `connectLive` already makes.
   */
  private async connectDemoConnectors(): Promise<AgentTool[]> {
    const vaultPath = this.config.mcpDemoVaultPath;

    try {
      const notes = loadVault(vaultPath);
      if (notes.length === 0) {
        this.logger.warn(`Demo vault at ${vaultPath} is empty; the connector will find nothing`);
      }
      const server = createDemoVaultServer(notes);
      this.logger.log(`Demo vault loaded: ${notes.length} note(s) from ${vaultPath}`);

      const config: McpServerConfig = {
        name: DEMO_VAULT_NAME,
        command: '',
        args: [],
        env: {},
        source: DEMO_VAULT_SOURCE,
        allowTools: [DEMO_VAULT_TOOL_NAME],
      };

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client(CLIENT_INFO, { capabilities: {} });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      // Registered before binding, so a failure below still gets its transport
      // closed on shutdown rather than leaking the pair.
      this.connections.push({ name: DEMO_VAULT_NAME, client, server });

      const tools = await this.bind(client, config);
      this.logger.log(`Demo connector "${DEMO_VAULT_NAME}" registered ${tools.length} tool(s)`);
      return tools;
    } catch (error) {
      this.logger.error(`Demo connector unavailable: ${message(error)}`);
      return [];
    }
  }

  private async connectLive(server: McpServerConfig): Promise<AgentTool[]> {
    try {
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args,
        // Merged over the inherited environment rather than replacing it: a server
        // launched through `npx` needs PATH, HOME and friends to start at all.
        env: { ...cleanEnvironment(process.env), ...server.env },
      });

      const client = new Client(CLIENT_INFO, { capabilities: {} });
      await withTimeout(
        client.connect(transport),
        this.config.mcpTimeoutMs,
        `connect to MCP server "${server.name}"`,
      );
      this.connections.push({ name: server.name, client });

      const tools = await this.bind(client, server);
      this.logger.log(`MCP server "${server.name}" connected; registered ${tools.length} tool(s)`);
      return tools;
    } catch (error) {
      this.logger.error(`MCP server "${server.name}" unavailable: ${message(error)}`);
      return [];
    }
  }

  private async bind(client: Client, server: McpServerConfig): Promise<AgentTool[]> {
    const { tools } = await withTimeout(
      client.listTools(),
      this.config.mcpTimeoutMs,
      `list tools on MCP server "${server.name}"`,
    );

    return bindDiscoveredTools(
      client,
      server,
      tools,
      { topK: this.config.topK, timeoutMs: this.config.mcpTimeoutMs },
      this.logger,
    );
  }
}

/**
 * `process.env` is `Record<string, string | undefined>` and the transport wants
 * `Record<string, string>`. Dropping the undefined entries rather than coercing
 * them keeps an unset variable unset in the child, instead of setting it to the
 * string "undefined".
 */
function cleanEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) cleaned[key] = value;
  }
  return cleaned;
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms trying to ${what}`)), ms);
  });

  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
