# Rhondda Pilot — GSM8K Pool & Analysis

Mini-pilot for validating the **Rhondda** method. Two phases:

1. **Collection** — 30 responses for each of the first 200 items of the **GSM8K** test set, via OpenAI `gpt-5.4-mini` and the [`@fanilosendrison/llm-runtime`](https://www.npmjs.com/package/@fanilosendrison/llm-runtime) harness.
2. **Analysis** — bootstrap, stability, accuracy-vs-k curves, pathological item detection.

> **Requirements:** Node.js ≥ 20, an OpenAI API key with access to `gpt-5.4-mini`.

## Installation

```bash
npm install
cp .env.example .env   # then fill in your OPENAI_API_KEY
```

## Collection

```bash
npm start
```

Generates `data/gsm8k_pool.jsonl` — one JSON line per response:

```json
{"item_id":"gsm8k_test_0001","tirage":1,"prompt":"...","response":"...","tokens":{"input":180,"output":95,"total":275},"timestamp":"2026-06-16T14:22:10.123Z"}
```

- **~6 000 API calls**, budget **~$4**, runtime **~30–60 min** depending on rate limits.
- Idempotent: interrupted runs resume where they left off.
- Real-time display of cumulative tokens and estimated cost.

## Analysis

```bash
npm run analyze
```

Reads the pool and cache from `data/`, then computes:

- **K-sweep** — bootstrap accuracy and stability (N=200) for k ∈ {1, 5, 10, 20, 30}
- **Correlations** — Pearson and Spearman between per-item accuracy and stability
- **Vote changes** — items whose majority vote flips between k=5 and k=20
- **Pathological items** — high stability but low accuracy (systematic bias)
- **Unstable items** — stability < 0.8 at k=20

Full results as JSON to stdout. A markdown report (e.g. `analyses/2026-06-24_rhondda-pilot_gpt-5.4-mini.md`) is written to `analyses/`.

## Configuration

All values have sensible defaults. Override via environment variables:

```bash
OPENAI_MODEL=gpt-5.4-mini
OPENAI_TEMPERATURE=0.7
GSM8K_ITEM_COUNT=200
GSM8K_DRAWS_PER_ITEM=30
GSM8K_POOL_FILE=data/gsm8k_pool.jsonl
GSM8K_DATASET_CACHE_FILE=data/gsm8k_test_cache.jsonl
OPENAI_INPUT_USD_PER_1M=0.75
OPENAI_OUTPUT_USD_PER_1M=4.50
```

## Verification

```bash
npm run typecheck
npm run lint
npm test
```

## Design Principles

These principles guide all architectural decisions:

- **Reproducibility** — same config → same protocol. Every response is traceable to its `(item_id, draw_index)`.
- **Pool fidelity** — no silent data loss. Every failed call is logged, never masked; the output JSONL reflects exactly what was collected.
- **Cost control** — budget ~$4 for ~6000 calls. No redundant calls; idempotent resume if collection is interrupted.
- **Harness-first** — all LLM calls go through `@fanilosendrison/llm-runtime`, never raw HTTP. The harness provides the error taxonomy (RateLimitError, TimeoutError, etc.); retry with backoff is pilot-side to allow skipping to the next item when attempts are exhausted.

## Architecture

```
src/
  domain/        Protocol logic (item selection, draw counting, answer extraction) — zero external dependencies
  infra/         I/O layer (dataset fetch, harness calls, JSONL checkpoint, retry)
tests/           Vitest test suite
data/            Generated pool & cache — gitignored
analyses/        Analysis reports — gitignored
```

- **domain/** is pure — no HTTP, no filesystem, no harness imports. Only types and computation.
- **infra/** owns all side effects — network, disk, environment.
- One file = one coherent concept. If a file name no longer describes its entire content, split it.

## Protocol Rules

- **Model is hardcoded** — `gpt-5.4-mini`, never arbitrarily configurable. This is a protocol constant.
- **Append-only output** — one JSONL record per `(item_id, draw_index)`. Never overwrite a running pool; resume picks up where it left off.
- **No silent loss** — failed draws after retry exhaustion are logged (pino) and the inner loop breaks to the next item. The gap is visible in the output.
- **API key via environment** — `OPENAI_API_KEY` loaded from `.env`, validated at startup. Never hardcoded, never committed.
