import { parseEvalArgs } from './cli';
import { flagChoice, flagInt, flagValue } from './flags';

/**
 * The command line, tested — because two of the defects it grew were invisible
 * from the inside: a narrowed run that overwrote the full results file, and a
 * flag filter that leaked from one call to the next.
 */

describe('parseEvalArgs', () => {
  it('does not leak a question filter into the next call', () => {
    // `{ ...DEFAULTS }` is a shallow copy, so `only` was the *same array* on every
    // parse and `--only` pushed into it. One process parsing twice — which is
    // every test file here — saw the first call's filter in the second.
    expect(parseEvalArgs(['--only=q.one']).only).toEqual(['q.one']);
    expect(parseEvalArgs([]).only).toEqual([]);
  });

  describe('default results destination', () => {
    /**
     * `writeResults` merges by mode but replaces a mode wholesale, so where a
     * partial run writes is a data-safety question rather than a convenience.
     * `pnpm eval --subset=pr` — the command printed in CLAUDE.md, README.md and
     * evals/README.md — used to overwrite the 59-question agent numbers the
     * README cites and `baseline.json` was recorded from, with nine questions.
     */
    it('lets only a full pass write the canonical file', () => {
      expect(parseEvalArgs([]).out).toBe('./evals/results-latest.json');
      expect(parseEvalArgs(['--subset=full']).out).toBe('./evals/results-latest.json');
    });

    it('sends the PR subset to its own file', () => {
      expect(parseEvalArgs(['--subset=pr']).out).toBe('./evals/results-pr-subset.json');
    });

    it.each([['--only=q.one'], ['--category=temporal'], ['--limit=3']])(
      'sends %s to the partial file',
      (flag) => {
        expect(parseEvalArgs([flag]).out).toBe('./evals/results-partial.json');
      },
    );

    it('honours --out whichever side of the narrowing flag it appears', () => {
      expect(parseEvalArgs(['--out=./x.json', '--subset=pr']).out).toBe('./x.json');
      expect(parseEvalArgs(['--subset=pr', '--out=./x.json']).out).toBe('./x.json');
    });
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() => parseEvalArgs(['--subst=pr'])).toThrow(/Unknown flag/);
  });
});

describe('flags', () => {
  it('rejects a flag written without =, instead of silently defaulting', () => {
    // `--mode single-shot` is how every other CLI spells it. Matching only on a
    // `--mode=` prefix meant the fallback won and the tool reported on `agent`,
    // successfully answering a question nobody asked.
    expect(() => flagValue(['--mode', 'single-shot'], '--mode', 'agent')).toThrow(
      /--mode needs a value/,
    );
    expect(() => flagInt(['--limit', '5'], '--limit', 0)).toThrow(/--limit needs a value/);
  });

  it('rejects a malformed integer rather than turning it into the default', () => {
    expect(() => flagInt(['--limit=abc'], '--limit', 0)).toThrow(/non-negative integer/);
    expect(() => flagInt(['--limit=-2'], '--limit', 0)).toThrow(/non-negative integer/);
    expect(flagInt(['--limit=5'], '--limit', 0)).toBe(5);
    expect(flagInt([], '--limit', 0)).toBe(0);
  });

  it('rejects a value outside the known set rather than casting to it', () => {
    // The alternative in use was `flagValue(...) as EvalMode`, which failed later
    // as "results file has no agnet results" — a message about the symptom.
    expect(() => flagChoice(['--mode=agnet'], '--mode', ['agent', 'single-shot'], 'agent')).toThrow(
      /must be one of agent, single-shot/,
    );
    expect(flagChoice(['--mode=single-shot'], '--mode', ['agent', 'single-shot'], 'agent')).toBe(
      'single-shot',
    );
  });

  it('rejects an empty value', () => {
    expect(() => flagValue(['--results='], '--results', './x.json')).toThrow(/empty value/);
  });
});
