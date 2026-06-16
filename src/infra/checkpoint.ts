import { appendFile, readFile, truncate } from 'node:fs/promises';

import { CONFIG } from '../config.js';
import { checkpointKey } from '../domain/pool.js';
import type { CheckpointState, PoolRecord } from '../domain/types.js';
import { isPoolRecord } from '../domain/types.js';
import { fileExists, timeLabel, writeErr } from './util.js';

export async function loadCheckpoint(
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
    state.tokenTotals.input += parsed.tokens.input;
    state.tokenTotals.output += parsed.tokens.output;
    state.tokenTotals.total += parsed.tokens.total;
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

export async function appendPoolRecord(outputPath: string, record: PoolRecord): Promise<void> {
  await appendFile(outputPath, `${JSON.stringify(record)}\n`, 'utf8');
}
