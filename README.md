# Rhondda Pilot – Data Collection Script

Mini-pilote pour la validation de la méthode **Rhondda**. Ce script collecte un pool de 30 réponses pour 200 items du dataset **GSM8K** en utilisant `gpt-5.4-mini` (OpenAI) via le harness robuste **`@vegacorp/llm-runtime`** (source vendée sous `llm-runtime-main/`).

Le fichier de sortie (`gsm8k_pool.jsonl`) servira à l'analyse post-hoc (bootstrap, calcul de la stabilité, courbes accuracy vs k) dans la seconde phase.

> ⚠️ Le script de collecte n'est pas encore implémenté — ce dépôt contient pour l'instant le harness vendé et l'environnement de développement prêt à l'emploi.

## Getting Started

### Prerequisites

- **Node.js ≥ 20** (ESM) — imposé par `@vegacorp/llm-runtime`
- **pnpm** — uniquement pour builder le harness vendé (`llm-runtime-main/`)
- Une clé API OpenAI avec accès au modèle `gpt-5.4-mini`
- Budget ~4 $ (estimé pour 200 items × 30 tirages)

### Installation

```bash
git clone git@github.com:fanilosendrison/rhondda-mini-pilot.git
cd rhondda-mini-pilot

# 1. Builder le harness vendé (produit llm-runtime-main/dist/)
cd llm-runtime-main && pnpm install && pnpm build && cd ..

# 2. Installer les dépendances du pilote (lie le harness via file:)
npm install

# 3. Configurer le secret
cp .env.example .env          # puis renseigner OPENAI_API_KEY dans .env
```

### Vérification

```bash
npm test          # vitest run --passWithNoTests
npm run lint      # biome check (lint + format)
npm run typecheck # tsc --noEmit
```

### Lancer la collecte

À venir — le script de collecte (`src/`) reste à implémenter. Il chargera `.env` via le support natif `node --env-file`, sélectionnera 200 items GSM8K, tirera 30 réponses par item via `@vegacorp/llm-runtime`, et écrira `gsm8k_pool.jsonl`.
