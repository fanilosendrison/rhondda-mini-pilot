import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CONFIG } from './config.js';
import type { Gsm8kRawItem, PoolRecord } from './domain/types.js';
import { isGsm8kRawItem, isPoolRecord } from './domain/types.js';
import { writeErr, writeOut } from './infra/util.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const K_VALUES = [1, 5, 10, 20, 30] as const;
const N_BOOTSTRAPS = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KSweepRow {
  readonly k: number;
  readonly accuracyMean: number;
  readonly accuracyStd: number;
  readonly stabilityMean: number;
  readonly stabilityStd: number;
  readonly pctStabAbove95: number;
  readonly pctStabAbove90: number;
  readonly pearson: number;
  readonly spearman: number;
}

interface ItemMetrics {
  readonly itemId: string;
  readonly accuracy: number;
  readonly stability: number;
}

interface VoteChange {
  readonly itemId: string;
  readonly voteK5: number | null;
  readonly voteK20: number | null;
  readonly gold: number | null;
}

interface AnalysisResult {
  readonly totalItems: number;
  readonly totalRecords: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly costEstimateUsd: number;
  readonly kSweep: readonly KSweepRow[];
  readonly voteChanges: readonly VoteChange[];
  readonly unstableAtK20: { readonly count: number; readonly avgAccuracy: number | null };
  readonly stableAtK20: { readonly count: number; readonly avgAccuracy: number | null };
  readonly pathologicalHighStabLowAcc: readonly ItemMetrics[];
  readonly alwaysWrongCount: number;
  readonly perfectAccCount: number;
  readonly perItemK10: readonly ItemMetrics[];
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

function parseJsonl<T>(text: string, guard: (v: unknown) => v is T, source: string): readonly T[] {
  const items: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parsed: unknown = JSON.parse(line);
    if (!guard(parsed)) {
      throw new Error(`${source}: unexpected record shape`);
    }
    items.push(parsed);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Answer extraction
// ---------------------------------------------------------------------------

function normalizeNumber(s: string): number | null {
  const cleaned = s.replace(/[$,\s]/g, '').replace(/\.$/, '');
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

/** Extract the numerical answer from GSM8K ground truth (after ####). */
function extractGoldAnswer(answerStr: string): number | null {
  const match = answerStr.match(/####\s*(.+)/);
  if (match?.[1] === undefined) return null;
  return normalizeNumber(match[1].trim());
}

/** Extract the numerical answer from a model response. */
function extractModelAnswer(responseStr: string): number | null {
  // Strategy 1: #### pattern (if model mimics GSM8K format)
  const hashMatch = responseStr.match(/####\s*(.+)/);
  if (hashMatch?.[1] !== undefined) return normalizeNumber(hashMatch[1].trim());

  // Strategy 2: last bold number (**X**)
  const boldMatches = [...responseStr.matchAll(/\*\*\$?([\d,]+(?:\.\d+)?)\*\*/g)];
  const lastBold = boldMatches[boldMatches.length - 1];
  if (lastBold?.[1] !== undefined) return normalizeNumber(lastBold[1]);

  // Strategy 3: "Answer: X"
  const answerMatch = responseStr.match(/[Aa]nswer[:\s]*\$?([\d,]+(?:\.\d+)?)/);
  if (answerMatch?.[1] !== undefined) return normalizeNumber(answerMatch[1]);

  // Strategy 4: last number
  const allNumbers = [...responseStr.matchAll(/\$?([\d,]+(?:\.\d+)?)/g)];
  const lastNum = allNumbers[allNumbers.length - 1];
  if (lastNum?.[1] !== undefined) return normalizeNumber(lastNum[1]);

  return null;
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

function mean(arr: readonly number[]): number {
  let sum = 0;
  for (const v of arr) sum += v;
  return sum / arr.length;
}

function stddev(arr: readonly number[]): number {
  const m = mean(arr);
  let sumSq = 0;
  for (const v of arr) sumSq += (v - m) ** 2;
  return Math.sqrt(sumSq / arr.length);
}

function pearsonCorr(x: readonly number[], y: readonly number[]): number {
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < x.length; i += 1) {
    const xi = x[i];
    const yi = y[i];
    if (xi === undefined || yi === undefined) continue;
    const dx = xi - mx;
    const dy = yi - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

function rank(arr: readonly number[]): readonly number[] {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(arr.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j < indexed.length && indexed[j]?.v === indexed[i]?.v) j += 1;
    const avgRank = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k += 1) {
      const entry = indexed[k];
      if (entry !== undefined) ranks[entry.i] = avgRank;
    }
    i = j;
  }
  return ranks;
}

function spearmanCorr(x: readonly number[], y: readonly number[]): number {
  return pearsonCorr(rank(x), rank(y));
}

// ---------------------------------------------------------------------------
// Majority vote & bootstrap
// ---------------------------------------------------------------------------

function majorityVote(answers: readonly (number | null)[]): number | null {
  const counts = new Map<string, number>();
  for (const a of answers) {
    if (a === null) continue;
    const key = String(a);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let bestKey: string | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }
  return bestKey === null ? null : Number.parseFloat(bestKey);
}

/** Mulberry32 — fast 32-bit PRNG, deterministic given the same seed. */
function createRng(seed: number): () => number {
  let state = seed | 0;
  return (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function readSeed(): number {
  const env = process.env.SEED?.trim();
  if (env !== undefined && env.length > 0) {
    const parsed = Number(env);
    if (Number.isFinite(parsed)) return parsed;
  }
  // Default: date-based seed — same day = same results
  const today = new Date();
  return today.getFullYear() * 10_000 + (today.getMonth() + 1) * 100 + today.getDate();
}

function sampleWithReplacement(
  arr: readonly (number | null)[],
  k: number,
  nextFloat: () => number,
): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < k; i += 1) {
    const idx = Math.floor(nextFloat() * arr.length);
    result.push(arr[idx] ?? null);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const poolPath = path.resolve(process.cwd(), CONFIG.outputFile);
  const cachePath = path.resolve(process.cwd(), CONFIG.datasetCacheFile);

  writeErr('Chargement des donnees...');

  const poolText = await readFile(poolPath, 'utf8');
  const poolRecords = parseJsonl(poolText, isPoolRecord, poolPath);

  const cacheText = await readFile(cachePath, 'utf8');
  const cacheRecords = parseJsonl(cacheText, isGsm8kRawItem, cachePath);

  // Build gold answers map
  const goldAnswers = new Map<string, number | null>();
  cacheRecords.forEach((item: Gsm8kRawItem, idx: number) => {
    const itemId = `gsm8k_test_${String(idx + 1).padStart(4, '0')}`;
    goldAnswers.set(itemId, extractGoldAnswer(item.answer));
  });

  // Group pool records by item_id
  const itemPools = new Map<string, PoolRecord[]>();
  for (const rec of poolRecords) {
    let pool = itemPools.get(rec.item_id);
    if (pool === undefined) {
      pool = [];
      itemPools.set(rec.item_id, pool);
    }
    pool.push(rec);
  }

  const itemIds = [...itemPools.keys()]
    .filter((id) => (itemPools.get(id)?.length ?? 0) >= CONFIG.drawsPerItem)
    .sort();
  writeErr(`Items avec ${CONFIG.drawsPerItem} tirages: ${itemIds.length}`);

  // Extract model answers per item
  const itemAnswers = new Map<string, readonly (number | null)[]>();
  for (const itemId of itemIds) {
    const records = itemPools.get(itemId) ?? [];
    itemAnswers.set(
      itemId,
      records.map((r) => extractModelAnswer(r.response)),
    );
  }

  // Token totals
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (const rec of poolRecords) {
    totalInputTokens += rec.tokens.input;
    totalOutputTokens += rec.tokens.output;
  }
  const costEstimateUsd =
    (totalInputTokens / 1_000_000) * CONFIG.inputUsdPer1M +
    (totalOutputTokens / 1_000_000) * CONFIG.outputUsdPer1M;

  // Deterministic PRNG — same pool + same date = same results.
  // Override with SEED env var for exact reproduction across days.
  const seed = readSeed();
  const nextFloat = createRng(seed);
  writeErr(`Seed: ${seed} (reproductible — set SEED=${seed} pour reproduire cette analyse)`);

  // ---------------------------------------------------------------------------
  // K-sweep: accuracy & stability per item
  // ---------------------------------------------------------------------------

  const kSweep: KSweepRow[] = [];
  const perItemResults = new Map<number, { accuracies: number[]; stabilities: number[] }>();

  for (const k of K_VALUES) {
    const accuracies: number[] = [];
    const stabilities: number[] = [];

    for (const itemId of itemIds) {
      const answers = itemAnswers.get(itemId) ?? [];
      const gold = goldAnswers.get(itemId) ?? null;

      const bootstrapVotes: (number | null)[] = [];
      for (let b = 0; b < N_BOOTSTRAPS; b += 1) {
        bootstrapVotes.push(majorityVote(sampleWithReplacement(answers, k, nextFloat)));
      }

      const nCorrect = bootstrapVotes.filter((v) => v === gold).length;
      const accuracy = nCorrect / N_BOOTSTRAPS;

      const overallMajority = majorityVote(bootstrapVotes);
      const nAgree = bootstrapVotes.filter((v) => v === overallMajority).length;
      const stability = nAgree / N_BOOTSTRAPS;

      accuracies.push(accuracy);
      stabilities.push(stability);
    }

    perItemResults.set(k, { accuracies, stabilities });

    kSweep.push({
      k,
      accuracyMean: mean(accuracies),
      accuracyStd: stddev(accuracies),
      stabilityMean: mean(stabilities),
      stabilityStd: stddev(stabilities),
      pctStabAbove95: (stabilities.filter((s) => s > 0.95).length / stabilities.length) * 100,
      pctStabAbove90: (stabilities.filter((s) => s > 0.9).length / stabilities.length) * 100,
      pearson: pearsonCorr(accuracies, stabilities),
      spearman: spearmanCorr(accuracies, stabilities),
    });
  }

  // ---------------------------------------------------------------------------
  // Cross-k analysis
  // ---------------------------------------------------------------------------

  // Vote changes between k=5 and k=20 (deterministic, first N draws)
  const voteChanges: VoteChange[] = [];
  for (const itemId of itemIds) {
    const answers = itemAnswers.get(itemId) ?? [];
    const vote5 = majorityVote(answers.slice(0, 5));
    const vote20 = majorityVote(answers.slice(0, 20));
    if (vote5 !== vote20) {
      voteChanges.push({
        itemId,
        voteK5: vote5,
        voteK20: vote20,
        gold: goldAnswers.get(itemId) ?? null,
      });
    }
  }

  // Unstable / stable at k=20
  const k20data = perItemResults.get(20);
  const k20acc = k20data?.accuracies ?? [];
  const k20stab = k20data?.stabilities ?? [];

  const unstableItems: ItemMetrics[] = [];
  const stableItems: ItemMetrics[] = [];
  for (let i = 0; i < itemIds.length; i += 1) {
    const itemId = itemIds[i];
    const acc = k20acc[i];
    const stab = k20stab[i];
    if (itemId === undefined || acc === undefined || stab === undefined) continue;
    if (stab < 0.8) unstableItems.push({ itemId, accuracy: acc, stability: stab });
    if (stab > 0.95) stableItems.push({ itemId, accuracy: acc, stability: stab });
  }

  // Pathological: high stability, low accuracy at k=10
  const k10data = perItemResults.get(10);
  const k10acc = k10data?.accuracies ?? [];
  const k10stab = k10data?.stabilities ?? [];
  const pathologicalHighStabLowAcc: ItemMetrics[] = [];
  for (let i = 0; i < itemIds.length; i += 1) {
    const itemId = itemIds[i];
    const acc = k10acc[i];
    const stab = k10stab[i];
    if (itemId === undefined || acc === undefined || stab === undefined) continue;
    if (stab > 0.95 && acc < 0.5) {
      pathologicalHighStabLowAcc.push({ itemId, accuracy: acc, stability: stab });
    }
  }

  // Always wrong / perfect at k=30
  const k30data = perItemResults.get(30);
  const k30acc = k30data?.accuracies ?? [];
  const alwaysWrongCount = k30acc.filter((a) => a === 0).length;
  const perfectAccCount = k30acc.filter((a) => a === 1.0).length;

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------

  const result: AnalysisResult = {
    totalItems: itemIds.length,
    totalRecords: poolRecords.length,
    totalInputTokens,
    totalOutputTokens,
    costEstimateUsd,
    kSweep,
    voteChanges,
    unstableAtK20: {
      count: unstableItems.length,
      avgAccuracy: unstableItems.length > 0 ? mean(unstableItems.map((u) => u.accuracy)) : null,
    },
    stableAtK20: {
      count: stableItems.length,
      avgAccuracy: stableItems.length > 0 ? mean(stableItems.map((u) => u.accuracy)) : null,
    },
    pathologicalHighStabLowAcc,
    alwaysWrongCount,
    perfectAccCount,
    perItemK10: itemIds.map((id, i) => ({
      itemId: id,
      accuracy: k10acc[i] ?? 0,
      stability: k10stab[i] ?? 0,
    })),
  };

  // Machine-readable JSON to stdout
  writeOut(JSON.stringify(result, null, 2));

  // Human-readable report to analyses/
  const today = new Date().toISOString().slice(0, 10);
  const modelSlug = CONFIG.model.replace(/[^a-z0-9.-]/gi, '_');
  const reportName = `${today}_rhondda-pilot_${modelSlug}.md`;
  const reportDir = path.resolve(process.cwd(), 'analyses');
  const reportPath = path.join(reportDir, reportName);

  await mkdir(reportDir, { recursive: true });

  const lines: string[] = [];
  const header = (k: number) => {
    const r = kSweep.find((row) => row.k === k);
    if (r === undefined) return '';
    return `| ${k} | ${r.accuracyMean.toFixed(3)} | ${r.accuracyStd.toFixed(3)} | ${r.stabilityMean.toFixed(3)} | ${r.stabilityStd.toFixed(3)} | ${r.pctStabAbove95.toFixed(1)}% | ${r.pearson.toFixed(3)} | ${r.spearman.toFixed(3)} |`;
  };

  lines.push(`# Rhondda analysis — ${CONFIG.model}`);
  lines.push('');
  lines.push(`**Date:** ${today}  `);
  lines.push(`**Items:** ${itemIds.length}  `);
  lines.push(`**Draws:** ${poolRecords.length}  `);
  lines.push(`**Cost:** $${costEstimateUsd.toFixed(2)}  `);
  lines.push('');
  lines.push(
    `> **Note:** Bootstrap resampling (N=200) uses a deterministic PRNG seeded from the date or \`SEED\` env var. Seed for this run: **${seed}**. Re-running with the same seed on the same pool yields identical numbers.`,
  );
  lines.push('');
  lines.push('## K-sweep');
  lines.push('');
  lines.push('| k | Acc. | σ(Acc) | Stab. | σ(Stab) | %>0.95 | Pearson | Spearman |');
  lines.push('|---|------|--------|-------|---------|--------|---------|----------|');
  for (const k of K_VALUES) lines.push(header(k));
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Perfect accuracy (k=30) | ${perfectAccCount} |`);
  lines.push(`| Always wrong (k=30) | ${alwaysWrongCount} |`);
  lines.push(
    `| Systematic bias (stab>0.95, acc<0.5 at k=10) | ${pathologicalHighStabLowAcc.length} |`,
  );
  lines.push(`| Vote changes k=5→k=20 | ${voteChanges.length} |`);
  lines.push(
    `| Unstable at k=20 (stab<0.8) | ${unstableItems.length} (avg acc: ${unstableItems.length > 0 ? mean(unstableItems.map((u) => u.accuracy)).toFixed(3) : 'N/A'}) |`,
  );
  lines.push(
    `| Stable at k=20 (stab>0.95) | ${stableItems.length} (avg acc: ${stableItems.length > 0 ? mean(stableItems.map((u) => u.accuracy)).toFixed(3) : 'N/A'}) |`,
  );

  await writeFile(reportPath, `${lines.join('\n')}\n`, 'utf8');

  // Console summary
  writeErr('');
  writeErr(`Rapport ecrit : ${reportPath}`);
  writeErr(
    `Items: ${itemIds.length} | Cout: $${costEstimateUsd.toFixed(2)} | Accuracy parfaite: ${perfectAccCount} | Toujours faux: ${alwaysWrongCount}`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    writeErr(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
