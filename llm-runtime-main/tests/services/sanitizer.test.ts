// NIB-T §7 — RED-phase tests for stripThinkingTags / stripJsonFence / detectHeuristicTruncation.
// Reference: specs/NIB-T-LLMRUNTIME.md §7 (T-SN-01..T-SN-24 + P-SN-a..d).

import { describe, expect, it } from 'vitest';
import {
  detectHeuristicTruncation,
  stripJsonFence,
  stripThinkingTags,
} from '../../src/services/sanitizer.js';
import { seededRandom } from '../helpers/seeded-random.js';

describe('sanitizer', () => {
  // ───────────────────────── §7.1 stripThinkingTags ─────────────────────────
  describe('§7.1 stripThinkingTags', () => {
    it('T-SN-01 | "hello" → unchanged, removed=false', () => {
      expect(stripThinkingTags('hello')).toEqual({ content: 'hello', removed: false });
    });

    it('T-SN-02 | "<think>reasoning</think>answer" → "answer", removed=true', () => {
      expect(stripThinkingTags('<think>reasoning</think>answer')).toEqual({
        content: 'answer',
        removed: true,
      });
    });

    it('T-SN-03 | multiple tags → all stripped', () => {
      expect(stripThinkingTags('<think>a</think>b<think>c</think>d')).toEqual({
        content: 'bd',
        removed: true,
      });
    });

    it('T-SN-04 | only thinking block → empty', () => {
      expect(stripThinkingTags('<think>only thinking</think>')).toEqual({
        content: '',
        removed: true,
      });
    });

    it('T-SN-05 | prefix + thinking + suffix', () => {
      expect(stripThinkingTags('prefix<think>mid</think>suffix')).toEqual({
        content: 'prefixsuffix',
        removed: true,
      });
    });

    it('T-SN-06 | multiline thinking block', () => {
      expect(stripThinkingTags('<think>\nmulti\nline\n</think>result')).toEqual({
        content: 'result',
        removed: true,
      });
    });

    it('T-SN-07 | no tags at all', () => {
      expect(stripThinkingTags('no tags here')).toEqual({
        content: 'no tags here',
        removed: false,
      });
    });

    it('T-SN-08 | unclosed opening tag → not stripped (normative decision)', () => {
      expect(stripThinkingTags('<think>unclosed')).toEqual({
        content: '<think>unclosed',
        removed: false,
      });
    });

    it('T-SN-09 | orphan closing tag → not stripped', () => {
      expect(stripThinkingTags('</think>orphan close')).toEqual({
        content: '</think>orphan close',
        removed: false,
      });
    });

    it('T-SN-10 | empty string', () => {
      expect(stripThinkingTags('')).toEqual({ content: '', removed: false });
    });

    it('T-SN-10a | unicode emoji inside think block', () => {
      expect(stripThinkingTags('<think>reasoning with emoji \u{1F914}</think>answer')).toEqual({
        content: 'answer',
        removed: true,
      });
    });

    it('T-SN-10b | CRLF inside think block', () => {
      expect(stripThinkingTags('<think>line1\r\nline2\r\n</think>answer')).toEqual({
        content: 'answer',
        removed: true,
      });
    });

    it('T-SN-10c | mixed EOL (LF + CRLF) inside think block', () => {
      expect(stripThinkingTags('<think>line1\nline2\r\nline3\n</think>result')).toEqual({
        content: 'result',
        removed: true,
      });
    });

    it('T-SN-10d | case-insensitive: <Think> and <THINK> ARE stripped (NIB-M-SANITIZER §3.3 flag i)', () => {
      // NIB-M-SANITIZER §3.3: flag `i` — matche `<THINKING>` comme `<thinking>`.
      const input = '<Think>content</Think>';
      expect(stripThinkingTags(input)).toEqual({ content: '', removed: true });
      const inputUpper = '<THINK>content</THINK>';
      expect(stripThinkingTags(inputUpper)).toEqual({ content: '', removed: true });
    });

    it('T-SN-10e | surrogate pairs preserved outside think block', () => {
      const emoji = '\u{1F600}\u{1F4A9}';
      expect(stripThinkingTags(`<think>hidden</think>${emoji}`)).toEqual({
        content: emoji,
        removed: true,
      });
    });
  });

  // ───────────────────────── §7.2 stripJsonFence ─────────────────────────
  describe('§7.2 stripJsonFence', () => {
    it('T-SN-11 | plain JSON (no fence) → unchanged', () => {
      expect(stripJsonFence('{"a": 1}')).toEqual({ content: '{"a": 1}', removed: false });
    });

    it('T-SN-12 | ```json\\n...\\n``` fenced JSON → content extracted, removed=true', () => {
      const input = '```json\n{"a": 1}\n```';
      const result = stripJsonFence(input);
      expect(result.removed).toEqual(true);
      // Tolerant on trailing whitespace.
      expect(result.content.trim()).toEqual('{"a": 1}');
    });

    it('T-SN-13 | ```\\n...\\n``` (no "json" marker) → stripped', () => {
      const input = '```\n{"a": 1}\n```';
      const result = stripJsonFence(input);
      expect(result.removed).toEqual(true);
      expect(result.content.trim()).toEqual('{"a": 1}');
    });

    it('T-SN-14 | non-JSON plain text → unchanged, removed=false', () => {
      expect(stripJsonFence('hello')).toEqual({ content: 'hello', removed: false });
    });

    it('T-SN-15 | preamble + fence + postamble → NOT extracted (anchored per spec §3.4)', () => {
      // Per spec §3.4, the fence must be the entire content (anchored regex).
      // Preamble/postamble outside the fence prevents extraction.
      const input = 'preamble\n```json\n{"a": 1}\n```\npostamble';
      const result = stripJsonFence(input);
      expect(result.removed).toEqual(false);
      expect(result.content).toBe(input);
    });

    it('T-SN-16 | empty string → unchanged', () => {
      expect(stripJsonFence('')).toEqual({ content: '', removed: false });
    });

    it('T-SN-17 | fenced but invalid JSON body → fence stripped, backticks removed', () => {
      // NIB-T §7.2 decision: fence is stripped regardless of JSON validity.
      const input = '```json\n{invalid}\n```';
      const result = stripJsonFence(input);
      expect(result.removed).toEqual(true);
      expect(result.content).not.toContain('```');
    });

    it('T-SN-17a | CRLF line endings in fenced block', () => {
      const input = '```json\r\n{"a": 1}\r\n```';
      const result = stripJsonFence(input);
      expect(result.removed).toEqual(true);
      expect(result.content.trim()).toEqual('{"a": 1}');
    });

    it('T-SN-17b | mixed EOL (LF + CRLF) in fenced block', () => {
      const input = '```json\n{"a": 1,\r\n"b": 2}\n```';
      const result = stripJsonFence(input);
      expect(result.removed).toEqual(true);
      expect(result.content).toContain('"a": 1');
      expect(result.content).toContain('"b": 2');
    });

    it('T-SN-17c | unicode emoji in fenced JSON body', () => {
      const input = '```json\n{"emoji": "\u{1F914}"}\n```';
      const result = stripJsonFence(input);
      expect(result.removed).toEqual(true);
      expect(result.content).toContain('\u{1F914}');
    });

    it('T-SN-17d | surrogate pair content preserved through fence stripping', () => {
      const content = '{"text": "\u{1F600}\u{1F4A9}"}';
      const input = `\`\`\`json\n${content}\n\`\`\``;
      const result = stripJsonFence(input);
      expect(result.removed).toEqual(true);
      expect(result.content.trim()).toEqual(content);
    });
  });

  // ───────────────────────── §7.3 detectHeuristicTruncation ─────────────────────────
  describe('§7.3 detectHeuristicTruncation', () => {
    it('T-SN-18 | empty content + maxTokens=undefined → false (normative)', () => {
      expect(detectHeuristicTruncation('', undefined)).toEqual(false);
    });

    it('T-SN-19 | empty content + maxTokens=500 → false (normative)', () => {
      expect(detectHeuristicTruncation('', 500)).toEqual(false);
    });

    it('T-SN-20 | closed JSON object → false', () => {
      expect(detectHeuristicTruncation('{"a": 1}', 500)).toEqual(false);
    });

    it('T-SN-21 | unclosed JSON object → true', () => {
      expect(detectHeuristicTruncation('{"a": 1', 500)).toEqual(true);
    });

    it('T-SN-22 | unclosed JSON array → true', () => {
      expect(detectHeuristicTruncation('[1, 2, 3', 500)).toEqual(true);
    });

    it('T-SN-23 | plain truncated text (no JSON) → false', () => {
      expect(detectHeuristicTruncation('Hello, how are y', 500)).toEqual(false);
    });

    it('T-SN-24 | mixed text + partial JSON → boolean (calibrated in GREEN)', () => {
      // NIB-T §7.3 note: T-SN-24 is in a grey zone. Assertion: the function
      // returns a boolean (no throw, no other type). The exact value (true/false)
      // is acceptable either way as long as the rule is documented in GREEN.
      const result = detectHeuristicTruncation('Some text { partial', 500);
      expect(typeof result).toEqual('boolean');
    });
  });

  // ───────────────────────── §7.4 properties ─────────────────────────
  describe('§7.4 properties', () => {
    it('P-SN-a | stripThinkingTags idempotent (20 iterations)', () => {
      const rng = seededRandom(0xbabe);
      for (let i = 0; i < 20; i += 1) {
        // Build a mix of plain text and <think> blocks.
        const parts: string[] = [];
        const chunks = rng.randomInt(0, 4);
        for (let c = 0; c < chunks; c += 1) {
          if (rng.randomBool()) {
            parts.push(`<think>${rng.randomString(20)}</think>`);
          } else {
            parts.push(rng.randomString(20));
          }
        }
        const s = parts.join('');
        const once = stripThinkingTags(s).content;
        const twice = stripThinkingTags(once).content;
        expect(twice).toEqual(once);
      }
    });

    it('P-SN-b | stripJsonFence idempotent (20 iterations)', () => {
      const rng = seededRandom(0xcafe);
      for (let i = 0; i < 20; i += 1) {
        const useFence = rng.randomBool();
        const body = rng.randomString(20);
        const s = useFence ? '```json\n' + body + '\n```' : body;
        const once = stripJsonFence(s).content;
        const twice = stripJsonFence(once).content;
        expect(twice).toEqual(once);
      }
    });

    it('P-SN-c | stripThinkingTags never adds content', () => {
      const rng = seededRandom(0xdada);
      for (let i = 0; i < 20; i += 1) {
        const s = rng.randomString(50);
        const result = stripThinkingTags(s);
        expect(result.content.length).toBeLessThanOrEqual(s.length);
      }
    });

    it('P-SN-d | detectHeuristicTruncation("", any) === false', () => {
      const rng = seededRandom(0xeeff);
      for (let i = 0; i < 20; i += 1) {
        const maxTokens = rng.randomBool() ? rng.randomInt(0, 10000) : undefined;
        expect(detectHeuristicTruncation('', maxTokens)).toEqual(false);
      }
    });
  });
});
