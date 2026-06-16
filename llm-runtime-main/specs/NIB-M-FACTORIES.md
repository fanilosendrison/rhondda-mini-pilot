---
id: NIB-M-FACTORIES
type: nib-module
version: "1.0.0"
scope: llm-runtime
module: factories
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-M-FACTORIES — Module Brief — Factories publiques, helper `buildSimplePrompt`, et surface `index.ts`

**Package** : `@vegacorp/llm-runtime`
**Source NX** : §4.8 (config figée), §4.9 (surface publique), §5.2 (Layer 1 — Public API), §5.3 (factories), §5.4 (bindings), §10.1 (cycle de vie adapter)
**NIB-T associé** : §26 (tests transverses surface publique + factories + fail-closed)

---

## 1. Purpose

Ce module couvre **la couche L1 publique** de `@vegacorp/llm-runtime` : les cinq factories qui câblent binding + config + services transverses en un adapter immutable, le helper périphérique `buildSimplePrompt`, et la surface exportée depuis `index.ts`.

**Principe normatif structurant — "configuration figée au moment de la factory" (I-8 du NIB-S)** : chaque factory prend une `AdapterConfig` (ou `EmbeddingAdapterConfig`), valide ses invariants, câble le binding correspondant, instancie les services locaux à l'adapter (throttle-snapshot, stats, logger), et retourne un `ProviderAdapter` (ou `EmbeddingAdapter`) **immutable**. Toute mutation post-création du config source ne doit pas affecter le comportement de l'adapter (snapshot défensif exigé).

**Principe normatif structurant — "moteur unique, bindings minces" (I-2 du NIB-S)** : les factories n'exécutent **aucune** logique de call. Elles câblent, puis délèguent `call()` / `embed()` à `executeCall` / `executeEmbedding` (voir NIB-M-EXECUTE-CALL, NIB-M-EXECUTE-EMBEDDING).

**Principe normatif structurant — "surface publique petite et stable" (I-9 du NIB-S)** : le fichier `index.ts` exporte **exactement** la liste normée en §6. Tout symbole interne (engine, bindings, services, formes canoniques) reste **privé**. L'ajout d'un export = modification normative du NX (breaking probable).

Les factories sont des fonctions **nommées**, exportées par nom, **non** des classes. Elles n'ont pas de dépendance d'initialisation globale — elles sont idempotentes sur la définition (appel répété = nouveaux adapters indépendants, aucun state partagé entre instances).

---

## 2. Inputs / Outputs

### 2.1 Signatures exportées

```ts
// Completions
export declare function createAnthropicAdapter(
  config: AdapterConfig & {
    providerOptions?: {
      extendedThinking?: { enabled: boolean; budgetTokens: number };
    };
  }
): ProviderAdapter;

export declare function createOpenAIAdapter(config: AdapterConfig): ProviderAdapter;

export declare function createOpenAICompatibleAdapter(
  config: AdapterConfig & {
    provider: Extract<ProviderLongId, "deepseek" | "mistral" | "groq" | "together" | "ollama">;
  }
): ProviderAdapter;

export declare function createGoogleAdapter(config: AdapterConfig): ProviderAdapter;

// Embeddings
export declare function createOpenAIEmbeddingAdapter(
  config: EmbeddingAdapterConfig
): EmbeddingAdapter;

// Helper périphérique
export declare function buildSimplePrompt(params: {
  system?: string;
  user: string;
}): LLMMessage[];
```

### 2.2 Règles communes aux 5 factories

Chaque factory doit :

1. **Valider la config d'entrée** (voir §5 ci-dessous). Échec → throw `InvalidRequestError` enrichie `{ callId: null, provider: <provider>, model: config.model, attempts: 0 }`. **Exception pour le callId** : les erreurs de construction ne disposent d'aucun callId (pas de call commencé) ; le champ est conventionnellement `null`. Les autres champs sont connus.
2. **Snapshotter la config** : clone défensif (`structuredClone` ou équivalent discipline). Le config passé par le consommateur est potentiellement muté après la factory — le snapshot garantit que l'adapter reste figé (I-8, C-GL-22 du NIB-T).
3. **Instancier le binding** via les factories de binding ou les constantes exportées par `src/bindings/` (voir NIB-M-BINDINGS-COMPLETION, NIB-M-BINDING-EMBEDDING).
4. **Instancier le throttle-snapshot service** local à l'adapter (voir NIB-M-THROTTLE §4). State réservé à cet adapter : aucun partage cross-adapter.
5. **Instancier l'objet `stats` mutable** : `{ totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 }`. Exposé **en lecture** via `adapter.stats` (signature `readonly` TypeScript ; pas de `Object.freeze` requis — l'engine mute via l'objet interne).
6. **Résoudre le logger** via `resolveLogger(config.logging)` (voir NIB-M-INFRA-UTILS §4).
7. **Construire et retourner** le `ProviderAdapter` (ou `EmbeddingAdapter`) câblé conformément à §3.

### 2.3 Cycle de vie (rappel du NIB-S §10.1)

```
createXAdapter(config)
  ├─ 1. validateConfig(config)                        → throw InvalidRequestError si invalide
  ├─ 2. snapshot = structuredClone(config)            → immutabilité
  ├─ 3. binding = <constante ou factory binding>
  ├─ 4. throttleSnapshot = createThrottleSnapshotService()
  ├─ 5. stats = { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 }
  ├─ 6. logger = resolveLogger(snapshot.logging)
  └─ 7. return {
          provider: binding.provider,
          model: snapshot.model,
          stats,                                        // référence à l'objet mutable
          call: (request) => executeCall(
            request, binding, snapshot,
            { throttleSnapshot, stats, logger }
          ),
        }
```

**Pour les embeddings**, le retour est :
```
return {
  provider: binding.provider,
  model: snapshot.model,
  stats,
  embed: (texts, options?) => executeEmbedding(
    texts, binding, snapshot, options,
    { throttleSnapshot, stats, logger }
  ),
};
```

---

## 3. Algorithme — Factories individuelles

### 3.1 `createAnthropicAdapter`

