import 'dotenv/config';

import { appendFile, mkdir, readFile, stat, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LLMResponse, ProviderAdapter } from '@vegacorp/llm-runtime';
import {
  createOpenAIAdapter,
  OverloadedError,
  RateLimitError,
  TimeoutError,
  TransientProviderError,
} from '@vegacorp/llm-runtime';

const GSM8K_TEST_URL =
  'https://raw.githubusercontent.com/openai/grade-school-math/master/grade_school_math/data/test.jsonl';

const CONFIG = {
  itemCount: readPositiveIntEnv('GSM8K_ITEM_COUNT', 200),
  drawsPerItem: readPositiveIntEnv('GSM8K_DRAWS_PER_ITEM', 30),
  model: readStringEnv('OPENAI_MODEL', 'gpt-5.4-mini'),
  temperature: readNumberEnv('OPENAI_TEMPERATURE', 0.7),
  outputFile: readStringEnv('GSM8K_POOL_FILE', 'gsm8k_pool.jsonl'),
  datasetCacheFile: readStringEnv('GSM8K_DATASET_CACHE_FILE', 'gsm8k_test_cache.jsonl'),
  inputUsdPer1M: readNonNegativeNumberEnv('OPENAI_INPUT_USD_PER_1M', 0.75),
  outputUsdPer1M: readNonNegativeNumberEnv('OPENAI_OUTPUT_USD_PER_1M', 4.5),
  maxAttempts: readPositiveIntEnv('OPENAI_MAX_ATTEMPTS', 5),
  retryBaseMs: readPositiveIntEnv('OPENAI_RETRY_BASE_MS', 1_000),
  retryMaxMs: readPositiveIntEnv('OPENAI_RETRY_MAX_MS', 60_000),
  timeoutMs: readPositiveIntEnv('OPENAI_TIMEOUT_MS', 120_000),
} as const;

interface Gsm8kRawItem {
  readonly question: string;
  readonly answer: string;
}

interface Gsm8kItem extends Gsm8kRawItem {
  readonly itemId: string;
  readonly ordinal: number;
}

interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly total: number;
}

interface PoolRecord {
  readonly item_id: string;
  readonly tirage: number;
  readonly prompt: string;
  readonly response: string;
  readonly tokens: TokenUsage;
  readonly timestamp: string;
}

interface TokenTotals {
  input: number;
  output: number;
  total: number;
}

interface CheckpointState {
  readonly completedKeys: Set<string>;
  readonly tokenTotals: TokenTotals;
}

let stopRequested = false;

