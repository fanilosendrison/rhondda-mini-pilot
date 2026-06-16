# @vegacorp/llm-runtime

Runtime TypeScript pour orchestration de providers LLM (completion + embedding) — moteur unique normalisé pour Anthropic, OpenAI, OpenAI-compatible, Google Gemini.

## Getting Started

### Prerequisites

- Node >= 20 (22 LTS recommandé)
- pnpm >= 10

### Install & verify

```bash
git clone git@github.com:fanilosendrison/llm-runtime.git
cd llm-runtime
pnpm install
pnpm check            # typecheck + lint + test
```

### Scripts

```bash
pnpm typecheck        # tsc --noEmit (strict)
pnpm lint             # biome check
pnpm lint:fix         # biome check --write
pnpm format           # biome format --write
pnpm test             # vitest run
pnpm test:watch       # vitest (watch mode)
pnpm build            # tsc -p tsconfig.build.json → dist/
```

## Specs

Le projet est spec-driven. Les 17 specs normatives (16 NIB + 1 DC) sont dans `specs/`. Voir `SPEC_MANIFEST.md` pour les cross-refs spec → code → tests, et `CLAUDE.md` pour les directives projet.