```ts
import { anthropicBinding } from "../bindings/anthropic.js";
import { createThrottleSnapshotService } from "../services/throttle-snapshot.js";
import { resolveLogger } from "../services/logger.js";
import { executeCall } from "../engine/execute-call.js";
import type { AdapterConfig, ProviderAdapter } from "../types/config.js";

export function createAnthropicAdapter(
  config: AdapterConfig & {
    providerOptions?: {
      extendedThinking?: { enabled: boolean; budgetTokens: number };
    };
  }
): ProviderAdapter {
  validateAdapterConfig(config);
  validateAnthropicProviderOptions(config.providerOptions);

  const snapshot = structuredClone(config);
  const binding = anthropicBinding;  // constante figée, voir NIB-M-BINDINGS-COMPLETION §3
  const throttleSnapshot = createThrottleSnapshotService();
  const stats = { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 };
  const logger = resolveLogger(snapshot.logging);

  return {
    provider: binding.provider,            // "anthropic"
    model: snapshot.model,
    stats,
    call: (request) =>
      executeCall(request, binding, snapshot, { throttleSnapshot, stats, logger }),
  };
}
```

**Validation provider-options (Anthropic)** :
```ts
function validateAnthropicProviderOptions(opts: unknown): void {
  if (opts === undefined) return;
  if (typeof opts !== "object" || opts === null) {
    throw new InvalidRequestError("providerOptions must be an object");
  }
  const { extendedThinking } = opts as { extendedThinking?: unknown };
  if (extendedThinking === undefined) return;
  if (typeof extendedThinking !== "object" || extendedThinking === null) {
    throw new InvalidRequestError("extendedThinking must be an object");
  }
  const { enabled, budgetTokens } = extendedThinking as { enabled?: unknown; budgetTokens?: unknown };
  if (typeof enabled !== "boolean") {
    throw new InvalidRequestError("extendedThinking.enabled must be a boolean");
  }
  if (typeof budgetTokens !== "number" || !Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    throw new InvalidRequestError("extendedThinking.budgetTokens must be a positive finite number");
  }
}
```

### 3.2 `createOpenAIAdapter`

```ts
import { openaiBinding } from "../bindings/openai.js";

export function createOpenAIAdapter(config: AdapterConfig): ProviderAdapter {
  validateAdapterConfig(config);

  const snapshot = structuredClone(config);
  const binding = openaiBinding;              // constante, §4 NIB-M-BINDINGS-COMPLETION
  const throttleSnapshot = createThrottleSnapshotService();
  const stats = { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 };
  const logger = resolveLogger(snapshot.logging);

  return {
    provider: binding.provider,               // "openai"
    model: snapshot.model,
    stats,
    call: (request) =>
      executeCall(request, binding, snapshot, { throttleSnapshot, stats, logger }),
  };
}
```

**Pas de `validateProviderOptions`** : OpenAI n'expose pas de `providerOptions` typés en v1. Toute valeur passée y est ignorée par le binding. La factory ne valide pas un champ qu'elle n'utilise pas — responsabilité des futures évolutions.

### 3.3 `createOpenAICompatibleAdapter`

```ts
import { createOpenAICompatibleBinding } from "../bindings/openai-compatible.js";
import type { ProviderLongId } from "../types/config.js";

type OpenAICompatibleProviderId = Extract<
  ProviderLongId,
  "deepseek" | "mistral" | "groq" | "together" | "ollama"
>;

const OPENAI_COMPATIBLE_PROVIDERS = new Set<OpenAICompatibleProviderId>([
  "deepseek", "mistral", "groq", "together", "ollama",
]);

const DEFAULT_ENDPOINTS: Record<OpenAICompatibleProviderId, string> = {
  deepseek: "https://api.deepseek.com",
  mistral:  "https://api.mistral.ai",
  groq:     "https://api.groq.com/openai",
  together: "https://api.together.xyz",
  ollama:   "http://localhost:11434",
};

export function createOpenAICompatibleAdapter(
  config: AdapterConfig & { provider: OpenAICompatibleProviderId }
): ProviderAdapter {
  validateAdapterConfig(config);

  if (!OPENAI_COMPATIBLE_PROVIDERS.has(config.provider)) {
    throw new InvalidRequestError(
      `unsupported openai-compatible provider: ${config.provider}`
    );
  }

  const snapshot = structuredClone(config);
  const binding = createOpenAICompatibleBinding({
    provider: snapshot.provider,
    defaultEndpoint: DEFAULT_ENDPOINTS[snapshot.provider],
  });
  const throttleSnapshot = createThrottleSnapshotService();
  const stats = { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 };
  const logger = resolveLogger(snapshot.logging);

  return {
    provider: binding.provider,               // identique à snapshot.provider
    model: snapshot.model,
    stats,
    call: (request) =>
      executeCall(request, binding, snapshot, { throttleSnapshot, stats, logger }),
  };
}
```

