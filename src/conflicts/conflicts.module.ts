import { Module } from '@nestjs/common';
import { RepositoriesModule } from '../repositories/repositories.module';
import { LlmModule } from '../ai/llm/llm.module';
import { ConflictJudge } from './conflict-judge.service';
import { ConflictScanner } from './conflict-scanner.service';

/**
 * No controller, deliberately.
 *
 * A scan is a batch job costing one model call per document and several minutes
 * of wall clock — an HTTP request is the wrong shape for it, and exposing one on
 * the public instance would hand any visitor the whole corpus's model budget.
 * The entry point is `pnpm scan:conflicts`. When this needs to be reachable over
 * the wire it wants a job queue and a results endpoint, which is a different
 * piece of work from the detection itself.
 */
@Module({
  imports: [RepositoriesModule, LlmModule],
  providers: [ConflictScanner, ConflictJudge],
  exports: [ConflictScanner],
})
export class ConflictsModule {}
