import { Gauge, ListTree, Quote, RefreshCcw, ScanSearch, type LucideIcon } from 'lucide-react';
import type { RunStageId } from '@/lib/run-state';

/**
 * One vocabulary for the five stages, shared by the landing page's explainer and
 * the live progress strip — so the icon a visitor learns before asking is the
 * one that lights up while the run happens.
 */
export const STAGE_META: Record<
  RunStageId,
  { label: string; doing: string; icon: LucideIcon; blurb: string }
> = {
  triage: {
    label: 'Triage',
    doing: 'Triaging',
    icon: Gauge,
    blurb: 'One search, or several? A simple question skips planning entirely.',
  },
  plan: {
    label: 'Plan',
    doing: 'Planning',
    icon: ListTree,
    blurb: 'Decompose into sub-questions, each routed to the source likely to hold it.',
  },
  retrieve: {
    label: 'Retrieve',
    doing: 'Retrieving',
    icon: ScanSearch,
    blurb: 'Search mail, chat and notes in parallel.',
  },
  reflect: {
    label: 'Reflect',
    doing: 'Reflecting',
    icon: RefreshCcw,
    blurb: 'Notice what is still missing, and go back for it.',
  },
  answer: {
    label: 'Answer',
    doing: 'Writing the answer',
    icon: Quote,
    blurb: 'Cite the passage behind every claim — or decline when nothing supports one.',
  },
};
