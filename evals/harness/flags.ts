/**
 * Flag parsing for the small runners around the suite.
 *
 * `compare.ts`, `sweep.ts` and `judge-agreement.ts` each had a copy of the same
 * six-line `flagValue`, none of which validated anything. Two failures followed
 * from that and both were silent, which is what makes them worth a module:
 *
 * - **A flag written without `=` was ignored.** `--mode single-shot` — the
 *   spelling every other CLI in the world accepts — matched no `--mode=` prefix,
 *   so the fallback won and the tool cheerfully reported on `agent` instead. The
 *   run looked successful and answered a different question.
 * - **A malformed value became a default.** `--limit=abc` went through `Number()`
 *   to `NaN`, failed `limit > 0`, and judged the whole label set.
 *
 * `evals/harness/cli.ts` deliberately does *not* use these: `pnpm eval` has
 * fifteen flags and rejects unknown ones outright, which needs a real switch
 * rather than a lookup. These are for the three tools with three flags each.
 */

/** Rejects a flag that appears with no `=value`, rather than silently defaulting. */
function rawValue(argv: string[], flag: string): string | null {
  if (argv.includes(flag)) {
    throw new Error(`${flag} needs a value, written as ${flag}=<value>`);
  }
  const found = argv.find((arg) => arg.startsWith(`${flag}=`));
  return found ? found.slice(flag.length + 1) : null;
}

export function flagValue(argv: string[], flag: string, fallback: string): string {
  const value = rawValue(argv, flag);
  if (value === null) return fallback;
  if (value === '') throw new Error(`${flag} was given an empty value`);
  return value;
}

export function flagInt(argv: string[], flag: string, fallback: number): number {
  const value = rawValue(argv, flag);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer, got "${value}"`);
  }
  return parsed;
}

/**
 * A flag whose value must be one of a known set.
 *
 * The alternative was `flagValue(...) as EvalMode`, which is a raw cast at an
 * input boundary — the thing PLAN.md §0.3 bans at the API surface, arriving by
 * the back door on a CLI. `--mode=agnet` typed as `EvalMode` and then failed
 * downstream as "results file has no agnet results", which names the symptom.
 */
export function flagChoice<T extends string>(
  argv: string[],
  flag: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = rawValue(argv, flag);
  if (value === null) return fallback;
  const match = allowed.find((option) => option === value);
  if (match === undefined) {
    throw new Error(`${flag} must be one of ${allowed.join(', ')}, got "${value}"`);
  }
  return match;
}
