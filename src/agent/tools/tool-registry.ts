import { Inject, Injectable } from '@nestjs/common';
import { AGENT_TOOLS, type AgentTool } from './agent-tool';

/**
 * Name → tool lookup for the graph.
 *
 * The planner reads {@link describeForPlanner} and {@link names} at prompt-build
 * time rather than having a hardcoded list, so registering a new tool (including
 * an MCP-backed one in M5) never requires editing a node.
 */
@Injectable()
export class ToolRegistry {
  private readonly byName: Map<string, AgentTool>;

  constructor(@Inject(AGENT_TOOLS) tools: AgentTool[]) {
    this.byName = new Map(tools.map((tool) => [tool.name, tool]));

    if (this.byName.size !== tools.length) {
      // Named, because since M5 the list is partly discovered at runtime: an MCP
      // server called `mail` exposing `search` produces `mail_search`, which is
      // already a corpus tool. Knowing *which* name collided is the difference
      // between a one-line config fix and a hunt.
      const seen = new Set<string>();
      const duplicates = tools.map((tool) => tool.name).filter((name) => !seen.add(name));
      throw new Error(
        `Duplicate agent tool name registered: ${[...new Set(duplicates)].join(', ')}`,
      );
    }
  }

  get(name: string): AgentTool | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  list(): AgentTool[] {
    return [...this.byName.values()];
  }

  /** The tool menu as the planner sees it. */
  describeForPlanner(): string {
    return this.list()
      .map((tool) => `- ${tool.name}: ${tool.description}`)
      .join('\n');
  }

  /**
   * The tool every fallback path uses: triage's single-shot retrieval and any
   * sub-question the planner assigned to a tool that does not exist.
   */
  defaultToolName(): string {
    return this.has('all_sources_search') ? 'all_sources_search' : this.names()[0];
  }
}