process.once('SIGINT', () => {
  stopRequested = true;
  writeErr(
    `[${timeLabel()}] Interruption demandee. Le script termine l'appel en cours puis s'arrete.`,
  );
});

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('OPENAI_API_KEY is required. Copy .env.example to .env and fill it in.');
  }

  const outputPath = path.resolve(process.cwd(), CONFIG.outputFile);
  const datasetCachePath = path.resolve(process.cwd(), CONFIG.datasetCacheFile);
  const items = await loadGsm8kItems(datasetCachePath, CONFIG.itemCount);
  const knownItemIds = new Set(items.map((item) => item.itemId));
  const checkpoint = await loadCheckpoint(outputPath, knownItemIds);
  await mkdir(path.dirname(outputPath), { recursive: true });

  const adapter = createOpenAIAdapter({
    apiKey,
    model: CONFIG.model,
    retry: { maxAttempts: 1, backoffBaseMs: 0, maxBackoffMs: 0 },
    timeout: { perAttemptMs: CONFIG.timeoutMs },
    sanitization: { stripThinkingTags: true, stripJsonFence: false },
  });

  writeOut(`Dataset: ${items.length} GSM8K test items (${GSM8K_TEST_URL})`);
  writeOut(`Output: ${CONFIG.outputFile}`);
  writeOut(
    `Cost estimate: input $${CONFIG.inputUsdPer1M}/1M, output $${CONFIG.outputUsdPer1M}/1M tokens`,
  );
  printProgress('resume', items, checkpoint);

  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    if (stopRequested) break;
    const item = items[itemIndex];
    if (item === undefined) continue;

    if (countCompletedDraws(item.itemId, checkpoint.completedKeys) >= CONFIG.drawsPerItem) {
      continue;
    }

    for (let draw = 1; draw <= CONFIG.drawsPerItem; draw += 1) {
      if (stopRequested) break;
      const key = checkpointKey(item.itemId, draw);
      if (checkpoint.completedKeys.has(key)) continue;

      writeOut(
        `[${timeLabel()}] Item ${itemIndex + 1}/${items.length} - Tirage ${draw}/${CONFIG.drawsPerItem} - Tokens total: ${formatInteger(checkpoint.tokenTotals.total)} - Cout estime: ${formatUsd(estimateCost(checkpoint.tokenTotals))}`,
      );

      let response: LLMResponse;
      try {
        response = await callWithRetries(adapter, item);
      } catch (error) {
        writeErr(
          `[${timeLabel()}] Item ${itemIndex + 1}/${items.length} - tirage ${draw} abandonne: ${formatError(error)}. Passage a l'item suivant.`,
        );
        break;
      }

      const record = buildPoolRecord(item, draw, response);
      await appendPoolRecord(outputPath, record);
      checkpoint.completedKeys.add(key);
      addTokens(checkpoint.tokenTotals, record.tokens);
      printProgress(
        `${itemIndex + 1}/${items.length}:${draw}/${CONFIG.drawsPerItem}`,
        items,
        checkpoint,
      );
    }
  }

  writeOut('');
  writeOut('Collecte terminee.');
  writeOut(
    `Items traites : ${countCompletedItems(items, checkpoint.completedKeys)}/${items.length}`,
  );
  writeOut(
    `Tirages effectues : ${countCompletedRecords(items, checkpoint.completedKeys)}/${items.length * CONFIG.drawsPerItem}`,
  );
  writeOut(`Tokens total (input) : ${formatInteger(checkpoint.tokenTotals.input)}`);
  writeOut(`Tokens total (output) : ${formatInteger(checkpoint.tokenTotals.output)}`);
  writeOut(`Cout total estime : ${formatUsd(estimateCost(checkpoint.tokenTotals))}`);
  writeOut(`Fichier : ${CONFIG.outputFile}`);
}

async function loadGsm8kItems(cachePath: string, limit: number): Promise<readonly Gsm8kItem[]> {
  const cached = await tryReadDatasetCache(cachePath, limit);
  if (cached !== null) return cached;

  writeOut(`[${timeLabel()}] Telechargement du test set GSM8K...`);
  const response = await fetch(GSM8K_TEST_URL);
  if (!response.ok) {
    throw new Error(`Failed to download GSM8K: HTTP ${response.status} ${response.statusText}`);
  }

  const rawText = await response.text();
  const rawItems = parseDatasetJsonl(rawText, GSM8K_TEST_URL);
  if (rawItems.length < limit) {
    throw new Error(`GSM8K test set only has ${rawItems.length} items, need ${limit}.`);
  }

  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(
    cachePath,
    `${rawItems.map((item) => JSON.stringify(item)).join('\n')}\n`,
    'utf8',
  );
  return withItemIds(rawItems.slice(0, limit));
}

async function tryReadDatasetCache(
  cachePath: string,
  limit: number,
): Promise<readonly Gsm8kItem[] | null> {
  if (!(await fileExists(cachePath))) return null;

  try {
    const cachedText = await readFile(cachePath, 'utf8');
    const cachedItems = parseDatasetJsonl(cachedText, cachePath);
    if (cachedItems.length >= limit) {
      writeOut(`[${timeLabel()}] Dataset charge depuis le cache ${path.basename(cachePath)}.`);
      return withItemIds(cachedItems.slice(0, limit));
    }
    writeErr(
      `[${timeLabel()}] Cache GSM8K incomplet (${cachedItems.length}/${limit}); telechargement distant.`,
    );
  } catch (error) {
    writeErr(
      `[${timeLabel()}] Cache GSM8K illisible: ${formatError(error)}. Rechargement distant.`,
    );
  }

  return null;
}

function parseDatasetJsonl(text: string, source: string): readonly Gsm8kRawItem[] {
  const items: Gsm8kRawItem[] = [];
  const lines = text.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === undefined || line.trim().length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`${source}:${lineIndex + 1} is not valid JSONL: ${formatError(error)}`);
    }

    if (!isGsm8kRawItem(parsed)) {
      throw new Error(`${source}:${lineIndex + 1} does not contain question/answer strings.`);
    }
    items.push(parsed);
  }

  return items;
}

