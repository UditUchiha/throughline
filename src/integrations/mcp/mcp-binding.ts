import type { Logger } from '@nestjs/common';
import type { Client } from '@modelcontextprotocol/sdk/client';
import type { AgentTool } from '../../agent/tools/agent-tool';
import type { McpServerConfig } from '../../config/env.schema';
import { McpSearchTool, type McpToolBinding } from './mcp-search.tool';
import { readToolSchema, resolveQueryArg, resolveTopKArg } from './mcp-tool-shape';

/** One entry of a server's `tools/list` response, as much of it as we read. */
export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface BindOptions {
  topK: number;
  timeoutMs: number;
}

/**
 * Decides which of a server's advertised tools the agent may call, and works out
 * how to call each survivor.
 *
 * Split out of `McpHostService` because this is the security-relevant half of
 * discovery and it should be testable against a real MCP server without
 * spawning a child process. The host owns transports and lifetimes; this owns
 * the rules.
 *
 * **Discovery is not consent.** A server advertises whatever it likes — an
 * Obsidian server that can search your vault can usually also write to it — so
 * nothing is registered unless the operator named it in `allowTools`. That is
 * the first of M5's two injection defences, and the one that holds even if every
 * model in the graph is fully persuaded by a malicious document: a tool that was
 * never registered cannot be selected, because `ToolRegistry` has no entry for
 * it and `plan`/`reflect` normalise an unknown name to the default search.
 */
export function bindDiscoveredTools(
  client: Client,
  server: McpServerConfig,
  discovered: DiscoveredTool[],
  options: BindOptions,
  logger: Logger,
): AgentTool[] {
  const allowed = new Set(server.allowTools);

  const skipped = discovered.filter((tool) => !allowed.has(tool.name)).map((tool) => tool.name);
  if (skipped.length > 0) {
    logger.log(
      `MCP server "${server.name}" also exposes ${skipped.join(', ')} — not in allowTools, ignored`,
    );
  }

  const missing = server.allowTools.filter(
    (name) => !discovered.some((tool) => tool.name === name),
  );
  if (missing.length > 0) {
    logger.warn(
      `MCP server "${server.name}" does not expose allowlisted tool(s): ${missing.join(', ')}`,
    );
  }

  const bound: AgentTool[] = [];

  for (const tool of discovered) {
    if (!allowed.has(tool.name)) continue;

    const schema = readToolSchema(tool.inputSchema);
    if (!schema) {
      logger.warn(
        `Tool "${tool.name}" on "${server.name}" has an input schema this host cannot read; skipped`,
      );
      continue;
    }

    const queryArg = resolveQueryArg(schema, server.queryArg);
    if (!queryArg) {
      // Registering it anyway would be worse than dropping it: the planner would
      // go on choosing a tool that silently searches for nothing, and an empty
      // result is indistinguishable from a genuine miss.
      logger.warn(
        `Tool "${tool.name}" on "${server.name}" has no identifiable query parameter; skipped. ` +
          'Set queryArg on that server to name it explicitly.',
      );
      continue;
    }

    const topKArg = resolveTopKArg(schema);

    // Resolving a query parameter is not the same as being able to call the
    // tool. A search that also requires a vault, a collection or a `since` would
    // bind here and then throw `Missing required argument(s)` on every single
    // invocation — `AgentTool` carries a query and a result cap and has nothing
    // else to offer. Same reasoning as the skip above: the planner keeps
    // choosing a tool that is in the menu, so an uncallable one is worse than an
    // absent one.
    const supplied = new Set([queryArg, ...(topKArg ? [topKArg] : [])]);
    const unmet = schema.required.filter((name) => !supplied.has(name));
    if (unmet.length > 0) {
      logger.warn(
        `Tool "${tool.name}" on "${server.name}" requires argument(s) this host cannot supply: ` +
          `${unmet.join(', ')}; skipped.`,
      );
      continue;
    }

    const binding: McpToolBinding = {
      client,
      serverName: server.name,
      remoteToolName: tool.name,
      description: describeForPlanner(tool.description, server),
      schema,
      queryArg,
      topKArg,
      source: server.source,
      topK: options.topK,
      timeoutMs: options.timeoutMs,
    };

    bound.push(new McpSearchTool(binding));
  }

  return bound;
}

/**
 * What the planner reads when choosing this tool.
 *
 * The server's own description leads, because it is the only thing that knows
 * what the tool searches. The source is appended because the planner is asked to
 * pick the target most likely to hold the evidence, and "this returns notes" is
 * exactly that judgement — without it a connector reads as a fourth unrelated
 * thing rather than as another way into a source the planner already reasons
 * about.
 */
function describeForPlanner(description: string | undefined, server: McpServerConfig): string {
  const own = description?.trim() || `Search the ${server.name} connector.`;
  return `${own} Live connector; results are filed as ${server.source}.`;
}