**Règles normatives spécifiques** :
- `config.provider` **obligatoire** dans `AdapterConfig & { provider: ... }`. Absent → TS type error ; défensivement, runtime `InvalidRequestError("config.provider is required for openai-compatible adapter")`.
- `DEFAULT_ENDPOINTS` est la table par défaut ; `config.endpoint` l'override toujours (fallback `config.endpoint ?? DEFAULT_ENDPOINTS[provider]`, résolu **dans le binding** au moment du `buildRequest`).
- `snapshot.provider` est **préservé** dans le snapshot (le clone défensif ne doit pas l'écraser).

### 3.4 `createGoogleAdapter`

```ts
import { googleBinding } from "../bindings/google.js";

export function createGoogleAdapter(config: AdapterConfig): ProviderAdapter {
  validateAdapterConfig(config);

  const snapshot = structuredClone(config);
  const binding = googleBinding;              // constante, §6 NIB-M-BINDINGS-COMPLETION
  const throttleSnapshot = createThrottleSnapshotService();
  const stats = { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 };
  const logger = resolveLogger(snapshot.logging);

  return {
    provider: binding.provider,               // "google"
    model: snapshot.model,
    stats,
    call: (request) =>
      executeCall(request, binding, snapshot, { throttleSnapshot, stats, logger }),
  };
}
```

### 3.5 `createOpenAIEmbeddingAdapter`

```ts
import { openaiEmbeddingsBinding } from "../bindings/openai-embeddings.js";
import { executeEmbedding } from "../engine/execute-embedding.js";
import type { EmbeddingAdapterConfig, EmbeddingAdapter } from "../types/config.js";

export function createOpenAIEmbeddingAdapter(
  config: EmbeddingAdapterConfig
): EmbeddingAdapter {
  validateEmbeddingAdapterConfig(config);

  const snapshot = structuredClone(config);
  const binding = openaiEmbeddingsBinding;    // constante, §3 NIB-M-BINDING-EMBEDDING
  const throttleSnapshot = createThrottleSnapshotService();
  const stats = { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 };
  const logger = resolveLogger(snapshot.logging);

  return {
    provider: binding.provider,               // "openai"
    model: snapshot.model,
    stats,
    embed: (texts, options) =>
      executeEmbedding(texts, binding, snapshot, options, { throttleSnapshot, stats, logger }),
  };
}
```

**Spécificités embedding** :
- `EmbeddingAdapterConfig` étend `AdapterConfig` avec `batchSize?: number` (default 100, résolu par `executeEmbedding` voir NIB-M-EXECUTE-EMBEDDING §3.4).
- Le retour expose `embed(texts, options?)` avec `options.signal?: AbortSignal` (voir NIB-M-EXECUTE-EMBEDDING §2).
- **Symétrie `stats`** : les compteurs `totalInputTokens` et `totalOutputTokens` s'appliquent différemment aux embeddings : `totalInputTokens` est incrémenté par chaque batch réussi (tokens facturés par OpenAI), `totalOutputTokens` reste à 0 (embeddings n'ont pas d'output tokens). `totalCalls` compte les **appels** (pas les batches) — cf. NIB-M-EXECUTE-EMBEDDING §3.8.

---

## 4. Validation partagée — `validateAdapterConfig`

Fonction locale au module factories, non exportée. Exécutée par toutes les factories.

```ts
function validateAdapterConfig(config: AdapterConfig): void {
  if (!config || typeof config !== "object") {
    throw new InvalidRequestError("config must be an object");
  }

  // Champs obligatoires
  if (typeof config.model !== "string" || config.model.length === 0) {
    throw new InvalidRequestError("config.model must be a non-empty string");
  }
  if (typeof config.apiKey !== "string" || config.apiKey.length === 0) {
    throw new InvalidRequestError("config.apiKey must be a non-empty string");
  }
  if (config.endpoint !== undefined && typeof config.endpoint !== "string") {
    throw new InvalidRequestError("config.endpoint must be a string when provided");
  }

  // Policies obligatoires en v1 (cf. NIB-S §5.2, NIB-S §7.1)
  validateRetryPolicy(config.retry);
  validateTimeoutPolicy(config.timeout);
  validateSanitizationPolicy(config.sanitization);
  validateIntegrityPolicy(config.integrity);
  validateLoggingPolicy(config.logging);
}

function validateRetryPolicy(retry: unknown): void {
  if (!retry || typeof retry !== "object") {
    throw new InvalidRequestError("config.retry is required");
  }
  const { maxAttempts, baseDelayMs, capDelayMs, jitter } = retry as Record<string, unknown>;
  if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new InvalidRequestError("config.retry.maxAttempts must be an integer >= 1");
  }
  if (typeof baseDelayMs !== "number" || !Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new InvalidRequestError("config.retry.baseDelayMs must be a non-negative finite number");
  }
  if (typeof capDelayMs !== "number" || !Number.isFinite(capDelayMs) || capDelayMs < baseDelayMs) {
    throw new InvalidRequestError("config.retry.capDelayMs must be a finite number >= baseDelayMs");
  }
  if (jitter !== undefined && typeof jitter !== "boolean") {
    throw new InvalidRequestError("config.retry.jitter must be a boolean when provided");
  }
}

function validateTimeoutPolicy(timeout: unknown): void {
  if (!timeout || typeof timeout !== "object") {
    throw new InvalidRequestError("config.timeout is required");
  }
  const { perAttemptMs } = timeout as { perAttemptMs?: unknown };
  if (typeof perAttemptMs !== "number" || !Number.isFinite(perAttemptMs) || perAttemptMs <= 0) {
    throw new InvalidRequestError("config.timeout.perAttemptMs must be a positive finite number");
  }
}

function validateSanitizationPolicy(sanitization: unknown): void {
  // Objet obligatoire, champs internes optionnels (cf. NIB-S §7.1 règle SanitizationPolicy)
  if (!sanitization || typeof sanitization !== "object") {
    throw new InvalidRequestError("config.sanitization is required (object, possibly empty)");
  }
  const { stripThinkingTags, stripJsonFence } = sanitization as Record<string, unknown>;
  if (stripThinkingTags !== undefined && typeof stripThinkingTags !== "boolean") {
    throw new InvalidRequestError("config.sanitization.stripThinkingTags must be a boolean when provided");
  }
  if (stripJsonFence !== undefined && typeof stripJsonFence !== "boolean") {
    throw new InvalidRequestError("config.sanitization.stripJsonFence must be a boolean when provided");
  }
}

function validateIntegrityPolicy(integrity: unknown): void {
  if (!integrity || typeof integrity !== "object") {
    throw new InvalidRequestError("config.integrity is required");
  }
  const { failOnSilentTruncation, failOnTerminationMismatch } = integrity as Record<string, unknown>;
  if (failOnSilentTruncation !== undefined && typeof failOnSilentTruncation !== "boolean") {
    throw new InvalidRequestError("config.integrity.failOnSilentTruncation must be a boolean when provided");
  }
  if (failOnTerminationMismatch !== undefined && typeof failOnTerminationMismatch !== "boolean") {
    throw new InvalidRequestError("config.integrity.failOnTerminationMismatch must be a boolean when provided");
  }
}

function validateLoggingPolicy(logging: unknown): void {
  if (!logging || typeof logging !== "object") {
    throw new InvalidRequestError("config.logging is required");
  }
  const { enabled, logger, sampleRawContent } = logging as Record<string, unknown>;
  if (typeof enabled !== "boolean") {
    throw new InvalidRequestError("config.logging.enabled must be a boolean");
  }
  if (logger !== undefined && (typeof logger !== "object" || logger === null || typeof (logger as any).emit !== "function")) {
    throw new InvalidRequestError("config.logging.logger must implement { emit(event): void } when provided");
  }
  if (sampleRawContent !== undefined && typeof sampleRawContent !== "boolean") {
    throw new InvalidRequestError("config.logging.sampleRawContent must be a boolean when provided");
  }
}

function validateEmbeddingAdapterConfig(config: EmbeddingAdapterConfig): void {
  validateAdapterConfig(config);
  if (config.batchSize !== undefined) {
    if (typeof config.batchSize !== "number" || !Number.isInteger(config.batchSize) || config.batchSize < 1) {
      throw new InvalidRequestError("config.batchSize must be an integer >= 1 when provided");
    }
  }
}
```

**Règles normatives** :
- **Pas d'inférence silencieuse** : tout champ invalide fait throw, pas de fallback vers un défaut (I-4 fail-closed). La seule exception : les valeurs `undefined` pour des champs explicitement optionnels sont acceptées (le défaut est résolu par le consommateur du config : engine pour `jitter`, sanitizer pour `stripThinkingTags`, executeEmbedding pour `batchSize`).
- **Pas de check de cohérence inter-policies** : `maxAttempts` vs `perAttemptMs` vs `capDelayMs` ne sont pas comparés. Le consommateur peut configurer une combinaison exotique — l'engine s'exécutera sans sur-interpréter.
- **Pas de check de cohérence `model` ↔ `provider`** : aucune factory ne vérifie que `config.model` appartient à l'écosystème du provider (ex. passer `claude-3-5-sonnet` à `createOpenAIAdapter` est accepté côté runtime). L'erreur surgira au fetch (400 ou 404), classifiée en `InvalidRequestError` par le binding. Justification : la liste des modèles est mouvante, non dans le domaine normatif du runtime.

---

## 5. `buildSimplePrompt` — helper périphérique

**Fichier cible** : `src/factories/build-simple-prompt.ts`. **LOC cible** : ~15.

### 5.1 Signature

```ts
export function buildSimplePrompt(params: {
  system?: string;
  user: string;
}): LLMMessage[];
```

### 5.2 Algorithme

```ts
export function buildSimplePrompt(params: {
  system?: string;
  user: string;
}): LLMMessage[] {
  if (typeof params?.user !== "string" || params.user.length === 0) {
    throw new InvalidRequestError("buildSimplePrompt: params.user must be a non-empty string");
  }
  if (params.system !== undefined && typeof params.system !== "string") {
    throw new InvalidRequestError("buildSimplePrompt: params.system must be a string when provided");
  }

  const messages: LLMMessage[] = [];
  if (params.system !== undefined && params.system.length > 0) {
    messages.push({ role: "system", content: params.system });
  }
  messages.push({ role: "user", content: params.user });
  return messages;
}
```

### 5.3 Règles normatives

- **Zéro décision sémantique** : pas de normalisation du contenu, pas de trim, pas de concaténation de whitespace, pas de détection de langue, pas de templating. Le helper est strictement **constructeur de structure**.
- **`params.system === ""`** est traité comme **absent** : aucun message `system` n'est ajouté. Cohérent avec la convention du binding Anthropic §3.2 NIB-M-BINDINGS-COMPLETION (un system vide est omis).
- **Pas de `assistant` ou autre rôle** : `buildSimplePrompt` ne couvre que le cas `[system?, user]`. Les conversations multi-tours ou prefill `assistant` se construisent à la main (le runtime ne fournit pas de helper étendu en v1, c'est une décision explicite de minimalisme).
- **Throw `InvalidRequestError`** et pas `TypeError` : les erreurs de construction restent dans la famille `LLMRuntimeError` pour uniformité.

### 5.4 Use case type

```ts
import { buildSimplePrompt, createAnthropicAdapter } from "@vegacorp/llm-runtime";

const adapter = createAnthropicAdapter({ /* ... */ });

const response = await adapter.call({
  messages: buildSimplePrompt({
    system: "You are a concise assistant.",
    user: "What is the capital of France?",
  }),
  maxTokens: 100,
});
```

---

## 6. Surface `index.ts` — exports exhaustifs

**Fichier cible** : `src/index.ts`. **LOC cible** : ~60.

**Règle normative** : la liste ci-dessous est **exhaustive**. Tout symbole non listé est **privé**. L'ajout d'un export sans modification du NX et du NIB-T §26.1 (C-GL-01, C-GL-02) est une violation.

### 6.1 Types exportés (28 symboles)

```ts
// Requêtes/réponses
export type {
  LLMRequest,
  LLMResponse,
  LLMMessage,
  LLMRole,
  LLMUsage,
  LLMSanitizationInfo,
  LLMIntegrityInfo,
  TerminationReason,
} from "./types/request-response.js";

// Adapters
export type {
  ProviderAdapter,
  EmbeddingAdapter,
  AdapterStats,
  ProviderLongId,
} from "./types/adapter.js";

// Configs
export type {
  AdapterConfig,
  EmbeddingAdapterConfig,
  RetryPolicy,
  TimeoutPolicy,
  SanitizationPolicy,
  IntegrityPolicy,
  LoggingPolicy,
  LLMLogger,
} from "./types/config.js";

// Events (si externalisés pour les consommateurs de loggers custom)
export type {
  LLMEvent,
} from "./types/events.js";

// Erreurs — kind
export type { LLMErrorKind } from "./errors/kind.js";
```

### 6.2 Valeurs runtime exportées (19 symboles)

```ts
// Classe parent + 11 sous-classes (valeurs, exportées via `export class`)
export {
  LLMRuntimeError,
  AuthError,
  InvalidRequestError,
  RateLimitError,
  OverloadedError,
  TransientProviderError,
  ProviderProtocolError,
  ResponseParseError,
  TimeoutError,
  AbortedError,
  SilentTruncationError,
  ContentFilterError,
} from "./errors/subclasses.js";

// Helper pur sur l'union LLMErrorKind
export { isRetriableKind } from "./errors/kind.js";

// 5 factories
export { createAnthropicAdapter } from "./factories/create-anthropic-adapter.js";
export { createOpenAIAdapter } from "./factories/create-openai-adapter.js";
export { createOpenAICompatibleAdapter } from "./factories/create-openai-compatible-adapter.js";
export { createGoogleAdapter } from "./factories/create-google-adapter.js";
export { createOpenAIEmbeddingAdapter } from "./factories/create-openai-embedding-adapter.js";

// Helper périphérique
export { buildSimplePrompt } from "./factories/build-simple-prompt.js";
```

### 6.3 Interdiction explicite (cf. NIB-T C-GL-02)

Les symboles suivants **ne sont pas** exportés. Toute tentative d'`import` depuis le package en dehors du package doit échouer à la compilation (pas de re-export, pas de side path d'accès). Liste normative :

| Symbole | Raison |
| --- | --- |
| `executeCall` | Layer 2, invisible aux consommateurs |
| `executeEmbedding` | Layer 2, invisible aux consommateurs |
| `CanonicalHttpRequest` | Forme intermédiaire (NIB-S §6.1) |
| `ParsedProviderResponse` | Forme intermédiaire (NIB-S §6.2) |
| `ProviderErrorSignal` | Forme intermédiaire (NIB-S §6.3) |
| `BindingConfig` | Forme intermédiaire (NIB-S §6.4) |
| `ProviderBinding` | Contrat interne Layer 3 |
| `EmbeddingBinding` | Contrat interne Layer 3 |
| `ProviderQuirks` | Contrat interne Layer 3 |
| `RateLimitSnapshot` | Forme interne Layer 4 |
| `anthropicBinding`, `openaiBinding`, `googleBinding`, `openaiEmbeddingsBinding` | Constantes Layer 3 |
| `createOpenAICompatibleBinding` | Factory de binding, interne |
| `resolveRetryDecision`, `resolveThrottleDecision`, `createThrottleSnapshotService` | Services Layer 4 |
| `sanitizeContent`, `composeSignal`, `abortableSleep`, `classifyFromHttpStatus`, `estimateCallTokens` | Services Layer 4 |
| `clock`, `ulidCallId`, `resolveLogger` | Services infrastructure |

### 6.4 Absence délibérée

- Pas d'`export default` pour le package. Ce package n'a pas de symbole "principal" : il expose une famille plate.
- Pas de namespace `VegaCorp.*` ou similaire. Les imports se font par symbole.
- Pas de re-export de types Node.js (`AbortSignal`, `AbortController`) — ils sont standards et disponibles via `lib: ["dom"]` ou `@types/node`.

---

## 7. Examples

### 7.1 Happy path Anthropic

```ts
import { createAnthropicAdapter, buildSimplePrompt } from "@vegacorp/llm-runtime";

const adapter = createAnthropicAdapter({
  model: "claude-3-5-sonnet-20240620",
  apiKey: process.env.ANTHROPIC_API_KEY!,
  retry: { maxAttempts: 3, baseDelayMs: 1000, capDelayMs: 30_000, jitter: true },
  timeout: { perAttemptMs: 60_000 },
  sanitization: {},                               // vide = defaults du binding
  integrity: { failOnSilentTruncation: true },
  logging: { enabled: true },
});

const response = await adapter.call({
  messages: buildSimplePrompt({ user: "hello" }),
  maxTokens: 100,
});

console.log(adapter.provider);                   // "anthropic"
console.log(adapter.model);                      // "claude-3-5-sonnet-20240620"
console.log(adapter.stats.totalCalls);           // 1 (incrémenté par executeCall sur succès)
```

### 7.2 OpenAI-compatible avec DeepSeek + providerOptions (extendedThinking sur Anthropic)

```ts
const anthropicAdapter = createAnthropicAdapter({
  model: "claude-3-7-sonnet",
  apiKey: key,
  retry: { maxAttempts: 3, baseDelayMs: 1000, capDelayMs: 30_000 },
  timeout: { perAttemptMs: 120_000 },
  sanitization: {},
  integrity: {},
  logging: { enabled: false },
  providerOptions: {
    extendedThinking: { enabled: true, budgetTokens: 4096 },
  },
});

const deepseekAdapter = createOpenAICompatibleAdapter({
  provider: "deepseek",
  model: "deepseek-reasoner",
  apiKey: key,
  retry: { maxAttempts: 3, baseDelayMs: 1000, capDelayMs: 30_000 },
  timeout: { perAttemptMs: 120_000 },
  sanitization: {},                              // vide → binding défaut = stripThinkingTags: true
  integrity: {},
  logging: { enabled: true },
});

console.log(deepseekAdapter.provider);           // "deepseek"
```

### 7.3 Embedding batch

```ts
const embedder = createOpenAIEmbeddingAdapter({
  model: "text-embedding-3-small",
  apiKey: key,
  retry: { maxAttempts: 3, baseDelayMs: 1000, capDelayMs: 15_000 },
  timeout: { perAttemptMs: 30_000 },
  sanitization: {},
  integrity: {},
  logging: { enabled: false },
  batchSize: 200,                                 // override du défaut 100
});

const vectors = await embedder.embed(["hello", "world", /* ...500 items */]);
// vectors.length === 500
// vectors.every(v => v.length === 1536)

console.log(embedder.stats.totalCalls);          // 1 (un seul appel public, N batches internes)
```

### 7.4 Config invalide → InvalidRequestError (fail-closed)

```ts
// Manquant : apiKey
createAnthropicAdapter({
  model: "claude-3-5-sonnet",
  // apiKey: absent
  retry: { maxAttempts: 3, baseDelayMs: 1000, capDelayMs: 30_000 },
  timeout: { perAttemptMs: 60_000 },
  sanitization: {},
  integrity: {},
  logging: { enabled: false },
} as any);
// → throw new InvalidRequestError("config.apiKey must be a non-empty string")
//   enrichie { callId: null, provider: "anthropic", model: "claude-3-5-sonnet", attempts: 0 }
```

### 7.5 `buildSimplePrompt`

```ts
buildSimplePrompt({ user: "hello" });
// → [{ role: "user", content: "hello" }]

buildSimplePrompt({ system: "You are concise.", user: "hi" });
// → [{ role: "system", content: "You are concise." }, { role: "user", content: "hi" }]

buildSimplePrompt({ system: "", user: "hi" });
// → [{ role: "user", content: "hi" }]          ← system vide omis

buildSimplePrompt({ user: "" });
// → throw InvalidRequestError("buildSimplePrompt: params.user must be a non-empty string")
```

---

## 8. Edge cases

### 8.1 Config mutée après création

```ts
const config: AdapterConfig = { model: "claude-3-5-sonnet", /* ... */ };
const adapter = createAnthropicAdapter(config);

config.model = "claude-3-haiku";                 // mutation externe

adapter.model;                                    // doit rester "claude-3-5-sonnet"
// L'adapter se comporte comme si config.model valait "claude-3-5-sonnet"
```

**Cause racine du snapshot défensif** : `structuredClone` au step 2 de chaque factory. Toute factory qui omet cette étape viole I-8 (config figée) et C-GL-22 du NIB-T.

### 8.2 `providerOptions` invalide (Anthropic)

```ts
createAnthropicAdapter({
  /* ... */,
  providerOptions: { extendedThinking: { enabled: true, budgetTokens: -100 } },
});
// → throw InvalidRequestError("extendedThinking.budgetTokens must be a positive finite number")
```

### 8.3 OpenAI-compatible provider inconnu

```ts
createOpenAICompatibleAdapter({
  provider: "unknown-xyz" as any,                // cast bypass TS
  /* ... */,
});
// → throw InvalidRequestError("unsupported openai-compatible provider: unknown-xyz")
```

**Défense à deux étages** : TypeScript rejette au type-check (C-GL-14 NIB-T), runtime rejette défensivement pour les `any`-casts et les cas JS (consumers non typés).

### 8.4 `config.logging.logger` non conforme

```ts
createAnthropicAdapter({
  /* ... */,
  logging: { enabled: true, logger: { foo: 1 } as any },
});
// → throw InvalidRequestError("config.logging.logger must implement { emit(event): void } when provided")
```

### 8.5 `buildSimplePrompt` avec system très long

Aucune limite imposée. Le helper ne compte pas les tokens et ne truncate pas. Si le prompt dépasse la context window du modèle, la requête sera rejetée par le provider (classifiée en `InvalidRequestError` par le binding). Comportement normatif : **ne jamais sur-interpréter** la taille côté helper.

### 8.6 Appel `.call()` après un throw précédent

```ts
const adapter = createAnthropicAdapter({ /* ... */ });
try {
  await adapter.call({ messages: [] });          // throw InvalidRequestError
} catch {}

// L'adapter reste utilisable
await adapter.call({ messages: buildSimplePrompt({ user: "ok" }) });
// → OK, état non corrompu
```

**Garantie normative** : l'état interne de l'adapter (`stats`, `throttleSnapshot`) n'est **pas** modifié par un throw précoce (step 5 du NIB-M-EXECUTE-CALL : pas de retry sur `InvalidRequestError` de validation de request). L'adapter reste en état cohérent après n'importe quel throw.

### 8.7 Deux adapters du même provider coexistent

```ts
const adapterA = createAnthropicAdapter({ model: "claude-3-5-sonnet", /* ... */ });
const adapterB = createAnthropicAdapter({ model: "claude-3-haiku", /* ... */ });

adapterA.stats !== adapterB.stats;                // true — objets distincts
// Les stats et le throttleSnapshot sont locaux à chaque adapter (I-8).
// Deux adapters Anthropic avec des API keys différentes ont des budgets throttle indépendants.
```

### 8.8 `config.logging.enabled === false` avec `logger` injecté

```ts
createAnthropicAdapter({
  /* ... */,
  logging: { enabled: false, logger: myCustomLogger },
});
// → Adapter créé. myCustomLogger **ne reçoit jamais** d'event (enabled: false coupe tout, I-12).
//   Voir NIB-M-INFRA-UTILS §4 pour la résolution par resolveLogger.
```

### 8.9 `EmbeddingAdapterConfig.batchSize === 0` ou négatif

```ts
createOpenAIEmbeddingAdapter({
  /* ... */,
  batchSize: 0,
});
// → throw InvalidRequestError("config.batchSize must be an integer >= 1 when provided")
```

### 8.10 Appel concurrent `adapter.call` × N

Aucune contrainte d'ordonnancement côté factory. Chaque call crée son propre flux via `executeCall`. Les `stats` et le `throttleSnapshot` sont mutés de manière **non atomique** — mais la sémantique JavaScript single-threaded garantit qu'aucun interleave n'occurrera à l'intérieur d'un même tick synchrone. Les mutations sur `stats` sont scalaires (`++`) et donc atomiques de facto. Aucun lock requis en v1 (Node single-thread).

---

## 9. Constraints

### 9.1 Non-exports interdits

- Aucun des 16 symboles listés en §6.3 ne doit être exporté depuis `src/index.ts`.
- **Enforcement par test automatisé** : `C-GL-02` du NIB-T liste les symboles interdits. Le test vérifie que `import { symbol } from "@vegacorp/llm-runtime"` échoue à la compilation pour chacun.

### 9.2 Pas de state partagé inter-factories

- Les factories sont **idempotentes** : deux appels retournent deux adapters indépendants.
- Pas de cache global de binding : les constantes `anthropicBinding`, `openaiBinding`, `googleBinding`, `openaiEmbeddingsBinding` sont des **données**, pas des **ressources**. Elles peuvent être importées partout sans risque.
- Pas de singleton de logger : `resolveLogger` crée ou retourne le logger selon la policy de **chaque adapter**.

### 9.3 Pas de logique de call dans les factories

- Les factories **ne doivent pas** exécuter `fetch`, construire un `AbortSignal`, manipuler des headers, ou appeler le sanitizer. Tout ça vit dans `executeCall` / `executeEmbedding`.
- **Violation type à éviter** : une factory qui fait un "healthcheck" synchrone en appelant le binding à la création. **Interdit** : aucune IO au moment de la factory. Le runtime est lazy par construction — le premier réseau ne survient qu'au premier `call()`.

### 9.4 Validation exhaustive ou absence de validation

- Si une factory valide un champ (ex. `extendedThinking.budgetTokens > 0`), elle le valide **complètement** (type, domaine, contraintes).
- Si elle ne valide pas un champ (ex. `model` : on ne vérifie pas que "claude-3-5-sonnet-20240620" existe côté Anthropic), le throw survient côté provider ou côté binding au premier call.
- **Règle de Claude Code** : ne jamais introduire de "validation partielle" — c'est un anti-pattern qui masque le fail-closed (I-4).

### 9.5 Pas de dépendance cyclique

- `factories/` importe : `bindings/`, `engine/`, `services/throttle-snapshot.js`, `services/logger.js`, `types/*`, `errors/subclasses.js`.
- `factories/` **n'est importé par personne** sauf `index.ts`.
- Tentation à éviter : factoriser `validateAdapterConfig` dans `services/config-validator.ts`. **Non.** Cette fonction est spécifique au layer L1 et contient des assertions sur les policies publiques — elle vit dans `factories/` (fichier partagé ou module commun dans ce dossier).

### 9.6 Symétrie `ProviderAdapter` ↔ `EmbeddingAdapter`

- Les 4 factories completion retournent **strictement** la même shape :
  `{ provider, model, stats, call }` (4 champs, pas de surplus).
- La factory embedding retourne :
  `{ provider, model, stats, embed }` (4 champs, pas de surplus).
- Aucune factory ne doit exposer `binding`, `config`, `throttleSnapshot`, `logger` sur l'adapter public. Ces champs restent **captifs** de la closure passée à `executeCall`.

### 9.7 `readonly` sur les champs publics

- `adapter.provider` et `adapter.model` sont **typés `readonly`** (cf. NIB-S §6.3 et NIB-T C-GL-23, C-GL-24).
- `adapter.stats` est **typé `readonly AdapterStats`** — l'objet exposé est la référence mutable interne, mais TypeScript empêche les assignations directes (`adapter.stats.totalCalls = 42` est type-error).
- **Enforcement runtime** : pas de `Object.freeze` requis sur l'objet retourné (coût nul en v1). La discipline TS suffit en développement ; les tests vérifient par assertion TS uniquement.

### 9.8 `structuredClone` disponible

- `structuredClone` est natif Node ≥ 17 et disponible en Node ≥ 20 (target v1). Aucun polyfill requis.
- En cas de structure contenant des fonctions (`logger.emit`), `structuredClone` **throw**. Pour éviter ceci, **le `logger` injecté n'entre pas dans le clone** : la factory extrait `logging.logger` avant le clone, puis le réinjecte post-clone via `resolveLogger`.

Pattern normatif :
```ts
function snapshotConfig<T extends AdapterConfig>(config: T): T {
  const { logger, ...rest } = config.logging;
  const cloned = structuredClone({ ...config, logging: { ...rest } });
  cloned.logging.logger = logger;                 // réinjection de la référence non-clonable
  return cloned as T;
}
```

Cette fonction remplace `structuredClone(config)` dans les 5 factories.

---

## 10. Integration snippets

### 10.1 Structure de fichier complète

```
src/factories/
├── create-anthropic-adapter.ts          # Factory + validation provider-options Anthropic
├── create-openai-adapter.ts             # Factory (aucune validation provider-options en v1)
├── create-openai-compatible-adapter.ts  # Factory + table DEFAULT_ENDPOINTS + guard runtime
├── create-google-adapter.ts             # Factory
├── create-openai-embedding-adapter.ts   # Factory embedding
├── build-simple-prompt.ts               # Helper 15 LOC
├── validate-adapter-config.ts           # validateAdapterConfig + 5 sous-validators + snapshotConfig
└── index.ts                             # Re-exports des 5 factories + buildSimplePrompt (consommé par src/index.ts)
```

### 10.2 Usage dans un consommateur

```ts
// Dans l'app consommatrice
import {
  createAnthropicAdapter,
  createOpenAIEmbeddingAdapter,
  buildSimplePrompt,
  InvalidRequestError,
  isRetriableKind,
} from "@vegacorp/llm-runtime";

const llm = createAnthropicAdapter({
  model: "claude-3-5-sonnet-20240620",
  apiKey: process.env.ANTHROPIC_API_KEY!,
  retry: { maxAttempts: 3, baseDelayMs: 1000, capDelayMs: 30_000, jitter: true },
  timeout: { perAttemptMs: 60_000 },
  sanitization: { stripJsonFence: true },
  integrity: { failOnSilentTruncation: true },
  logging: { enabled: true },
});

try {
  const r = await llm.call({ messages: buildSimplePrompt({ user: "ping" }), maxTokens: 50 });
  console.log(r.content);
} catch (e) {
  if (e instanceof InvalidRequestError) {
    console.error("config ou request invalide:", e.message);
  } else if (e.kind && isRetriableKind(e.kind)) {
    console.warn("erreur retry-éligible épuisée:", e.message);
  } else {
    throw e;
  }
}
```

### 10.3 `index.ts` complet (squelette)

```ts
// src/index.ts — Source of truth pour la surface publique

// ─── Types ─────────────────────────────────────────────────────────────
export type {
  LLMRequest,
  LLMResponse,
  LLMMessage,
  LLMRole,
  LLMUsage,
  LLMSanitizationInfo,
  LLMIntegrityInfo,
  TerminationReason,
} from "./types/request-response.js";

export type {
  ProviderAdapter,
  EmbeddingAdapter,
  AdapterStats,
  ProviderLongId,
} from "./types/adapter.js";

export type {
  AdapterConfig,
  EmbeddingAdapterConfig,
  RetryPolicy,
  TimeoutPolicy,
  SanitizationPolicy,
  IntegrityPolicy,
  LoggingPolicy,
  LLMLogger,
} from "./types/config.js";

export type { LLMEvent } from "./types/events.js";

export type { LLMErrorKind } from "./errors/kind.js";

// ─── Classes d'erreur (valeurs) ────────────────────────────────────────
export {
  LLMRuntimeError,
  AuthError,
  InvalidRequestError,
  RateLimitError,
  OverloadedError,
  TransientProviderError,
  ProviderProtocolError,
  ResponseParseError,
  TimeoutError,
  AbortedError,
  SilentTruncationError,
  ContentFilterError,
} from "./errors/subclasses.js";

// ─── Helper kind ───────────────────────────────────────────────────────
export { isRetriableKind } from "./errors/kind.js";

// ─── Factories (5) ─────────────────────────────────────────────────────
export { createAnthropicAdapter } from "./factories/create-anthropic-adapter.js";
export { createOpenAIAdapter } from "./factories/create-openai-adapter.js";
export { createOpenAICompatibleAdapter } from "./factories/create-openai-compatible-adapter.js";
export { createGoogleAdapter } from "./factories/create-google-adapter.js";
export { createOpenAIEmbeddingAdapter } from "./factories/create-openai-embedding-adapter.js";

// ─── Helper périphérique ───────────────────────────────────────────────
export { buildSimplePrompt } from "./factories/build-simple-prompt.js";
```

### 10.4 Skeleton de factory (générique)

```ts
// Template pour les 4 completion factories (Anthropic, OpenAI, Google, et openai-compatible après guard)

export function createXAdapter(config: AdapterConfig /* + surcharge optionnelle */): ProviderAdapter {
  validateAdapterConfig(config);
  // [optionnel] validateXProviderOptions(config.providerOptions);

  const snapshot = snapshotConfig(config);                 // voir §9.8
  const binding = /* anthropicBinding | openaiBinding | googleBinding | createOpenAICompatibleBinding(...) */;
  const throttleSnapshot = createThrottleSnapshotService();
  const stats: AdapterStats = { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 };
  const logger = resolveLogger(snapshot.logging);

  return {
    provider: binding.provider,
    model: snapshot.model,
    stats,
    call: (request) =>
      executeCall(request, binding, snapshot, { throttleSnapshot, stats, logger }),
  };
}
```

### 10.5 Convention de test (NIB-T §26)

Les tests de factories vivent dans `tests/factories/`. Exemples :

```ts
// tests/factories/create-anthropic-adapter.test.ts
describe("createAnthropicAdapter", () => {
  it("C-GL-04: returns adapter with provider='anthropic', model, stats, call", () => {
    const a = createAnthropicAdapter(validConfig);
    expect(a.provider).toBe("anthropic");
    expect(a.model).toBe(validConfig.model);
    expect(a.stats).toEqual({ totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 });
    expect(typeof a.call).toBe("function");
  });

  it("C-GL-22: mutation externe du config n'affecte pas l'adapter", () => {
    const cfg = { ...validConfig, model: "claude-3-5-sonnet" };
    const a = createAnthropicAdapter(cfg);
    cfg.model = "mutated";
    expect(a.model).toBe("claude-3-5-sonnet");
  });

  it("fail-closed: apiKey absent → InvalidRequestError", () => {
    const { apiKey, ...rest } = validConfig;
    expect(() => createAnthropicAdapter(rest as any))
      .toThrow(InvalidRequestError);
  });

  it("fail-closed: extendedThinking.budgetTokens négatif → InvalidRequestError", () => {
    expect(() =>
      createAnthropicAdapter({
        ...validConfig,
        providerOptions: { extendedThinking: { enabled: true, budgetTokens: -1 } },
      })
    ).toThrow("extendedThinking.budgetTokens must be a positive finite number");
  });
});
```

---

## 11. Observabilité — rappel

Les factories **n'émettent aucun event**. Tous les events (`llm_call_start`, etc.) sont émis par `executeCall` et `executeEmbedding` — l'adapter délègue, ne mesure pas.

**Exception défensive** : si un futur besoin émerge (ex. `llm_adapter_created`), il est normalisé **dans le NX** avant implémentation. Pas d'ajout silencieux.

---

## 12. Relations avec les autres NIBs

| Ce module consomme | Via |
| --- | --- |
| **NIB-M-ERRORS** | `LLMRuntimeError`, `InvalidRequestError` — throw de validation |
| **NIB-M-ERROR-KIND** | `isRetriableKind` — re-exporté |
| **NIB-M-INFRA-UTILS** | `resolveLogger` — résolution du logger par adapter |
| **NIB-M-THROTTLE** | `createThrottleSnapshotService` — state local par adapter |
| **NIB-M-BINDINGS-COMPLETION** | `anthropicBinding`, `openaiBinding`, `googleBinding`, `createOpenAICompatibleBinding` |
| **NIB-M-BINDING-EMBEDDING** | `openaiEmbeddingsBinding` |
| **NIB-M-EXECUTE-CALL** | `executeCall` — déléguée par `adapter.call` |
| **NIB-M-EXECUTE-EMBEDDING** | `executeEmbedding` — déléguée par `adapter.embed` |
| **NIB-S-LLMRUNTIME** | Invariants I-2, I-4, I-8, I-9 ; structure `AdapterStats` ; file tree §10.5 |

Aucun autre NIB ne dépend de ce module (c'est un **terminal consumer**, layer L1).

---

## 13. Checklist de conformité (pour review)

- [ ] 5 factories définies exactement conformes aux signatures §2.1.
- [ ] `validateAdapterConfig` appelée en step 1 dans chacune des 5 factories.
- [ ] `snapshotConfig` (clone défensif sans-logger) appelé en step 2 dans chacune des 5 factories.
- [ ] Aucun `Object.freeze`, aucun SDK officiel importé, aucun `fetch`/`clock`/sanitizer dans les factories.
- [ ] `adapter.provider` strictement égal à `binding.provider` (un `ProviderLongId`).
- [ ] `adapter.stats` initialisé à `{ totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 }`.
- [ ] `buildSimplePrompt` : omet `system` vide, throw sur `user` vide ou non-string.
- [ ] `src/index.ts` exporte les 28 types + 19 valeurs listés §6.1-§6.2, **et rien d'autre**.
- [ ] Tous les tests C-GL-01 à C-GL-25 du NIB-T §26 passent.
- [ ] Aucun symbole de la liste §6.3 n'est accidentellement exporté (vérif par script : `grep -E "^export" src/index.ts | diff - expected-exports.txt`).

---

**Fin NIB-M-FACTORIES.**
