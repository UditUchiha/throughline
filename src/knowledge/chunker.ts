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
