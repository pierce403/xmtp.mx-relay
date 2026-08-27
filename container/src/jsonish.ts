export function parseJsonishMessage(content: string): unknown | null {
  const candidates = [content.trim()];
  const trimmed = candidates[0] ?? '';
  if (trimmed.startsWith('```')) {
    const firstNewline = trimmed.indexOf('\n');
    const lastFence = trimmed.lastIndexOf('```');
    if (firstNewline >= 0 && lastFence > firstNewline) {
      candidates.push(trimmed.slice(firstNewline + 1, lastFence).trim());
    }
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next conservative representation.
    }
  }
  return null;
}

export function canonicalizeEmailSendEventContent(content: string): string | null {
  const parsed = parseJsonishMessage(content);
  if ((parsed as { type?: unknown } | null)?.type !== 'email.send.v1') return null;
  return JSON.stringify(parsed);
}
