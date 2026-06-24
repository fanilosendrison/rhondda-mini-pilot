import 'dotenv/config';

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOpenAIAdapter } from '@fanilosendrison/llm-runtime';

import { CONFIG, GSM8K_TEST_URL } from './config.js';
import {
  addTokens,
  buildPoolRecord,
  checkpointKey,
  countCompletedDraws,
  countCompletedItems,
  countCompletedRecords,
  estimateCost,
} from './domain/pool.js';
import type { CheckpointState, Gsm8kItem } from './domain/types.js';
import { appendPoolRecord, loadCheckpoint } from './infra/checkpoint.js';
import { loadGsm8kItems } from './infra/dataset.js';
import { callWithRetries } from './infra/llm.js';
import {
  formatError,
  formatInteger,
  formatUsd,
  timeLabel,
  writeErr,
  writeOut,
} from './infra/util.js';

let stopRequested = false;

process.once('SIGINT', () => {
  stopRequested = true;
  writeErr(
    `[${timeLabel()}] Interruption demandee. Le script termine l'appel en cours puis s'arrete.`,
  );
});

export async function main(): Promise<void> {
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

      let response: Awaited<ReturnType<typeof callWithRetries>>;
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

function printProgress(
  label: string,
  items: readonly Gsm8kItem[],
  checkpoint: CheckpointState,
): void {
  writeOut(
    `[${timeLabel()}] ${label} - Tirages: ${countCompletedRecords(items, checkpoint.completedKeys)}/${items.length * CONFIG.drawsPerItem} - Tokens total: ${formatInteger(checkpoint.tokenTotals.total)} - Cout estime: ${formatUsd(estimateCost(checkpoint.tokenTotals))}`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    writeErr(`[${timeLabel()}] Fatal: ${formatError(error)}`);
    process.exitCode = 1;
  });
}
