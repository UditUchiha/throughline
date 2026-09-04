/**
 * Splits text into overlapping windows.
 *
 * **`chunkSize` and `chunkOverlap` are counted in WORDS, not characters.** The env
 * vars are named `CHUNK_SIZE` / `CHUNK_OVERLAP` and read like byte counts, which is
 * the trap: the default of 700 is ~4000 characters, so every document in the current
 * corpus (300–1900 chars) fits in a single chunk and retrieval is effectively
 * whole-document.
 *
 * That is fine for this corpus and is why chunking has never actually been exercised
 * here. It stops being fine when longer documents arrive — M5's connectors — because
 * a 700-word window would then silently swallow several topics per chunk and degrade
 * retrieval with no visible signal. Re-tune it there, with the eval numbers from M6 in
 * hand rather than by guessing, and note that changing the units invalidates the
 * distance threshold derived in docs/retrieval-threshold-study.md.
 */
export function chunkText(text: string, chunkSize: number, chunkOverlap: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const step = Math.max(chunkSize - chunkOverlap, 1);
  const chunks: string[] = [];

  for (let start = 0; start < words.length; start += step) {
    chunks.push(words.slice(start, start + chunkSize).join(' '));
    if (start + chunkSize >= words.length) break;
  }

  return chunks;
}
