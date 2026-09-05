import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { load as parseYaml } from 'js-yaml';
import { AppConfigService } from '../../config/app-config.service';
import {
  ledgerQuestionSchema,
  questionsFileSchema,
  type ExampleQuestion,
} from './example-question';

/**
 * Serves the authored question set as the UI's one-click examples.
 *
 * PLAN.md §5/M2 calls this "not optional, and not cosmetic": it is the whole
 * answer to "a visitor won't know what to ask", and it is why bring-your-own-data
 * upload is not needed to make the demo usable (§12.1).
 *
 * It exists as an endpoint rather than a file the UI reads because the UI ships
 * to Vercel and the API to HF Spaces — the corpus is only on the API's disk. The
 * projection to {@link ExampleQuestion} is the load-bearing part: the ledger row
 * also carries `referenceAnswer` and `requiredFacts`, and those must not leave
 * the server.
 */
@Injectable()
export class ExampleQuestionsService {
  private readonly logger = new Logger(ExampleQuestionsService.name);
  private questions: ExampleQuestion[] = [];
  /** mtime of the file as loaded; a change means someone edited the ledger. */
  private loadedStamp = -1;
  /** Whether the "no question set" warning has already been logged for this absence. */
  private warnedMissing = false;

  constructor(private readonly config: AppConfigService) {
    this.refresh();
  }

  list(): ExampleQuestion[] {
    this.refresh();
    return this.questions;
  }

  /**
   * Re-reads when the file's mtime moves. The `/add-fact` skill and its
   * `PostToolUse` hook edit this file during a dev session, and `nest start
   * --watch` watches `src/`, not `corpus/` — the same staleness trap
   * `RunReplayService` documents.
   */
  private refresh(): void {
    const path = this.config.corpusQuestionsPath;

    if (!existsSync(path)) {
      // Once per absence, not once per request: `list()` refreshes on every call,
      // so an unconditional warn here is one log line per page load.
      if (!this.warnedMissing) {
        this.logger.warn(`No question set at "${path}" — GET /agent/examples will be empty`);
        this.warnedMissing = true;
      }
      this.questions = [];
      this.loadedStamp = -1;
      return;
    }
    this.warnedMissing = false;

    const stamp = statSync(path).mtimeMs;
    if (stamp === this.loadedStamp) return;

    try {
      const file = questionsFileSchema.parse(parseYaml(readFileSync(path, 'utf8')));
      this.questions = this.projectRows(file.questions, path);
      this.loadedStamp = stamp;
      this.logger.log(`Loaded ${this.questions.length} example question(s) from ${path}`);
    } catch (error) {
      // A malformed ledger must not take the whole API down at boot — the agent
      // itself does not depend on this file.
      this.logger.error(
        `Could not read "${path}": ${error instanceof Error ? error.message : error}`,
      );
      this.questions = [];
      this.loadedStamp = stamp;
    }
  }

  /**
   * Validates row by row rather than as one array.
   *
   * A single `parse` over the whole list means one unparseable question empties
   * the endpoint — and the endpoint is the UI's entire entry point, since a
   * visitor cannot invent a question this corpus answers. `/add-fact` edits this
   * file, and a new category or source value is exactly the kind of edit that
   * would otherwise take all 56 questions down with it.
   */
  private projectRows(rows: unknown[], path: string): ExampleQuestion[] {
    const projected: ExampleQuestion[] = [];
    const skipped: string[] = [];

    for (const [index, row] of rows.entries()) {
      const result = ledgerQuestionSchema.safeParse(row);
      if (!result.success) {
        const id = describeRow(row) ?? `#${index}`;
        skipped.push(`${id} (${result.error.issues.map((issue) => issue.message).join('; ')})`);
        continue;
      }

      const q = result.data;
      projected.push({
        id: q.id,
        question: q.question,
        category: q.category,
        requiredSources: q.requiredSources,
        minHops: q.minHops,
        expectedAbstention: q.expectedAbstention,
      });
    }

    if (skipped.length > 0) {
      this.logger.warn(`Skipped ${skipped.length} question(s) in "${path}": ${skipped.join(', ')}`);
    }

    return projected;
  }
}

/** The row's id if it has a usable one, for a log line that names what was skipped. */
function describeRow(row: unknown): string | null {
  if (typeof row !== 'object' || row === null) return null;
  const { id } = row as { id?: unknown };
  return typeof id === 'string' && id.length > 0 ? id : null;
}
