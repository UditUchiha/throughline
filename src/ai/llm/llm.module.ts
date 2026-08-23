import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { LLM_SERVICE } from './llm.constants';
import { OpenAICompatibleProvider } from './openai-compatible.provider';

@Module({
  imports: [ConfigModule],
  providers: [{ provide: LLM_SERVICE, useClass: OpenAICompatibleProvider }],
  exports: [LLM_SERVICE],
})
export class LlmModule {}
