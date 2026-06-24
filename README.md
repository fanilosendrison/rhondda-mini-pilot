# Rhondda Pilot — GSM8K Pool & Analysis

Mini-pilote pour la validation de la méthode **Rhondda**. Deux phases :

1. **Collecte** — 30 réponses pour chacun des 200 premiers items du test set **GSM8K**, via OpenAI `gpt-5.4-mini` et le harness [`@fanilosendrison/llm-runtime`](https://www.npmjs.com/package/@fanilosendrison/llm-runtime).
2. **Analyse** — bootstrap, stabilité, courbes accuracy vs k, détection d'items pathologiques.

## Installation

```bash
# 1. Installer les dépendances
npm install

# 2. Configurer la clé OpenAI
cp .env.example .env
```

Renseigner `OPENAI_API_KEY` dans `.env`.

## Collecte

```bash
npm start
```

`npm start` compile `src/collect.ts`, puis lance `dist/src/collect.js`. `npm run dev` est un alias équivalent.

Le script :

- télécharge le test set GSM8K depuis le dépôt public `openai/grade-school-math` ;
- met le dataset en cache local dans `gsm8k_test_cache.jsonl` ;
- écrit chaque réponse immédiatement dans `gsm8k_pool.jsonl` ;
- reprend automatiquement les tirages manquants si le fichier JSONL existe déjà ;
- applique un backoff exponentiel avec jitter sur les 429, timeouts et erreurs réseau ;
- journalise les autres erreurs et passe à l'item suivant ;
- affiche les tokens cumulés et le coût estimé en temps réel.

### Format de sortie

Une ligne JSON par réponse dans `gsm8k_pool.jsonl` :

```json
{"item_id":"gsm8k_test_0001","tirage":1,"prompt":"...","response":"...","tokens":{"input":180,"output":95,"total":275},"timestamp":"2026-06-16T14:22:10.123Z"}
```

## Analyse

```bash
npm run analyze
```

Lit `gsm8k_pool.jsonl` et `gsm8k_test_cache.jsonl`, puis :

- **K-sweep** — accuracy et stabilité bootstrap (N=200) pour k ∈ {1, 5, 10, 20, 30}
- **Corrélations** — Pearson et Spearman entre accuracy et stabilité par item
- **Changements de vote** — items dont le vote majoritaire change entre k=5 et k=20
- **Items pathologiques** — forte stabilité mais faible accuracy (biais systématique)
- **Items instables** — stabilité < 0.8 à k=20
- **Comptages** — items toujours faux, items parfaits à k=30

Le résultat complet est écrit en JSON sur stdout. Un résumé lisible est écrit sur stderr.

## Configuration

Les valeurs par défaut correspondent au mini-pilote demandé :

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

Les tarifs par défaut utilisent la tarification standard OpenAI pour `gpt-5.4-mini` au 2026-06-16. Ajuster `OPENAI_INPUT_USD_PER_1M` et `OPENAI_OUTPUT_USD_PER_1M` si votre endpoint ou votre mode de traitement facture autrement.

## Vérification

```bash
npm run typecheck
npm run lint
npm test
```
