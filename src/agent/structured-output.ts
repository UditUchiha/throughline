/**
 * Extracts a JSON object from a model response.
 *
 * Nodes request structured output via `response_format: json_schema`, but not
 * every OpenAI-compatible host honours it identically — some wrap the object in
 * a ```json fence, some prepend a sentence. Rather than let one chatty provider
 * fail a whole run, parse defensively here and let the caller decide what a
 * `null` means. The strict schema is still sent; this is the safety net, not the
 * mechanism.
 */
export function parseJsonObject<T>(text: string): T | null {
  const candidates = [text.trim(), stripCodeFence(text), extractBracedSpan(text)];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as T;
      }
    } catch {
      // Try the next, more aggressive, extraction.
    }
  }
  return null;
}

function stripCodeFence(text: string): string | null {
  const match = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return match ? match[1].trim() : null;
}

function extractBracedSpan(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start !== -1 && end > start ? text.slice(start, end + 1) : null;
}
