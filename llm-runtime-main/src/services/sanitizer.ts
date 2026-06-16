// NIB-M-SANITIZER — pure string operations for provider content cleanup.
//
// stripJsonFence: regex-based fence stripping (deterministic, no external dep for extraction).
// detectHeuristicTruncation: bracket/quote counter (DC-AI-JSON-SAFE-PARSE §3.2 forme C —
// lib used only for optional incomplete verdict; a hand-rolled counter is sufficient for
// the "incomplete vs other" distinction the runtime requires).

export interface StripResult {
  readonly content: string;
  readonly removed: boolean;
}

// NIB-M-SANITIZER §3.3 + NIB-T §7.1: match both <thinking> (Anthropic) and
// <think> (DeepSeek) tags. Case-insensitive, global, non-greedy.
const THINKING_TAG_RE = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;
// Matches ```json\n<body>\n``` or ```\n<body>\n``` with anchors after trim (spec §3.4).
const JSON_FENCE_RE = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?\s*```$/;

export function stripThinkingTags(content: string): StripResult {
  const stripped = content.replace(THINKING_TAG_RE, '').trim();
  return stripped === content ? { content, removed: false } : { content: stripped, removed: true };
}

export function stripJsonFence(content: string): StripResult {
  const match = JSON_FENCE_RE.exec(content.trim());
  if (match === null || match[1] === undefined) {
    return { content, removed: false };
  }
  return { content: match[1], removed: true };
}

export function detectHeuristicTruncation(
  content: string,
  _maxTokens: number | undefined,
): boolean {
  if (content.length === 0) return false;

  // Only consider contents that look like JSON (first non-whitespace is { or [).
  const firstNonWs = content.match(/\S/);
  if (firstNonWs === null) return false;
  const head = firstNonWs[0];
  if (head !== '{' && head !== '[') return false;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content.charAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
  }

  return inString || depth > 0;
}
