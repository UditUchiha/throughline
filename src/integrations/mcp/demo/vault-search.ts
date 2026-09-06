/**
 * Lexical search over a small markdown vault — the retrieval half of the
 * DEMO_MODE Obsidian connector.
 *
 * BM25 rather than embeddings, for one reason: DEMO_MODE's promise is a full
 * pipeline with **no connector credentials**, and an embedding call is a
 * credential. It is also honest about what a connector is — a real Obsidian MCP
 * server does keyword search over your vault too, so the demo is not pretending
 * to be something better than the thing it stands in for.
 */

/** Standard BM25 parameters. Not tuned; this ranks a dozen notes, not a corpus. */
const K1 = 1.2;
const B = 0.75;

export interface VaultNote {
  /** Vault-relative path — the note's stable identity, and its `evidenceId` ref. */
  path: string;
  title: string;
  text: string;
}

export interface VaultHit extends VaultNote {
  /** 0..1, higher is better. The best hit in a result set always scores 1. */
  score: number;
}

/**
 * Splits on anything that is not a letter or digit, which is crude but right for
 * this input: the vault is English prose with wikilinks and hyphenated project
 * names, and `[[helios-billing]]` should match a search for "helios billing".
 */
export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);
}

export function searchVault(notes: VaultNote[], query: string, topK: number): VaultHit[] {
  const terms = [...new Set(tokenise(query))];
  if (terms.length === 0 || notes.length === 0) return [];

  const documents = notes.map((note) => ({
    note,
    // Title terms count as body terms rather than being boosted. A boost is a
    // tuning knob, and nothing here measures whether it helps.
    tokens: tokenise(`${note.title} ${note.text}`),
  }));

  const averageLength =
    documents.reduce((total, document) => total + document.tokens.length, 0) / documents.length;

  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    const count = documents.filter((document) => document.tokens.includes(term)).length;
    documentFrequency.set(term, count);
  }

  const scored = documents.map(({ note, tokens }) => {
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

    let score = 0;
    for (const term of terms) {
      const frequency = counts.get(term) ?? 0;
      if (frequency === 0) continue;

      const n = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (documents.length - n + 0.5) / (n + 0.5));
      const normalisation = K1 * (1 - B + (B * tokens.length) / averageLength);
      score += idf * ((frequency * (K1 + 1)) / (frequency + normalisation));
    }

    return { note, score };
  });

  const hits = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  if (hits.length === 0) return [];

  // Normalised against the best hit, because BM25 scores are unbounded and only
  // comparable within one query. The consumer wants a 0..1 relevance it can
  // calibrate onto the distance scale (see `calibrateDistance`), and "how close
  // is this to the best thing I found" is the only claim this ranking supports.
  const best = hits[0].score;
  return hits.slice(0, topK).map(({ note, score }) => ({ ...note, score: score / best }));
}
