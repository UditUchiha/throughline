import type { EvalMode } from '../types';

/**
 * Everything one invocation of `pnpm eval` was asked to do.
 *
 * The flags exist for one reason above all others: **a full comparison run is
 * roughly 470 model calls against a free tier of ~20 per window.** That is not a
 * footnote, it is the design constraint. `--only`, `--category`, `--subset` and
 * `--limit` narrow the work; the per-question cache means a killed run resumes
 * instead of restarting; `--no-judge` re-scores everything deterministically for
 * free. Without those, the suite is a thing you can run once and then cannot
 * afford to run again — which is the same as not having one.
 */
export interface EvalOptions {
  mode: EvalMode;
  /** Question ids to run. Empty means "everything the other filters allow". */
  only: string[];
  category: string | null;
  subset: 'full' | 'pr';
  limit: number | null;
  /** Ignore cached per-question results and re-run everything selected. */
  fresh: boolean;
  /** Skip the judge entirely — deterministic metrics only, and no model calls. */
  judge: boolean;
  /**
   * `reset` clears the long-term memory store between questions; `accumulate`
   * leaves it. See `evals/README.md` — this is the decision that keeps the suite
   * reproducible, and it costs a real property of the funnel numbers.
   */
  memory: 'reset' | 'accumulate';
  /**
   * Register MCP connectors. Off by default: the connector serves a synthetic
   * vault the answer key does not cover, so a question answered correctly out of
   * the vault would score as unsupported.
   */
  connectors: boolean;
  /** Send eval traffic to LangSmith. Off by default — 59 runs is a lot of noise. */
  trace: boolean;
  /** Questions in flight at once. One, because quota is the binding constraint. */
  concurrency: number;
  /**
   * Where the results are written. Defaults to a file that matches how much of
   * the suite actually ran — see {@link defaultOutFor}.
   */
  out: string;
  /**
   * Database the suite runs against. Defaults to a copy of the live one, so eval
   * traffic never lands in `runs`, `run_spans` or `memory_facts` — §9 bakes
   * `database/app.db` into the deployed image.
   */
  database: string;
}

const FULL_RESULTS = './evals/results-latest.json';

const DEFAULTS: EvalOptions = {
  mode: 'agent',
  only: [],
  category: null,
  subset: 'full',
  limit: null,
  fresh: false,
  judge: true,
  memory: 'reset',
  connectors: false,
  trace: false,
  concurrency: 1,
  out: FULL_RESULTS,
  database: './database/evals.db',
};

/**
 * The results file a selection writes to when `--out` is not given.
 *
 * `writeResults` merges by mode but replaces a mode wholesale, so a narrowed run
 * that defaulted to `results-latest.json` would overwrite the 59-question agent
 * numbers — the ones the README cites and `baseline.json` was recorded from —
 * with nine questions, or with one. That is not hypothetical: `pnpm eval
 * --subset=pr` is the command printed in CLAUDE.md, README.md and
 * evals/README.md, and it did exactly that. The comparison guards downstream
 * refuse to *report* a mismatched subset, which is a different thing from not
 * destroying the data.
 *
 * Only a full pass may write the canonical file. Everything narrower gets a
 * destination that says what it is, and `--out` still overrides all of it.
 */
function defaultOutFor(options: EvalOptions): string {
  if (options.subset === 'pr') return './evals/results-pr-subset.json';
  const narrowed = options.category !== null || options.only.length > 0 || options.limit !== null;
  return narrowed ? './evals/results-partial.json' : FULL_RESULTS;
}

export const EVAL_USAGE = `
pnpm eval [flags]

  --baseline=single-shot   Run the non-agentic control instead of the agent
  --only=<id>[,<id>]       Run just these question ids
  --category=<name>        Run one category (single-hop, multi-hop, temporal,
                           distractor, unanswerable, adversarial)
  --subset=pr              Run the committed CI subset (9 questions)
  --limit=<n>              Stop after n questions
  --fresh                  Ignore cached per-question results
  --no-judge               Deterministic metrics only; makes no model calls
  --memory=accumulate      Do not clear long-term memory between questions
  --connectors             Register MCP connectors (off by default — see README)
  --trace                  Send eval runs to LangSmith
  --concurrency=<n>        Questions in flight (default 1; raise at your quota's peril)
  --out=<path>             Results file. The default depends on the selection:
                           a full pass writes ./evals/results-latest.json, the PR
                           subset writes ./evals/results-pr-subset.json, and any
                           other narrowing writes ./evals/results-partial.json —
                           so a partial run never overwrites the full numbers.
  --database=<path>        Database to run against (default ./database/evals.db)
`.trim();

export function parseEvalArgs(argv: string[]): EvalOptions {
  // `only: []` is not redundant. A spread is shallow, so every call would
  // otherwise share — and `--only` *pushes* into — the one array on `DEFAULTS`,
  // leaving a question filter behind for the next caller in the process.
  const options: EvalOptions = { ...DEFAULTS, only: [] };
  // Resolved after the loop: the default destination depends on `--subset`,
  // `--category`, `--only` and `--limit`, which may appear in any order.
  let explicitOut: string | null = null;

  for (const arg of argv) {
    const [flag, rawValue] = splitFlag(arg);

    switch (flag) {
      case '--baseline':
        if (rawValue !== 'single-shot') {
          throw new Error(
            `Unknown baseline "${rawValue ?? ''}". The only baseline is single-shot.`,
          );
        }
        options.mode = 'single-shot';
        break;
      case '--only':
        options.only.push(
          ...requireValue(flag, rawValue)
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean),
        );
        break;
      case '--category':
        options.category = requireValue(flag, rawValue);
        break;
      case '--subset':
        if (rawValue !== 'pr' && rawValue !== 'full') {
          throw new Error(`--subset must be "pr" or "full", got "${rawValue ?? ''}"`);
        }
        options.subset = rawValue;
        break;
      case '--limit':
        options.limit = positiveInt(flag, rawValue);
        break;
      case '--fresh':
        options.fresh = true;
        break;
      case '--no-judge':
        options.judge = false;
        break;
      case '--memory':
        if (rawValue !== 'reset' && rawValue !== 'accumulate') {
          throw new Error(`--memory must be "reset" or "accumulate", got "${rawValue ?? ''}"`);
        }
        options.memory = rawValue;
        break;
      case '--connectors':
        options.connectors = true;
        break;
      case '--trace':
        options.trace = true;
        break;
      case '--concurrency':
        options.concurrency = positiveInt(flag, rawValue);
        break;
      case '--out':
        explicitOut = requireValue(flag, rawValue);
        break;
      case '--database':
        options.database = requireValue(flag, rawValue);
        break;
      default:
        throw new Error(`Unknown flag "${flag}".\n\n${EVAL_USAGE}`);
    }
  }

  options.out = explicitOut ?? defaultOutFor(options);
  return options;
}

function splitFlag(arg: string): [string, string | undefined] {
  const index = arg.indexOf('=');
  return index === -1 ? [arg, undefined] : [arg.slice(0, index), arg.slice(index + 1)];
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value === '') throw new Error(`${flag} needs a value, e.g. ${flag}=x`);
  return value;
}

function positiveInt(flag: string, value: string | undefined): number {
  const parsed = Number(requireValue(flag, value));
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer, got "${value ?? ''}"`);
  }
  return parsed;
}
