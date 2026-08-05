import { Module } from '@nestjs/common';
import { OllamaChatService } from './ollama-chat.service';

@Module({
  providers: [OllamaChatService],
  exports: [OllamaChatService],
})
export class LlmModule {}
