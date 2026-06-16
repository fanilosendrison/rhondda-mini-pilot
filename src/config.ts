export const GSM8K_TEST_URL =
  'https://raw.githubusercontent.com/openai/grade-school-math/master/grade_school_math/data/test.jsonl';

export const CONFIG = {
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
