# Rhondda Pilot — GSM8K Pool & Analysis

Mini-pilot for validating the **Rhondda** method. Two phases:

1. **Collection** — 30 responses for each of the first 200 items of the **GSM8K** test set, via OpenAI `gpt-5.4-mini` and the [`@fanilosendrison/llm-runtime`](https://www.npmjs.com/package/@fanilosendrison/llm-runtime) harness.
2. **Analysis** — bootstrap, stability, accuracy-vs-k curves, pathological item detection.

## Installation

```bash
# 1. Install dependencies
npm install

# 2. Set your OpenAI key
cp .env.example .env
```

Fill in `OPENAI_API_KEY` in `.env`.

## Collection

```bash
npm start
```

`npm start` compiles `src/collect.ts`, then runs `dist/src/collect.js`. `npm run dev` is an equivalent alias.

The script:

- downloads the GSM8K test set from the public `openai/grade-school-math` repository;
- caches the dataset locally in `data/gsm8k_test_cache.jsonl`;
- writes each response immediately to `data/gsm8k_pool.jsonl`;
- automatically resumes missing draws if the JSONL file already exists;
- applies exponential backoff with jitter on 429s, timeouts, and network errors;
- logs other errors and skips to the next item;
- displays cumulative tokens and estimated cost in real time.

### Output format

One JSON line per response in `data/gsm8k_pool.jsonl`:

```json
{"item_id":"gsm8k_test_0001","tirage":1,"prompt":"...","response":"...","tokens":{"input":180,"output":95,"total":275},"timestamp":"2026-06-16T14:22:10.123Z"}
```

## Analysis

```bash
npm run analyze
```

Reads `data/gsm8k_pool.jsonl` and `data/gsm8k_test_cache.jsonl`, then computes:

- **K-sweep** — bootstrap accuracy and stability (N=200) for k ∈ {1, 5, 10, 20, 30}
- **Correlations** — Pearson and Spearman between per-item accuracy and stability
- **Vote changes** — items whose majority vote flips between k=5 and k=20
- **Pathological items** — high stability but low accuracy (systematic bias)
- **Unstable items** — stability < 0.8 at k=20
- **Counts** — always-wrong items, perfect-accuracy items at k=30

Full results are written as JSON to stdout. A human-readable summary is written to stderr.

## Configuration

Default values match the requested mini-pilot:

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

Default pricing uses standard OpenAI rates for `gpt-5.4-mini` as of 2026-06-16. Adjust `OPENAI_INPUT_USD_PER_1M` and `OPENAI_OUTPUT_USD_PER_1M` if your endpoint or billing model differs.

## Verification

```bash
npm run typecheck
npm run lint
npm test
```
