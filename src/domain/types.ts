export interface Gsm8kRawItem {
  readonly question: string;
  readonly answer: string;
}

export interface Gsm8kItem extends Gsm8kRawItem {
  readonly itemId: string;
  readonly ordinal: number;
}

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly total: number;
}

export interface PoolRecord {
  readonly item_id: string;
  readonly tirage: number;
  readonly prompt: string;
  readonly response: string;
  readonly tokens: TokenUsage;
  readonly timestamp: string;
}

export interface TokenTotals {
  input: number;
  output: number;
  total: number;
}

export interface CheckpointState {
  readonly completedKeys: Set<string>;
  readonly tokenTotals: TokenTotals;
}

export function isGsm8kRawItem(value: unknown): value is Gsm8kRawItem {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.question === 'string' && typeof obj.answer === 'string';
}

export function isPoolRecord(value: unknown): value is PoolRecord {
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

export function isTokenUsage(value: unknown): value is TokenUsage {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.input === 'number' && typeof obj.output === 'number' && typeof obj.total === 'number'
  );
}
