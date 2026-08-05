import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { ChatMessage } from './chat-message.type';

interface OllamaChatResponse {
  message: { role: string; content: string };
  eval_count?: number;
  eval_duration?: number;
}

@Injectable()
export class OllamaChatService {
  private readonly logger = new Logger(OllamaChatService.name);

  constructor(private readonly config: AppConfigService) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const start = Date.now();
    const res = await fetch(`${this.config.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.chatModel,
        messages,
        stream: false,
        think: false,
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama chat request failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    this.logger.debug(
      `Chat completion in ${Date.now() - start}ms (${data.eval_count ?? '?'} tokens)`,
    );
    return data.message.content;
  }
}
