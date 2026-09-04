import { Injectable } from '@nestjs/common';
import type { CorpusSource } from '../../common/types/knowledge.types';
import { RetrievalService } from '../../rag/retrieval.service';
import type { RetrievedChunk } from '../../rag/retrieved-chunk.type';
import type { AgentTool, AgentToolInput } from './agent-tool';

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
 * All four M1 tools are the same retrieval call with a different `sourceFilter`,
 * so they share one base rather than repeating the body four times. The
 * subclasses exist because the *names and descriptions* are the interesting
 * part: they are what the planner reads when choosing where to look.
 */
abstract class SourceSearchTool implements AgentTool {
  readonly inputSchema = INPUT_SCHEMA;

  protected constructor(
    readonly name: string,
    readonly description: string,
    private readonly retrieval: RetrievalService,
    private readonly sourceFilter: CorpusSource[] | undefined,
  ) {}

  execute(input: AgentToolInput): Promise<RetrievedChunk[]> {
    return this.retrieval.search(input.query, input.topK, this.sourceFilter, input.signal);
  }
}

@Injectable()
export class MailSearchTool extends SourceSearchTool {
  constructor(retrieval: RetrievalService) {
    super(
      'mail_search',
      'Search email threads. Best for decisions announced to customers or leadership, ' +
        'formal commitments, external escalations, and anything with a clear sender and recipient.',
      retrieval,
      ['mail'],
    );
  }
}

@Injectable()
export class ChatSearchTool extends SourceSearchTool {
  constructor(retrieval: RetrievalService) {
    super(
      'chat_search',
      'Search team chat channels. Best for in-the-moment discussion, who raised a concern, ' +
        'informal reasoning behind a decision, and day-to-day coordination.',
      retrieval,
      ['chat'],
    );
  }
}

@Injectable()
export class NotesSearchTool extends SourceSearchTool {
  constructor(retrieval: RetrievalService) {
    super(
      'notes_search',
      'Search meeting notes and internal documents. Best for agreed outcomes, action items, ' +
        'plans, retrospectives, and summaries written after the fact.',
      retrieval,
      ['notes'],
    );
  }
}

@Injectable()
export class AllSourcesSearchTool extends SourceSearchTool {
  constructor(retrieval: RetrievalService) {
    super(
      'all_sources_search',
      'Search email, chat and notes together. Use when the question does not point at a ' +
        'particular kind of source, or as a fallback when a targeted search found nothing.',
      retrieval,
      undefined,
    );
  }
}
