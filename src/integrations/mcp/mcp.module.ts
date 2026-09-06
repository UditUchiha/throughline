import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { McpHostService } from './mcp-host.service';

/**
 * The MCP client host. Depends on nothing but config — it produces
 * {@link import('../../agent/tools/agent-tool').AgentTool}s and knows nothing
 * about the graph that will run them.
 */
@Module({
  imports: [ConfigModule],
  providers: [McpHostService],
  exports: [McpHostService],
})
export class McpModule {}
