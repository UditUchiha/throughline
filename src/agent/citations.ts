import type { Citation, Evidence } from './agent.types';

/**
 * Evidence identity is derived from the chunk, not from a per-run counter.
 *
 * Two sub-questions running concurrently can retrieve the same chunk; a counter
 * would give it two ids and the same passage would appear twice in the answer's
 * sources. Deriving from `chunkId` makes dedupe free and makes an `evidenceId`
 * meaningful across runs, which the M3 trace viewer needs.
 */
export function mintEvidenceId(chunkId: number): string {
  return `ev-${chunkId}`;
}

/**
 * Renders evidence as the numbered block shown to the synthesis model, and
 * returns the marker→evidenceId ordering alongside it.
 *
 * The model only ever sees `[1]`, `[2]`, … — it never sees or invents an
 * `evidenceId`. That is the whole trick: citation validity reduces to "is this
 * integer in range", which is checkable without an LLM (PLAN.md §4).
 */
export function renderEvidenceBlock(evidence: Evidence[]): {
  text: string;
  ordering: string[];
} {
  const ordering = evidence.map((e) => e.evidenceId);
  const text = evidence
    .map((e, i) => {
      const origin = [e.source, e.docId].filter(Boolean).join(' · ') || 'unknown source';
      return `[${i + 1}] (${origin}) ${e.title}\n${e.text}`;
    })
    .join('\n\n');

  return { text, ordering };
}

const MARKER_PATTERN = /\[(\d+)\]/g;

export interface CitationResolution {
  citations: Citation[];
  /** Markers the model emitted that point at nothing — a fabrication. */
  unresolved: number[];
}

/**
 * Maps every `[n]` in the answer back to an `evidenceId`. Markers outside the
 * range of what the model was shown are reported rather than silently dropped:
 * a fabricated citation is a scored failure in M6, so it has to be visible.
 */
export function resolveCitations(answerText: string, ordering: string[]): CitationResolution {
  const citations: Citation[] = [];
  const unresolved: number[] = [];
  const seen = new Set<number>();

  for (const match of answerText.matchAll(MARKER_PATTERN)) {
    const marker = Number(match[1]);
    if (seen.has(marker)) continue;
    seen.add(marker);

    const evidenceId = ordering[marker - 1];
    if (evidenceId === undefined) {
      unresolved.push(marker);
      continue;
    }
    citations.push({ marker, evidenceId });
  }

  citations.sort((a, b) => a.marker - b.marker);
  return { citations, unresolved };
}

/**
 * Strips markers that resolve to nothing. Leaving a dangling `[7]` in rendered
 * text would show the visitor a citation they cannot click through to.
 */
export function stripUnresolvedMarkers(answerText: string, unresolved: number[]): string {
  if (unresolved.length === 0) return answerText;
  const dangling = new Set(unresolved);
  return answerText.replace(MARKER_PATTERN, (marker, digits: string) =>
    dangling.has(Number(digits)) ? '' : marker,
  );
}
