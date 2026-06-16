import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { GSM8K_TEST_URL } from '../config.js';
import type { Gsm8kItem, Gsm8kRawItem } from '../domain/types.js';
import { isGsm8kRawItem } from '../domain/types.js';
import { fileExists, formatError, timeLabel, writeErr, writeOut } from './util.js';

export async function loadGsm8kItems(
  cachePath: string,
  limit: number,
): Promise<readonly Gsm8kItem[]> {
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

export function parseDatasetJsonl(text: string, source: string): readonly Gsm8kRawItem[] {
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

export function withItemIds(items: readonly Gsm8kRawItem[]): readonly Gsm8kItem[] {
  return items.map((item, index) => ({
    ...item,
    itemId: `gsm8k_test_${String(index + 1).padStart(4, '0')}`,
    ordinal: index + 1,
  }));
}
