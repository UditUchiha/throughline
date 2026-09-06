import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { McpModule } from '../integrations/mcp/mcp.module';
import { McpHostService } from '../integrations/mcp/mcp-host.service';
import { MemoryModule } from '../memory/memory.module';
import { RagModule } from '../rag/rag.module';
import { ObservabilityModule } from '../observability/observability.module';
import { RepositoriesModule } from '../repositories/repositories.module';
import { AgentController } from './agent.controller';
import { AgentGraphService } from './agent-graph.service';
import { agentCheckpointerProvider } from './checkpointing/agent-checkpointer';
import { RunReplayService } from './replay/run-replay.service';
import { ExampleQuestionsService } from './examples/example-questions.service';
import { ExecuteNode } from './nodes/execute.node';
import { PlanNode } from './nodes/plan.node';
import { RecallNode } from './nodes/recall.node';
import { RememberNode } from './nodes/remember.node';
import { ReflectNode } from './nodes/reflect.node';
import { SynthesizeNode } from './nodes/synthesize.node';
import { TriageNode } from './nodes/triage.node';
import { AGENT_TOOLS, type AgentTool } from './tools/agent-tool';
import {
  AllSourcesSearchTool,
  ChatSearchTool,
  MailSearchTool,
  NotesSearchTool,
} from './tools/source-search.tool';
import { ToolRegistry } from './tools/tool-registry';

@Module({
  imports: [
    ConfigModule,
    AiModule,
    RagModule,
    ObservabilityModule,
    RepositoriesModule,
    MemoryModule,
    McpModule,
    // Imported directly, and only for `agentCheckpointerProvider`: the LangGraph
    // checkpointer takes the live connection rather than opening its own. See
    // that provider for why it is not a repository port.
    DatabaseModule,
  ],
  controllers: [AgentController],
  providers: [
    RunReplayService,
    ExampleQuestionsService,
    MailSearchTool,
    ChatSearchTool,
    NotesSearchTool,
    AllSourcesSearchTool,
    {
      // The registry takes the tool list by injection rather than importing the
      // classes itself, so a tool joins the agent by being added here — no node
      // and no registry change.
      //
      // M5 made this factory async, and that is the only structural change the
      // milestone needed on the agent side. Corpus tools are known at compile
      // time and arrive through `inject`; MCP tools are not known until a server
      // has been asked what it has, so the host is injected and awaited. Nest
      // resolves a promise-returning `useFactory` before anything downstream is
      // constructed, which is what lets `ToolRegistry` keep building its map once,
      // in its constructor, from a list that is complete by then.
      provide: AGENT_TOOLS,
      useFactory: async (mcp: McpHostService, ...tools: AgentTool[]) => [
        ...tools,
        ...(await mcp.discoverTools()),
      ],
      inject: [
        McpHostService,
        MailSearchTool,
        ChatSearchTool,
        NotesSearchTool,
        AllSourcesSearchTool,
      ],
    },
    ToolRegistry,
    agentCheckpointerProvider,
    RecallNode,
    TriageNode,
    PlanNode,
    ExecuteNode,
    ReflectNode,
    SynthesizeNode,
    RememberNode,
    AgentGraphService,
  ],
  exports: [AgentGraphService, ToolRegistry],
})
export class AgentModule {}
