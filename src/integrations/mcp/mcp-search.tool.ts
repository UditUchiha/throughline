import { Logger } from '@nestjs/common';
import type { Client } from '@modelcontextprotocol/sdk/client';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CorpusSource } from '../../common/types/knowledge.types';
import type { AgentTool, AgentToolInput } from '../../agent/tools/agent-tool';
import type { RetrievedChunk } from '../../rag/retrieved-chunk.type';
import { toRetrievedChunks } from './mcp-results';
import { validateToolArguments, type ToolSchemaShape } from './mcp-tool-shape';

/**
 * Everything the host worked out about one remote tool at discovery time.
 * Resolved once, at boot, so a search costs no schema inspection.
 */
export interface McpToolBinding {
  client: Client;
  /** Configured server name — tool-name prefix and `evidenceId` namespace. */
  serverName: string;
  /** The tool's name on the server, which is not the name the planner sees. */
  remoteToolName: string;
  description: string;
  schema: ToolSchemaShape;
  queryArg: string;
  topKArg: string | null;
  source: CorpusSource;
  topK: number;
  timeoutMs: number;
}

/**
 * The JSON Schema handed to the planner. Identical to the one the four corpus
 * tools publish, and that is the point: `AgentTool.inputSchema` describes
 * {@link AgentToolInput}, not the remote tool's parameters. The planner chooses
 * a *name* and writes a *question*; it never composes arguments for anything.
 */
const INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Natural-language search query, phrased as the information being sought.',
    },
  },
  required: ['query'],
  additionalProperties: false,
};

/**
 * One discovered MCP tool, wearing the uniform {@link AgentTool} shape.
 *
 * This class is the whole of M5's claim: the graph cannot tell it apart from
 * `MailSearchTool`. It is constructed by `McpHostService` rather than by Nest,
 * because the set of tools is not known until a server has been asked what it
 * has — but it is still built inside an `@Injectable()`, never at module scope
 * (PLAN.md §0.3).
 *
 * The narrowing from `AgentToolInput` to the server's parameters happens here
 * and nowhere else, and it is deliberately lossy: a query string and a result
 * cap go out, and nothing else can. There is no code path by which retrieved
 * text becomes an MCP argument, which is what makes the prompt-injection
 * guarantee structural rather than a matter of the model behaving.
 */
export class McpSearchTool implements AgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema = INPUT_SCHEMA;

  private readonly logger = new Logger(McpSearchTool.name);

  constructor(private readonly binding: McpToolBinding) {
    // Prefixed with the server, so two connectors exposing `search` do not
    // collide in the registry — which throws on duplicate names by design.
    this.name = `${binding.serverName}_${binding.remoteToolName}`;
    this.description = binding.description;
  }

  async execute(input: AgentToolInput): Promise<RetrievedChunk[]> {
    const topK = input.topK ?? this.binding.topK;
    const args: Record<string, unknown> = { [this.binding.queryArg]: input.query };
    if (this.binding.topKArg) args[this.binding.topKArg] = topK;

    // Checked against what the server declared, not against what we assume. A
    // mismatch here is a misconfiguration that would otherwise present as a
    // connector that always finds nothing.
    validateToolArguments(args, this.binding.schema);

    const result = await this.binding.client.callTool(
      { name: this.binding.remoteToolName, arguments: args },
      // Named explicitly so the return type is the modern result shape rather
      // than a union with the pre-2024 `toolResult` one, which has no `content`.
      CallToolResultSchema,
      {
        // The run's deadline travels with the call, so a hung server cannot
        // outlive AGENT_TIMEOUT_MS. The timeout is the per-call backstop for the
        // case where there is no signal at all.
        signal: input.signal,
        timeout: this.binding.timeoutMs,
      },
    );

    const chunks = toRetrievedChunks(result, {
      namespace: this.binding.serverName,
      source: this.binding.source,
      topK,
    });

    this.logger.debug(`${this.name} returned ${chunks.length} passage(s)`);
    return chunks;
  }
}
