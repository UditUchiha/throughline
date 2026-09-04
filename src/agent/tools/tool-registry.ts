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
      throw new Error('Duplicate agent tool name registered');
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
