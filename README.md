# Rhondda Pilot - Data Collection Script

Mini-pilote pour la validation de la methode **Rhondda**. Le script collecte 30 reponses pour chacun des 200 premiers items du test set **GSM8K**, via OpenAI `gpt-5.4-mini` et le harness `@fanilosendrison/llm-runtime`.

Le resultat principal est `gsm8k_pool.jsonl`, avec une ligne JSON par reponse:

```json
{"item_id":"gsm8k_test_0001","tirage":1,"prompt":"...","response":"...","tokens":{"input":180,"output":95,"total":275},"timestamp":"2026-06-16T14:22:10.123Z"}
```

## Installation

```bash
# 1. Installer les dependances
npm install

# 2. Configurer la cle OpenAI
cp .env.example .env
```

Renseigner `OPENAI_API_KEY` dans `.env`.

## Lancer la collecte

```bash
npm start
```

`npm start` compile `src/collect.ts`, puis lance `dist/src/collect.js`. `npm run dev` est un alias equivalent.

Le script:

- telecharge le test set GSM8K depuis le depot public `openai/grade-school-math`;
- met le dataset en cache local dans `gsm8k_test_cache.jsonl`;
- ecrit chaque reponse immediatement dans `gsm8k_pool.jsonl`;
- reprend automatiquement les tirages manquants si le fichier JSONL existe deja;
- applique un backoff exponentiel avec jitter sur les 429, timeouts et erreurs reseau;
- journalise les autres erreurs et passe a l'item suivant;
- affiche les tokens cumules et le cout estime en temps reel.

## Configuration

Les valeurs par defaut correspondent au mini-pilote demande:

```bash
OPENAI_MODEL=gpt-5.4-mini
OPENAI_TEMPERATURE=0.7
GSM8K_ITEM_COUNT=200
GSM8K_DRAWS_PER_ITEM=30
GSM8K_POOL_FILE=gsm8k_pool.jsonl
GSM8K_DATASET_CACHE_FILE=gsm8k_test_cache.jsonl
OPENAI_INPUT_USD_PER_1M=0.75
OPENAI_OUTPUT_USD_PER_1M=4.50
```

Les tarifs par defaut utilisent la tarification standard OpenAI pour `gpt-5.4-mini` au 2026-06-16. Ajuster `OPENAI_INPUT_USD_PER_1M` et `OPENAI_OUTPUT_USD_PER_1M` si votre endpoint ou votre mode de traitement facture autrement.

## Verification

```bash
npm run typecheck
npm run lint
npm test
```
