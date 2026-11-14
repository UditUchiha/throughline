import type { RunStageId } from '@/lib/run-state';

/** What the run is doing at each stage, in the reader's words rather than the graph's. */
export const STAGE_DOING: Record<RunStageId, string> = {
  triage: 'Deciding how to search',
  plan: 'Splitting the question into parts',
  retrieve: 'Searching mail, chat and notes',
  reflect: 'Checking what is still missing',
  answer: 'Writing the answer',
};
