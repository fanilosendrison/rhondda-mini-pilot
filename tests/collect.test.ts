import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LLMResponse } from '@fanilosendrison/llm-runtime';
import { describe, expect, it } from 'vitest';
import {
  buildPoolRecord,
  checkpointKey,
  countCompletedDraws,
  countCompletedItems,
  countCompletedRecords,
  estimateCost,
} from '../src/domain/pool.js';
import { loadCheckpoint } from '../src/infra/checkpoint.js';
import { parseDatasetJsonl, withItemIds } from '../src/infra/dataset.js';

describe('GSM8K parsing', () => {
  it('parses JSONL rows and assigns stable GSM8K test IDs', () => {
    const raw = [
      JSON.stringify({ question: 'Q1', answer: 'A1 #### 1' }),
      JSON.stringify({ question: 'Q2', answer: 'A2 #### 2' }),
      '',
    ].join('\n');

    const items = withItemIds(parseDatasetJsonl(raw, 'fixture.jsonl'));

    expect(items).toEqual([
      { itemId: 'gsm8k_test_0001', ordinal: 1, question: 'Q1', answer: 'A1 #### 1' },
      { itemId: 'gsm8k_test_0002', ordinal: 2, question: 'Q2', answer: 'A2 #### 2' },
    ]);
  });

  it('rejects malformed GSM8K rows with source line context', () => {
    expect(() => parseDatasetJsonl('{"question":"Q only"}\n', 'fixture.jsonl')).toThrow(
      'fixture.jsonl:1 does not contain question/answer strings.',
    );
  });
});

describe('checkpoint resume state', () => {
  it('loads completed draws once and restores token totals from valid records', async () => {
    const dir = await makeTempDir();
    const checkpointPath = path.join(dir, 'gsm8k_pool.jsonl');
    const records = [
      makeRecord('gsm8k_test_0001', 1, { input: 10, output: 20, total: 30 }),
      makeRecord('gsm8k_test_0001', 1, { input: 999, output: 999, total: 1_998 }),
      makeRecord('gsm8k_test_0001', 2, { input: 5, output: 7, total: 12 }),
      makeRecord('unknown_item', 1, { input: 50, output: 50, total: 100 }),
      { ...makeRecord('gsm8k_test_0001', 31, { input: 1, output: 1, total: 2 }) },
    ];
    await writeFile(
      checkpointPath,
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );

    const state = await loadCheckpoint(checkpointPath, new Set(['gsm8k_test_0001']));

    expect(state.completedKeys).toEqual(
      new Set([checkpointKey('gsm8k_test_0001', 1), checkpointKey('gsm8k_test_0001', 2)]),
    );
    expect(state.tokenTotals).toEqual({ input: 15, output: 27, total: 42 });
  });

  it('truncates an interrupted final JSONL line and keeps previous complete records', async () => {
    const dir = await makeTempDir();
    const checkpointPath = path.join(dir, 'gsm8k_pool.jsonl');
    const first = makeRecord('gsm8k_test_0001', 1, { input: 3, output: 4, total: 7 });
    await writeFile(checkpointPath, `${JSON.stringify(first)}\n{"item_id":"gsm8k_test_0001"`);

    const state = await loadCheckpoint(checkpointPath, new Set(['gsm8k_test_0001']));
    const normalized = await readFile(checkpointPath, 'utf8');

    expect(state.completedKeys).toEqual(new Set([checkpointKey('gsm8k_test_0001', 1)]));
    expect(state.tokenTotals).toEqual({ input: 3, output: 4, total: 7 });
    expect(normalized).toBe(`${JSON.stringify(first)}\n`);
  });

  it('counts completed items and records from checkpoint keys', () => {
    const items = withItemIds([
      { question: 'Q1', answer: 'A1' },
      { question: 'Q2', answer: 'A2' },
    ]);
    const completed = new Set<string>();
    for (let draw = 1; draw <= 30; draw += 1) {
      completed.add(checkpointKey('gsm8k_test_0001', draw));
    }
    completed.add(checkpointKey('gsm8k_test_0002', 1));

    expect(countCompletedDraws('gsm8k_test_0001', completed)).toBe(30);
    expect(countCompletedItems(items, completed)).toBe(1);
    expect(countCompletedRecords(items, completed)).toBe(31);
  });
});

describe('pool record shaping', () => {
  it('maps llm-runtime usage fields to the required JSONL token object', () => {
    const [item] = withItemIds([{ question: 'How much?', answer: '#### 42' }]);
    if (item === undefined) throw new Error('missing item fixture');

    const record = buildPoolRecord(item, 3, makeResponse({ inputTokens: 11, outputTokens: 13 }));

    expect(record).toMatchObject({
      item_id: 'gsm8k_test_0001',
      tirage: 3,
      prompt: 'How much?',
      response: 'The answer is 42.',
      tokens: { input: 11, output: 13, total: 24 },
    });
    expect(Date.parse(record.timestamp)).not.toBeNaN();
  });

  it('estimates cost from input/output token rates', () => {
    expect(estimateCost({ input: 1_000_000, output: 1_000_000, total: 2_000_000 })).toBe(5.25);
  });
});

async function makeTempDir(): Promise<string> {
  const dir = path.join(tmpdir(), `rhondda-mini-pilot-test-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeRecord(
  itemId: string,
  tirage: number,
  tokens: { readonly input: number; readonly output: number; readonly total: number },
) {
  return {
    item_id: itemId,
    tirage,
    prompt: 'question',
    response: 'response',
    tokens,
    timestamp: '2026-06-16T14:22:10.123Z',
  };
}

function makeResponse(usage: { readonly inputTokens?: number; readonly outputTokens?: number }) {
  return {
    callId: 'call_1',
    provider: 'openai',
    model: 'gpt-5.4-mini',
    content: 'The answer is 42.',
    rawContent: 'The answer is 42.',
    termination: 'completed',
    attemptCount: 1,
    durationMs: 100,
    startedAt: '2026-06-16T14:22:10.000Z',
    endedAt: '2026-06-16T14:22:10.100Z',
    usage,
    sanitization: { thinkingTagsRemoved: false, jsonFenceRemoved: false },
    integrity: { truncationDetected: false },
  } satisfies LLMResponse;
}
