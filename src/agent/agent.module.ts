import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ConfigModule } from '../config/config.module';
import { RagModule } from '../rag/rag.module';
import { ObservabilityModule } from '../observability/observability.module';
import { RepositoriesModule } from '../repositories/repositories.module';
import { AgentController } from './agent.controller';
import { AgentGraphService } from './agent-graph.service';
import { RunReplayService } from './replay/run-replay.service';
import { ExampleQuestionsService } from './examples/example-questions.service';
import { ExecuteNode } from './nodes/execute.node';
import { PlanNode } from './nodes/plan.node';
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
  imports: [ConfigModule, AiModule, RagModule, ObservabilityModule, RepositoriesModule],
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
      // classes itself, so an M5 MCP-backed tool joins the agent by being added
      // here — no node and no registry change.
      provide: AGENT_TOOLS,
      useFactory: (...tools: AgentTool[]) => tools,
      inject: [MailSearchTool, ChatSearchTool, NotesSearchTool, AllSourcesSearchTool],
    },
    ToolRegistry,
    TriageNode,
    PlanNode,
    ExecuteNode,
    ReflectNode,
    SynthesizeNode,
    AgentGraphService,
  ],
  exports: [AgentGraphService, ToolRegistry],
})
export class AgentModule {}
