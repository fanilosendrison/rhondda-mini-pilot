---
id: NIB-M-EXECUTE-EMBEDDING
type: nib-module
version: "1.0.0"
scope: llm-runtime
module: execute-embedding
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-M-EXECUTE-EMBEDDING — Module Brief — `executeEmbedding` (moteur d'orchestration embedding)

**Package** : `@vegacorp/llm-runtime`
**Source NX** : §14.2 (flux embedding), §5.3, §6.4 (EmbeddingAdapter), §9.1 (EmbeddingAdapterConfig)
**NIB-T associé** : §20

---

## 1. Purpose

`executeEmbedding` est le **point unique d'exécution** d'un call embedding. Son rôle : orchestrer le découpage en batches, l'appel du binding pour chaque batch, la gestion retry/throttle/abort/timeout par batch, et la concaténation ordonnée des vecteurs résultants.

**Principe normatif structurant — cohérence avec `executeCall`** : `executeEmbedding` reproduit la structure 28-étapes de `executeCall` (NIB-M-EXECUTE-CALL §3) **par batch**, en l'adaptant aux spécificités embedding (pas de sanitization, pas de terminationMap, pas de content text — juste des vecteurs). Les principes moteur unique / zero decision latitude / fail-closed s'appliquent identiquement.

**Principe normatif structurant — "échec global sur erreur de batch"** : si un batch échoue (après épuisement des retries), `executeEmbedding` throw immédiatement. Les batches déjà complétés sont **perdus** — pas de retour partiel, pas de stockage intermédiaire. Ce choix maximise la simplicité et la cohérence (partial failure serait un antipattern qui forcerait le consommateur à gérer un état complexe).

**Non-exporté publiquement** : appelé uniquement par `createOpenAIEmbeddingAdapter` (voir NIB-M-FACTORIES §6).

**Fichier cible** : `src/engine/execute-embedding.ts`. **LOC cible** : ~180-220 (un peu plus court que `executeCall` car pas de sanitization/integrity).

---

## 2. Inputs / Outputs

### 2.1 Signature

```ts
export async function executeEmbedding(
  texts: string[],
  binding: EmbeddingBinding,
  config: EmbeddingAdapterConfig,
  throttleSnapshot: ThrottleSnapshotService,
  logger: LLMLogger,
  stats: AdapterStats,
  options?: { signal?: AbortSignal },
): Promise<number[][]>;
```

### 2.2 Contrat de sortie

- Succès → `number[][]` strictement aligné sur l'ordre de `texts`. `result.length === texts.length`.
- Échec → throw `LLMRuntimeError` enrichie (callId, provider, model, attempts). Aucun autre type.

### 2.3 Cas `texts.length === 0`

**Short-circuit sans appel réseau** : retour immédiat `[]`. Aucun event émis, aucune stat incrémentée. Justification : un consommateur qui embed un array vide signale probablement un bug de son côté, mais l'engine ne throw pas — il honore la contrainte contractuelle (tableau vide en entrée → tableau vide en sortie).

---

## 3. Algorithme — Structure par batch

### 3.1 Génération callId + startedAt + startMono (hors boucle batch)

```ts
const callId = generateCallId();
const startedAt = nowWallIso();
const startMono = nowMono();
```

**Un seul callId est généré pour tout l'embedding call**, partagé par tous les events de tous les batches. C'est cohérent avec la sémantique : un call `embed(texts)` = un call logique, même s'il y a N batches HTTP.

### 3.2 Log `llm_embedding_start` + short-circuit empty

```ts
logger.emit({
  type: "llm_embedding_start",
  callId, provider: binding.provider, model: config.model,
  ts: startedAt,
  textCount: texts.length,
});

if (texts.length === 0) {
  logger.emit({
    type: "llm_embedding_end",
    callId, provider: binding.provider, model: config.model,
    success: true, batchCount: 0, vectorCount: 0,
    durationMs: Math.round(nowMono() - startMono),
  });
  stats.totalCalls += 1;  // stat incrémentée même sur empty (un call logique a bien eu lieu)
  stats.totalDurationMs += Math.round(nowMono() - startMono);
  return [];
}
```

### 3.3 Découpage en batches

```ts
const batchSize = config.batchSize ?? 100;
const batches: string[][] = [];
for (let i = 0; i < texts.length; i += batchSize) {
  batches.push(texts.slice(i, i + batchSize));
}
```

**Règle normative** :
- `batchSize` est lu **une fois** avant la boucle. Si le consommateur modifie la config après construction (cas non-supporté — AdapterConfig est figée via factory), aucun effet.
- Aucun batch vide : garanti par la structure de la boucle (`texts.length > 0` vérifié en §3.2).

### 3.4 Boucle batch — résultat accumulé

```ts
const result: number[][] = [];
let snapshot: RateLimitSnapshot | null = throttleSnapshot.get();
let totalInputTokens = 0;  // accumulé pour log end

for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
  const batch = batches[batchIndex];
  const vectors = await executeBatch(batch, batchIndex, callId);  // §3.5 ci-dessous
  result.push(...vectors);
}
```

**Règle de concaténation** : `vectors` retourné par `executeBatch` est déjà dans l'ordre de `batch`, donc `result.push(...)` préserve l'ordre global de `texts`. Cet invariant est vérifié par test NIB-T §20.4.

### 3.5 Sous-fonction `executeBatch(batch, batchIndex, callId)`

Cette sous-fonction reproduit la logique retry/throttle/abort de `executeCall`, adaptée aux embeddings. Elle n'est pas exportée — elle reste une closure (ou fonction interne au module).

**Structure (20 sous-étapes par batch)** :

#### 3.5.1 Pré-check signal aborted
```ts
if (options?.signal?.aborted) {
  enrichAndThrowEmbedding(new AbortedError("embedding aborted before batch"), { callId, provider, model, attempts: 0 });
}
```

#### 3.5.2 Init local batch
```ts
let lastHeaders: Record<string, string> = {};
let lastError: LLMRuntimeError | undefined = undefined;
const bindingConfig: BindingConfig = {
  model: config.model,
  apiKey: config.apiKey,
  endpoint: config.endpoint,
  providerOptions: config.providerOptions,
};
```

#### 3.5.3 Boucle d'attempts par batch
```ts
for (let attempt = 0; attempt < config.retry.maxAttempts; attempt++) {
  // §3.5.4 à §3.5.18
}
```

#### 3.5.4 Pré-check signal aborted (tour)
Identique à §3.5.1 mais dans la boucle.

#### 3.5.5 Résolution retry (attempt > 0)
```ts
if (attempt > 0) {
  const retryDecision = resolveRetryDecision(lastError!, attempt, lastHeaders, config.retry);
  if (retryDecision.reason === "transient_unknown") {
    logger.emit({ type: "llm_embedding_unknown_error_classified", callId, provider, model, batchIndex, attempt, reason: "transient_unknown", rawSignal: extractRawSignal(lastError!) });
  }
  if (retryDecision.retry === false) {
    enrichAndThrowEmbedding(lastError!, { callId, provider, model, attempts: attempt });
  }
  logger.emit({ type: "llm_embedding_retry_scheduled", callId, provider, model, batchIndex, attempt, delayMs: retryDecision.delayMs, reason: retryDecision.reason });
  try {
    await abortableSleep(retryDecision.delayMs, options?.signal);
  } catch (e) {
    enrichAndThrowEmbedding(new AbortedError("aborted during retry wait", { cause: e }), { callId, provider, model, attempts: attempt });
  }
}
```

#### 3.5.6 Throttle decision
```ts
// Note : pour embeddings, estimateCallTokens n'est pas appelé — on utilise une heuristique
// plus simple basée sur la somme des bytes UTF-8 des textes du batch.
const estimatedTokens = estimateEmbeddingTokens(batch);  // Math.ceil(totalUtf8Bytes(batch) / 3.5)
const throttleDecision = resolveThrottleDecision(snapshot, estimatedTokens, nowMono());
```

**Helper interne `estimateEmbeddingTokens`** : identique à la partie input de `estimateCallTokens` (pas d'estimate output, les embeddings n'ont pas de tokens de sortie facturés significativement). Défini dans `execute-embedding.ts` ou colocalisé dans NIB-M-TOKEN-ESTIMATOR (à l'implémentation de voir ; l'important est la présence de l'estimation).

#### 3.5.7 Sleep throttle
```ts
if (throttleDecision.throttle === true) {
  logger.emit({ type: "llm_embedding_throttled", callId, provider, model, batchIndex, attempt, waitMs: throttleDecision.waitMs, reason: throttleDecision.reason, estimatedTokens, snapshotState: snapshot?.state ?? "null" });
  try {
    await abortableSleep(throttleDecision.waitMs, options?.signal);
  } catch (e) {
    enrichAndThrowEmbedding(new AbortedError("aborted during throttle wait", { cause: e }), { callId, provider, model, attempts: attempt });
  }
}
```

#### 3.5.8 Log `llm_embedding_batch` (avant fetch)
```ts
logger.emit({ type: "llm_embedding_batch", callId, provider, model, batchIndex, attempt, textCount: batch.length, estimatedTokens });
```

**Note** : l'event `llm_embedding_batch` combine les rôles de `llm_call_attempt_start` (marquage de début d'attempt) et `llm_call_attempt_start` (contextualisation batch). Un seul event par attempt.

#### 3.5.9 buildRequest
```ts
const canonicalRequest = binding.buildRequest(batch, bindingConfig);
```

#### 3.5.10 Compose signal avec timeout
```ts
const { signal: composedSignal, cleanup } = composeSignal(options?.signal, config.timeout.perAttemptMs);
```

#### 3.5.11 Fetch
```ts
let response: Response;
let bodyText: string;
let headers: Record<string, string>;
try {
  response = await fetch(canonicalRequest.url, {
    method: canonicalRequest.method,
    headers: canonicalRequest.headers,
    body: canonicalRequest.body,
    signal: composedSignal,
  });
} catch (err) {
  cleanup();
  lastHeaders = {};
  const providerSignal = buildProviderErrorSignalFromFetchError(err, options?.signal);
  logger.emit({ type: "llm_embedding_fetch_error", callId, provider, model, batchIndex, attempt, networkErrorKind: providerSignal.networkErrorKind, message: err instanceof Error ? err.message : String(err) });
  lastError = binding.classifyError(providerSignal);
  continue;
}
```

#### 3.5.12 Lecture status/body/headers
```ts
const status = response.status;
bodyText = await response.text();
headers = Object.fromEntries(response.headers.entries());
lastHeaders = headers;
cleanup();
```

#### 3.5.13 Handling status non-2xx
```ts
if (status < 200 || status >= 300) {
  const providerSignal: ProviderErrorSignal = { aborted: false, timeout: false, status, headers, bodyText };
  lastError = binding.classifyError(providerSignal);
  logger.emit({ type: "llm_embedding_provider_error", callId, provider, model, batchIndex, attempt, status, semanticErrorKind: lastError.kind, retryable: isRetriableKind(lastError.kind) });

  // Mise à jour snapshot sur rate-limit signaling
  if ((lastError.kind === "rate_limit" || lastError.kind === "overloaded") && binding.quirks.hasRateLimitHeaders) {
    const newSnapshot = binding.readRateLimitHeaders(headers);
    if (newSnapshot !== null) { throttleSnapshot.set(newSnapshot); snapshot = newSnapshot; }
    else {
      const invalidated = { ...(snapshot ?? {}), state: "unknown" as const, capturedAtMono: nowMono() };
      throttleSnapshot.set(invalidated); snapshot = invalidated;
    }
  }
  continue;
}
```

#### 3.5.14 parseEmbeddings
```ts
let vectors: number[][];
try {
  vectors = binding.parseEmbeddings(bodyText);
} catch (err) {
  if (err instanceof ResponseParseError || err instanceof ContentFilterError) {
    lastError = err;
  } else {
    lastError = new ResponseParseError("unexpected parse error", { cause: err });
  }
  logger.emit({ type: "llm_embedding_parse_error", callId, provider, model, batchIndex, attempt, errorKind: lastError.kind, message: lastError.message });
  continue;
}
```

#### 3.5.15 Vérification alignment longueur
```ts
if (vectors.length !== batch.length) {
  lastError = new ResponseParseError(`openai-embeddings: length mismatch — expected ${batch.length}, got ${vectors.length}`);
  logger.emit({ type: "llm_embedding_parse_error", callId, provider, model, batchIndex, attempt, errorKind: "parse", message: lastError.message });
  continue;
}
```

**Rationale** : cette vérification relève de l'engine (pas du binding) car elle dépend de `batch.length` qui est dans le contexte engine, pas binding. Une erreur ici est **fatale** (non retriable en v1 — `ResponseParseError` → `fatal_parse_error`), mais elle passe quand même par la boucle pour uniformité.

#### 3.5.16 Mise à jour snapshot
```ts
const newSnapshot = binding.readRateLimitHeaders(headers);
if (newSnapshot !== null) {
  throttleSnapshot.set(newSnapshot);
  snapshot = newSnapshot;
}
```

**Différence avec `executeCall`** : pas d'enrichissement par `lastCallOutputTokens` (concept non applicable aux embeddings, pas de tokens de sortie).

#### 3.5.17 Return vectors (exit de la boucle attempts pour ce batch)
```ts
return vectors;
```

#### 3.5.18 Post-boucle (attempts épuisés)
```ts
enrichAndThrowEmbedding(lastError!, { callId, provider, model, attempts: config.retry.maxAttempts });
```

### 3.6 Concaténation et log `llm_embedding_end`

Après la boucle batch (§3.4) :

```ts
const endedAt = nowWallIso();
const durationMs = Math.round(nowMono() - startMono);

// Stats : pour embeddings, totalInputTokens/totalOutputTokens NE SONT PAS incrémentés.
// Convention §15.5 NX : seul totalCalls et totalDurationMs sont vivants pour embedding adapter.
stats.totalCalls += 1;
stats.totalDurationMs += durationMs;

logger.emit({
  type: "llm_embedding_end",
  callId, provider: binding.provider, model: config.model,
  success: true,
  batchCount: batches.length,
  vectorCount: result.length,
  durationMs,
});

return result;
```

---

## 4. Helpers internes

| Helper | Rôle | Colocalisation |
|---|---|---|
| `enrichAndThrowEmbedding(err, ctx)` | Comme `enrichAndThrow` mais émet `llm_embedding_end { success: false }`. | Privé à `execute-embedding.ts`, ou partagé via `src/engine/_internal/` |
| `buildProviderErrorSignalFromFetchError` | Identique à `executeCall` — à factoriser dans `src/engine/_internal/error-signal.ts` si DRY souhaité | Partagé |
| `inferNetworkErrorKind` | Idem | Partagé |
| `extractRawSignal` | Idem | Partagé |
| `estimateEmbeddingTokens(batch)` | `Math.ceil(totalUtf8Bytes(batch) / 3.5)` — heuristique input-only pour throttle proactif | Privé ou colocalisé avec token-estimator |

**Décision d'implémentation** : à l'écriture de la v1, utiliser la factorisation dans `src/engine/_internal/` pour les helpers communs `executeCall`/`executeEmbedding`. La duplication pure serait ~60 LOC évitables — DRY justifié ici.

---

## 5. Examples

### 5.1 Happy path — 3 textes, 1 batch (batchSize=100)

```ts
const vectors = await executeEmbedding(
  ["Hello.", "World.", "Embedding."],
  openaiEmbeddingsBinding,
  { model: "text-embedding-3-small", apiKey: "sk-...", batchSize: 100, retry: ..., timeout: ..., sanitization: {}, integrity: {...}, logging: {...} },
  throttleSnapshot, logger, stats,
);
// vectors.length === 3
```

Events émis :
1. `llm_embedding_start` (textCount: 3)
2. `llm_embedding_batch` (batchIndex: 0, attempt: 0)
3. `llm_embedding_end` (batchCount: 1, vectorCount: 3, success: true)

### 5.2 Batching — 250 textes, batchSize=100

```ts
const texts = generateTexts(250);  // 250 strings
const vectors = await executeEmbedding(texts, binding, { ...config, batchSize: 100 }, ...);
// vectors.length === 250
// 3 batches : [0..99], [100..199], [200..249]
```

Events émis :
1. `llm_embedding_start` (textCount: 250)
2. `llm_embedding_batch` (batchIndex: 0, attempt: 0)
3. `llm_embedding_batch` (batchIndex: 1, attempt: 0)
4. `llm_embedding_batch` (batchIndex: 2, attempt: 0)
5. `llm_embedding_end` (batchCount: 3, vectorCount: 250)

### 5.3 Ordre préservé avec batching

```ts
const texts = ["a", "b", "c", "d", "e"];  // 5 textes
// batchSize=2 → batches [[a,b], [c,d], [e]]
const vectors = await executeEmbedding(texts, binding, { ...config, batchSize: 2 }, ...);
// vectors[0] = embedding("a"), vectors[1] = embedding("b"), ..., vectors[4] = embedding("e")
// Ordre strictement préservé (test NIB-T §20.4).
```

### 5.4 Échec global sur batch 2

```ts
// Batch 0 réussit → vectors accumulés localement.
// Batch 1 échoue après 5 retries (429 persistant).
// → throw RateLimitError enrichi (attempts: 5).
// Les vectors du batch 0 sont PERDUS (pas retournés).
await executeEmbedding(texts, binding, config, ...);  // throw
```

Events :
1. `llm_embedding_start`
2. `llm_embedding_batch` (batchIndex: 0, attempt: 0) → success implicite (pas d'event end batch, continue boucle)
3. `llm_embedding_batch` (batchIndex: 1, attempt: 0)
4. `llm_embedding_provider_error` (batchIndex: 1, attempt: 0, status: 429)
5. `llm_embedding_retry_scheduled` (batchIndex: 1, attempt: 1, ...)
6. `llm_embedding_batch` (batchIndex: 1, attempt: 1)
7. ... (répété jusqu'à 5 attempts)
8. `llm_embedding_end` (success: false, ... dans `enrichAndThrowEmbedding`)
9. throw RateLimitError

### 5.5 Abort pendant batch

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 50);
await executeEmbedding(texts, binding, config, ..., { signal: controller.signal });  // throw AbortedError
```

L'abort est détecté soit en `§3.5.1` (avant batch), soit pendant `abortableSleep`, soit comme `DOMException("AbortError")` pendant `fetch` → classifié par `buildProviderErrorSignalFromFetchError` → `AbortedError` throwé via `enrichAndThrowEmbedding`.

---

## 6. Edge cases

### 6.1 `texts.length === 0`
Short-circuit §3.2 : retour `[]`, 1 stat call incrémentée, 2 events (`start`, `end`). Pas d'appel réseau, pas de batch.

### 6.2 `texts.length === 1`
Un seul batch, un seul attempt attendu. `vectors.length === 1`.

### 6.3 `batchSize === 1`
Un batch par texte. `N` batches = `N` calls HTTP. Overhead assumé — consommateur responsable de choisir un batchSize sensé (default 100).

### 6.4 `batchSize > texts.length`
Un seul batch contenant tous les textes. Correct — pas de cas dégénéré.

### 6.5 `texts` contenant des strings vides
Les strings vides sont **passées telles quelles** au binding. OpenAI peut rejeter (400) ou renvoyer un vecteur nul — comportement provider, non géré spécialement par l'engine.

### 6.6 Snapshot updated entre batches
Le snapshot est lu à chaque début de batch via `throttleSnapshot.get()`. Si batch N-1 a mis à jour le snapshot (via §3.5.16), batch N en bénéficie. Cet état mutable inter-batch est intentionnel.

### 6.7 Différents `batchSize` entre calls
Chaque call `embed(texts)` relit `config.batchSize`. Si le consommateur reconstruit la config entre calls (hors API normale — pas supporté), le comportement est indéfini. Normative v1 : `AdapterConfig` est figée à la factory, pas modifiable.

### 6.8 `retry.maxAttempts` appliqué par batch ou globalement ?
**Par batch**. Chaque batch a son budget indépendant de `maxAttempts` retries. Si `maxAttempts=5` et 3 batches, le call peut effectuer jusqu'à 15 fetches au pire cas. Cette décision est matérialisée et documentée — elle favorise la progression (un batch qui fail rapidement sur 1 retry ne pénalise pas les suivants).

---

## 7. Constraints

### 7.1 Pas de partial return
Un échec de batch **annule** tous les batches précédents. Pas de `Partial<number[][]>`. Pas de callback `onBatch`. Le consommateur qui veut de la résilience partielle la construit au-dessus (split manuel + try/catch par sous-groupe).

### 7.2 Ordre strictement préservé
L'ordre des vecteurs en sortie reproduit l'ordre des textes en entrée. Test NIB-T §20.4 vérifie ceci avec un batch à index désordonné par le provider.

### 7.3 Sanitization non applicable
`config.sanitization` est **ignoré** par `executeEmbedding` (même si présent dans `EmbeddingAdapterConfig` pour homogénéité de type). Les vecteurs ne sont jamais sanitizés.

### 7.4 Integrity non applicable
`config.integrity` est **ignoré**. Pas de terminationReason, pas de truncation, pas de modelMismatch. La seule vérification post-réponse est le mismatch de longueur (§3.5.15).

### 7.5 Stats tokens non incrémentées
Convention NX §15.5 : `totalInputTokens` et `totalOutputTokens` restent à 0 pour un `EmbeddingAdapter`. Seules `totalCalls` et `totalDurationMs` sont incrémentées.

### 7.6 Imports autorisés (liste close)

```ts
import type { EmbeddingBinding, EmbeddingAdapterConfig, BindingConfig, RateLimitSnapshot, ProviderErrorSignal, LLMLogger, AdapterStats, LLMRuntimeError } from "../types";
import { AbortedError, TimeoutError, ResponseParseError, ContentFilterError } from "../errors";
import { resolveRetryDecision } from "../services/retry-resolver";
import { resolveThrottleDecision, type ThrottleSnapshotService } from "../services/throttle";
import { composeSignal, abortableSleep } from "../services/signal-composer";
import { isRetriableKind } from "../services/error-kind";
import { nowWallIso, nowMono } from "../services/clock";
import { generateCallId } from "../services/callId-generator";
// helpers partagés avec execute-call
import { buildProviderErrorSignalFromFetchError, inferNetworkErrorKind, extractRawSignal } from "./_internal/error-signal";
```

---

## 8. Integration snippets

### 8.1 Factory consumer

```ts
// Dans src/factories/openai-embeddings.ts
export function createOpenAIEmbeddingAdapter(config: EmbeddingAdapterConfig): EmbeddingAdapter {
  const throttleSnapshot = createThrottleSnapshotService();
  const logger = resolveLogger(config.logging);
  const stats: AdapterStats = { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalDurationMs: 0 };
  return {
    provider: openaiEmbeddingsBinding.provider,
    embed: (texts, options) => executeEmbedding(texts, openaiEmbeddingsBinding, config, throttleSnapshot, logger, stats, options),
    stats,
  };
}
```

### 8.2 Test d'acceptance (référence NIB-T §20.3)

```ts
// tests/engine/execute-embedding.test.ts
import { describe, test, expect, vi } from "vitest";
import { executeEmbedding } from "../../src/engine/execute-embedding";
import { openaiEmbeddingsBinding } from "../../src/bindings/openai-embeddings";

describe("executeEmbedding — batching", () => {
  test("T-EE-03: 250 texts, batchSize=100 → 3 batches, 3 fetches", async () => {
    const fetchMock = vi.fn().mockImplementation(/* return valid batch response */);
    global.fetch = fetchMock;
    const texts = Array.from({ length: 250 }, (_, i) => `t${i}`);
    const vectors = await executeEmbedding(texts, openaiEmbeddingsBinding, { ...baseConfig, batchSize: 100 }, ...);
    expect(vectors).toHaveLength(250);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
```

---

## 9. Definition of Done (DoD)

1. **Signature** : `executeEmbedding(texts, binding, config, throttleSnapshot, logger, stats, options?)` exportée.
2. **Short-circuit empty** : `texts.length === 0` → retour `[]` sans fetch, stats call incrémentée.
3. **Batching** : découpage correct par `config.batchSize ?? 100`. Ordre préservé.
4. **Par batch** : boucle retry/throttle complète (§3.5.3 à §3.5.18).
5. **Échec global** : batch qui fail après retries → throw immédiat, batches précédents perdus.
6. **Tests NIB-T §20** : tous passent (happy path, batching, ordre, abort, retry, stats, propriétés).
7. **Events** : `llm_embedding_start`, `llm_embedding_batch`, `llm_embedding_retry_scheduled`, `llm_embedding_throttled`, `llm_embedding_fetch_error`, `llm_embedding_provider_error`, `llm_embedding_parse_error`, `llm_embedding_unknown_error_classified`, `llm_embedding_end` (9 types — sous-ensemble de la taxonomie §11.3 NX).
8. **Stats** : seules `totalCalls` et `totalDurationMs` incrémentées.
9. **LOC** : 180-220.

---

## 10. Relation avec les autres NIB-M

- **Consomme** :
  - `NIB-M-BINDING-EMBEDDING` (`openaiEmbeddingsBinding` injecté par factory)
  - `NIB-M-ERRORS`
  - `NIB-M-ERROR-KIND` (`isRetriableKind`)
  - `NIB-M-INFRA-UTILS`
  - `NIB-M-RETRY-RESOLVER`
  - `NIB-M-THROTTLE`
  - `NIB-M-SIGNAL-COMPOSER`
  - Helpers internes partagés avec `NIB-M-EXECUTE-CALL` (via `src/engine/_internal/`)
- **Ne consomme PAS** :
  - `NIB-M-SANITIZER` (pas de sanitization embeddings)
  - `NIB-M-TOKEN-ESTIMATOR` (utilise son propre helper `estimateEmbeddingTokens` — ou une version simplifiée)
- **Est consommé par** :
  - `NIB-M-FACTORIES` (`createOpenAIEmbeddingAdapter` uniquement)

---

## 11. Metadata

| Champ | Valeur |
|---|---|
| Source NX | §14.2 (flux embedding), §5.3, §6.4, §9.1, §15.5 |
| NIB-T associé | §20 |
| Invariants NIB-S couverts | I-2, I-3, I-4, I-5, I-7 (adapté embedding), I-ER-01 |
| Fichier produit | `src/engine/execute-embedding.ts` |
| LOC cible | 180-220 |
| Non exporté publiquement | oui |

---

## 12. Historique

| Version | Date | Changements |
|---|---|---|
| 1.0.0 | 2026-04 | Création initiale. Flux embedding avec batching (default 100), boucle retry par batch, échec global, short-circuit `texts: []`. 9 types d'events (sous-ensemble de la taxonomie §11.3 NX). Stats tokens non propagées (convention §15.5). |

---

*VegaCorp — Implicit-Free Execution (IFE) — "La fiabilité précède l'intelligence."*