function withItemIds(items: readonly Gsm8kRawItem[]): readonly Gsm8kItem[] {
  return items.map((item, index) => ({
    ...item,
    itemId: `gsm8k_test_${String(index + 1).padStart(4, '0')}`,
    ordinal: index + 1,
  }));
}

async function loadCheckpoint(
  outputPath: string,
  knownItemIds: ReadonlySet<string>,
): Promise<CheckpointState> {
  const state: CheckpointState = {
    completedKeys: new Set<string>(),
    tokenTotals: { input: 0, output: 0, total: 0 },
  };

  if (!(await fileExists(outputPath))) return state;

  const rawText = await readFile(outputPath, 'utf8');
  const normalizedText = await normalizeCheckpointEnding(outputPath, rawText);
  const lines = normalizedText.split(/\r?\n/);
  let ignored = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === undefined || line.trim().length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      ignored += 1;
      writeErr(`[${timeLabel()}] Ligne checkpoint ignoree (JSON invalide): ${lineIndex + 1}`);
      continue;
    }

    if (!isPoolRecord(parsed)) {
      ignored += 1;
      writeErr(`[${timeLabel()}] Ligne checkpoint ignoree (format invalide): ${lineIndex + 1}`);
      continue;
    }

    if (
      !knownItemIds.has(parsed.item_id) ||
      parsed.tirage < 1 ||
      parsed.tirage > CONFIG.drawsPerItem
    ) {
      ignored += 1;
      continue;
    }

    const key = checkpointKey(parsed.item_id, parsed.tirage);
    if (state.completedKeys.has(key)) continue;
    state.completedKeys.add(key);
    addTokens(state.tokenTotals, parsed.tokens);
  }

  if (ignored > 0) {
    writeErr(`[${timeLabel()}] ${ignored} ligne(s) checkpoint ignoree(s).`);
  }

  return state;
}

async function normalizeCheckpointEnding(outputPath: string, text: string): Promise<string> {
  if (text.length === 0 || text.endsWith('\n')) return text;

  const tailStart = text.lastIndexOf('\n') + 1;
  const tail = text.slice(tailStart);
  if (tail.trim().length === 0) {
    await appendFile(outputPath, '\n', 'utf8');
    return `${text}\n`;
  }

  try {
    JSON.parse(tail);
    await appendFile(outputPath, '\n', 'utf8');
    return `${text}\n`;
  } catch {
    const kept = text.slice(0, tailStart);
    await truncate(outputPath, Buffer.byteLength(kept, 'utf8'));
    writeErr(
      `[${timeLabel()}] Derniere ligne checkpoint tronquee et ignoree (probable interruption pendant ecriture).`,
    );
    return kept;
  }
}

async function callWithRetries(adapter: ProviderAdapter, item: Gsm8kItem): Promise<LLMResponse> {
  for (let attempt = 1; attempt <= CONFIG.maxAttempts; attempt += 1) {
    try {
      return await adapter.call({
        messages: [{ role: 'user', content: item.question }],
        temperature: CONFIG.temperature,
      });
    } catch (error) {
      if (!shouldRetry(error) || attempt >= CONFIG.maxAttempts) {
        throw error;
      }

      const delayMs = computeRetryDelayMs(attempt, error);
      writeErr(
        `[${timeLabel()}] Retry ${attempt}/${CONFIG.maxAttempts - 1} pour ${item.itemId} dans ${formatDuration(delayMs)} (${formatErrorKind(error)}).`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error('Retry loop exhausted without an error.');
}

function shouldRetry(error: unknown): boolean {
  if (
    error instanceof RateLimitError ||
    error instanceof TimeoutError ||
    error instanceof OverloadedError
  ) {
    return true;
  }

  if (error instanceof TransientProviderError) {
    return error.networkErrorKind !== undefined || error.status === undefined;
  }

  return false;
}

function computeRetryDelayMs(attempt: number, error: unknown): number {
  const nominal = Math.min(CONFIG.retryBaseMs * 2 ** (attempt - 1), CONFIG.retryMaxMs);
  const jittered = Math.round(nominal * (0.8 + Math.random() * 0.4));
  const retryAfterMs =
    error instanceof RateLimitError || error instanceof OverloadedError
      ? error.retryAfterMs
      : undefined;
  const withRetryAfter = retryAfterMs === undefined ? jittered : Math.max(jittered, retryAfterMs);
  return Math.min(withRetryAfter, CONFIG.retryMaxMs);
}

function buildPoolRecord(item: Gsm8kItem, draw: number, response: LLMResponse): PoolRecord {
  const input = response.usage.inputTokens ?? 0;
  const output = response.usage.outputTokens ?? 0;
  const total = response.usage.totalTokens ?? input + output;

  return {
    item_id: item.itemId,
    tirage: draw,
    prompt: item.question,
    response: response.content,
    tokens: { input, output, total },
    timestamp: new Date().toISOString(),
  };
}

async function appendPoolRecord(outputPath: string, record: PoolRecord): Promise<void> {
  await appendFile(outputPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function printProgress(
  label: string,
  items: readonly Gsm8kItem[],
  checkpoint: CheckpointState,
): void {
  writeOut(
    `[${timeLabel()}] ${label} - Tirages: ${countCompletedRecords(items, checkpoint.completedKeys)}/${items.length * CONFIG.drawsPerItem} - Tokens total: ${formatInteger(checkpoint.tokenTotals.total)} - Cout estime: ${formatUsd(estimateCost(checkpoint.tokenTotals))}`,
  );
}

function countCompletedDraws(itemId: string, completedKeys: ReadonlySet<string>): number {
  let count = 0;
  for (let draw = 1; draw <= CONFIG.drawsPerItem; draw += 1) {
    if (completedKeys.has(checkpointKey(itemId, draw))) count += 1;
  }
  return count;
}

function countCompletedItems(
  items: readonly Gsm8kItem[],
  completedKeys: ReadonlySet<string>,
): number {
  let count = 0;
  for (const item of items) {
    if (countCompletedDraws(item.itemId, completedKeys) >= CONFIG.drawsPerItem) count += 1;
  }
  return count;
}

function countCompletedRecords(
  items: readonly Gsm8kItem[],
  completedKeys: ReadonlySet<string>,
): number {
  let count = 0;
  for (const item of items) {
    count += countCompletedDraws(item.itemId, completedKeys);
  }
  return count;
}

function checkpointKey(itemId: string, draw: number): string {
  return `${itemId}:${draw}`;
}

function addTokens(total: TokenTotals, tokens: TokenUsage): void {
  total.input += tokens.input;
  total.output += tokens.output;
  total.total += tokens.total;
}

function estimateCost(tokens: TokenTotals): number {
  return (
    (tokens.input / 1_000_000) * CONFIG.inputUsdPer1M +
    (tokens.output / 1_000_000) * CONFIG.outputUsdPer1M
  );
}

function isGsm8kRawItem(value: unknown): value is Gsm8kRawItem {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.question === 'string' && typeof obj.answer === 'string';
}

function isPoolRecord(value: unknown): value is PoolRecord {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.item_id === 'string' &&
    Number.isInteger(obj.tirage) &&
    typeof obj.prompt === 'string' &&
    typeof obj.response === 'string' &&
    typeof obj.timestamp === 'string' &&
    isTokenUsage(obj.tokens)
  );
}

function isTokenUsage(value: unknown): value is TokenUsage {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.input === 'number' && typeof obj.output === 'number' && typeof obj.total === 'number'
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNodeErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

function readStringEnv(name: string, defaultValue: string): string {
  const raw = process.env[name]?.trim();
  return raw === undefined || raw.length === 0 ? defaultValue : raw;
}

function readPositiveIntEnv(name: string, defaultValue: number): number {
  const value = readNumberEnv(name, defaultValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function readNonNegativeNumberEnv(name: string, defaultValue: number): number {
  const value = readNumberEnv(name, defaultValue);
  if (value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return value;
}

function readNumberEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) return defaultValue;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function timeLabel(): string {
  return new Date().toTimeString().slice(0, 8);
}

function formatInteger(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function formatUsd(value: number): string {
  return `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

function formatErrorKind(error: unknown): string {
  if (error instanceof Error && 'kind' in error) {
    const kind = (error as { readonly kind?: unknown }).kind;
    if (typeof kind === 'string') return kind;
  }
  return error instanceof Error ? error.name : typeof error;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function writeOut(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeErr(message: string): void {
  process.stderr.write(`${message}\n`);
}

main().catch((error) => {
  writeErr(`[${timeLabel()}] Fatal: ${formatError(error)}`);
  process.exitCode = 1;
});
