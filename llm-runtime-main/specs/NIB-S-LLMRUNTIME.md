---
id: NIB-S-LLMRUNTIME
type: nib-system
version: "1.0.0"
scope: llm-runtime
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-S-LLMRUNTIME — System Brief

**Package** : `@vegacorp/llm-runtime`
**Statut** : v1.0 — éclatement NIB actif, consommable par Claude Code
**Source NX** : `NX-LLMRUNTIME v0.13`

---

## 0. Préambule

Ce document est le **System Brief** de `@vegacorp/llm-runtime`. Il établit le frame dans lequel tous les NIB-M et Dependency Contracts associés opèrent. Il définit :

- L'objectif système et la frontière v1
- L'architecture en 4 couches et la liste exhaustive des modules
- Les invariants globaux (transversaux à tous les modules)
- Les policies cross-cutting (retry, timeout, sanitization, integrity, logging)
- Le contrat de sortie (`LLMResponse`) et les types publics
- L'orchestration de haut niveau : comment les factories câblent l'engine, les bindings et les services

Il ne décrit **pas** les algorithmes internes des modules — ceux-là sont décrits dans les NIB-M dédiés.

---

## 1. Objectif système

### 1.1 Problème résolu

Les systèmes VegaCorp qui font des appels LLM (`md-structural-normalizer`, `key-concepts-extractor`, et chaque nouveau module du pipeline de revue littéraire automatisée) réimplémentent de manière divergente la couche bas niveau d'appel aux providers LLM. Résultat : ~1000+ LOC de logique quasi-identique dupliquée, incohérences de comportement entre systèmes, taxonomies d'erreur incompatibles, observabilité fragmentée, coût de maintenance croissant.

### 1.2 Réponse `@vegacorp/llm-runtime`

Un package infrastructure transversal qui fournit un moteur d'exécution normalisée de requêtes LLM. Chaque call traverse un moteur déterministe avec des décisions matérialisées (retry, throttle, termination) — pas juste un wrapper fonctionnel autour de `fetch`.

### 1.3 Positionnement

- Package **infrastructure transversale** VegaCorp — consommé par n'importe quel système ayant besoin d'appeler un LLM ou un embedding provider.
- Distinct de `@yada-one/llm-to-json` (qui vit à un niveau au-dessus et pourra consommer ce runtime en v2).
- Strictement process-local : pas de coordination distribuée v1.

---

## 2. Frontière v1

### 2.1 Dans le scope (ce que le package fait)

- Exécution d'appels de complétion (single-turn et multi-turn via `messages[]`)
- Exécution d'embeddings (batch)
- Retry sur erreurs transitoires avec backoff exponentiel + respect de `Retry-After`
- Throttling proactif via headers `x-ratelimit-*` (providers qui les exposent)
- Détection de truncation (explicite provider + heuristique silencieuse opt-in)
- Sanitization observable (thinking tags, JSON fences)
- Composition de signaux (timeout interne + abort externe)
- Classification sémantique d'erreurs
- Observabilité structurée (logs JSON stderr + logger injectable)
- Normalisation des raisons de terminaison
- Corrélation par `callId` (ULID généré mécaniquement par call)
- Compteur passif d'usage sur l'adapter (`AdapterStats`)

### 2.2 Hors scope v1 (frontière dure)

| Zone | Statut v1 | Justification |
| --- | --- | --- |
| Construction de prompts | Hors scope (helper périphérique `buildSimplePrompt` uniquement) | Métier, pas infra |
| Parsing de réponse structuré (JSON schema enforcement) | Hors scope | Voir `@yada-one/llm-to-json` |
| Tool calling / function calling | Hors scope | NX séparé quand un consommateur en aura besoin |
| Streaming | Hors scope | NX séparé |
| Multimodal (images, audio, vidéo) | Hors scope | `LLMMessage.content: string` uniquement |
| Headers HTTP multi-valeur | Collapsés sur la dernière occurrence | Aucun header normativement exploité par le runtime n'est multi-valeur chez les providers ciblés |
| Caching de réponses | Hors scope | Responsabilité consommateur |
| Budget tracking / pricing / alertes | Hors scope | Le package accumule les métriques passivement, la décision d'arrêter est au consommateur |
| Multi-turn conversation state | Hors scope | Le consommateur gère ses `messages[]` |
| Coordination distribuée | Hors scope | Process-local uniquement |
| Auto-retry sur content filter | Hors scope | `ContentFilterError` remonte au consommateur |
| GET / multipart / binary / GraphQL | Hors scope | POST + JSON uniquement en v1 |
| Jitter sur backoff | Hors scope | Backoff déterministe pur |
| Circuit breaker | Hors scope | Chaque call retente indépendamment |

Toute future demande d'ajouter une feature listée ci-dessus doit : (1) ouvrir un NX séparé justifiant le besoin et l'architecture, (2) définir l'impact sur la surface publique (breaking ou non), (3) être validée par triangulation avant implémentation.

---

## 3. Invariants globaux (transversaux)

Ces invariants s'appliquent à tous les modules. Les NIB-M ne les répètent pas — ils y renvoient.

### I-1 — Séparation décision / exécution / preuve

Les trois décisions mécaniques du runtime (retry, throttle, termination mapping) sont matérialisées comme **objets explicites** avant exécution, loggées, et observables. Le consommateur peut inspecter, rejouer, contester chaque décision.

### I-2 — Moteur unique, bindings minces

Un seul moteur d'exécution (`executeCall` pour completions, `executeEmbedding` pour embeddings). Chaque provider fournit un binding qui contient uniquement : transformation requête → HTTP canonique, parsing HTTP → forme canonique intermédiaire, classification d'erreur provider-spécifique, lecture des headers rate-limit, et table de mapping de terminaison (pour completion uniquement).

Les bindings ne contiennent aucune logique de retry, timeout, logging, sanitization. Cette logique vit dans l'engine et ses services transversaux.

### I-3 — Zero decision latitude

Le package ne prend jamais de décision sémantique. Aucun fallback silencieux. Aucune substitution de modèle. Aucun skip implicite. Toute divergence de l'attendu → exception typée ou événement observable, jamais silence.

### I-4 — Fail-closed

Toute erreur non-retriable → throw immédiat. Toute erreur retriable épuisée → throw d'une erreur sémantique typée. Le package ne retourne jamais de réponse dégradée. Pas de best-effort.

### I-5 — Déterminisme mécanique

Retry resolver, throttle resolver, error classifier, termination mapper, sanitizer, signal composer sont tous des **fonctions pures**. Étant données les mêmes entrées, elles produisent les mêmes sorties. Aucun effet de bord, aucune randomisation (pas de jitter aléatoire v1).

Les effets de bord (`fetch`, `sleep`, logger, clock access, callId generation, throttle snapshot update) sont isolés dans des composants dédiés.

**Formulation canonique** : le moteur est une composition déterministe de décisions pures et d'effets isolés.

### I-6 — Observabilité obligatoire

Chaque call de completion produit au minimum :

- 1 event `llm_call_start`
- N events `llm_call_attempt_start` (N = nombre d'attempts)
- 0..N events `llm_call_throttled`
- 0..N-1 events `llm_call_retry_scheduled`
- 0..M events d'erreur intermédiaires (`llm_call_fetch_error`, `llm_call_provider_error`, `llm_call_parse_error`)
- 0..1 event `llm_call_sanitized`
- 0..1 event `llm_call_unknown_termination`
- 0..M events `llm_call_unknown_error_classified`
- 1 event `llm_call_end`

Chaque call d'embedding produit au minimum :

- 1 event `llm_embedding_start`
- N events `llm_embedding_batch`
- 1 event `llm_embedding_end`

Tous corrélables par `callId` (généré mécaniquement au début, partagé par tous les events du call).

### I-7 — Abort propagé

Tout `AbortSignal` externe passé dans une `LLMRequest` interrompt l'appel en cours ET les sleeps de retry. L'abort externe prime sur toute autre logique. Aucune attente ne survit à un abort global.

### I-8 — Configuration figée au moment de la factory

Les adapters sont instanciés par une factory (`createAnthropicAdapter(config)`) qui fige le modèle, les defaults, les policies (retry, timeout, sanitization, integrity, logging), et les options provider-spécifiques. Une fois créé, un adapter est immutable. Pour changer un paramètre, on crée un nouvel adapter.

### I-9 — Surface publique petite et stable

Le contrat public (types, policies, adapters, factories, erreurs, helpers listés en §5) est minimal et versionné en semver strict. Toute modification breaking = major bump. Les options exotiques provider-spécifiques n'entrent **jamais** dans le contrat public portable — elles vivent dans la config factory de chaque adapter via `providerOptions` typé `unknown` au niveau commun et affiné localement par chaque factory.

### I-10 — JSON-only en v1

Le transport v1 est JSON-only. Tous les bindings produisent des `CanonicalHttpRequest` avec `bodyKind: "json" | "empty"`. Multipart, form-data, binary, streaming, GET sont hors scope v1. Extension future = breaking change documenté.

### I-11 — Immutabilité observable de `LLMRequest`

L'engine NE modifie JAMAIS l'objet `LLMRequest` passé. Un test contractuel vérifie : après `adapter.call(request)`, une comparaison structurelle de `request` avec un snapshot pris avant l'appel est identique.

### I-12 — Pas de PII dans les logs

Les prompts ne sont **jamais** loggés. Ni `systemPrompt`, ni `userPrompt`, ni le contenu de messages. Ni le `content` de réponse. Seules métriques : tailles (`messagesCount`), identifiants (`callId`, `providerResponseId`), types (`eventType`, `errorKind`), durées, status codes, noms de modèles.

**Exception contrôlée** : `llm_call_sanitized` peut logger un preview de 500 chars max de `rawContent` quand `thinkingTagsRemoved && content.length === 0` (pour debug). Ce preview contient du contenu modèle, jamais de contenu consommateur injecté.

### I-13 — Casse des clés de headers

Tous les `Record<string, string>` de headers circulant dans le runtime (après conversion par l'engine) utilisent des **clés lowercase**. Invariant garanti par `Object.fromEntries(response.headers.entries())` — la Fetch spec normalise `Headers.entries()` en lowercase. Tous les accès downstream (`readRateLimitHeaders`, `parseRetryAfter`, `classifyError`, bindings) utilisent des clés lowercase.

### I-14 — Parsing JSON centralisé dans l'engine

Le `JSON.parse(responseText)` est exécuté **uniquement** dans l'engine (`executeCall`, `executeEmbedding`). Les bindings reçoivent le body déjà parsé en `unknown` : `parseResponse(body: unknown, headers)` et `parseEmbeddings(body: unknown, headers)`. Un binding n'appelle **jamais** `JSON.parse` lui-même.

**Conséquences** :
- Un seul point d'émission de `ResponseParseError` pour cause de JSON malformé (engine), distinct des `ResponseParseError` pour cause de structure inattendue (binding).
- Les bindings restent purs et transport-agnostiques : ils valident la forme d'un objet JS, pas le transport HTTP.
- Le test des bindings n'a pas besoin de fabriquer des `string` JSON valides — un objet JS suffit.

### I-15 — Horloges injectées aux bindings

Les bindings qui ont besoin du temps (conversion d'un timestamp wall-clock de reset rate-limit vers le référentiel monotone interne) le reçoivent en argument : `readRateLimitHeaders(headers, nowMono: number, nowWall: Date)`. Un binding n'appelle **jamais** `Date.now()`, `performance.now()`, ni `new Date()` directement.

**Conséquences** :
- Source unique de vérité temporelle : `infra/clock.ts` (cf. NIB-M-INFRA-UTILS §3.2.3, C-IU1).
- Les bindings restent des fonctions pures (modulo clock args) : déterministes et testables sans mock global.
- Cohérence wall↔monotone garantie par construction — les deux valeurs passées sont capturées au même instant par l'engine.

---

## 4. Architecture en 4 couches

### 4.1 Vue d'ensemble

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1 — Public API                                    │
│ LLMRequest, LLMResponse, ProviderAdapter,               │
│ EmbeddingAdapter, Errors (semantic), Policies,          │
│ Factories, buildSimplePrompt                            │
├─────────────────────────────────────────────────────────┤
│ Layer 2 — Execution Engine                              │
│ executeCall, executeEmbedding                           │
│ orchestrates: throttle → signal compose → fetch →       │
│   classify → parse → sanitize → detect termination →    │
│   log → return                                          │
├─────────────────────────────────────────────────────────┤
│ Layer 3 — Provider Bindings                             │
│ ProviderBinding (completion) — 4 bindings :             │
│   anthropic, openai, openai-compatible, google          │
│   → buildRequest, parseResponse, classifyError,         │
│     readRateLimitHeaders, terminationMap, quirks        │
│ EmbeddingBinding (embedding) — 1 binding :              │
│   openai-embeddings                                     │
│   → buildRequest, parseEmbeddings, classifyError,       │
│     readRateLimitHeaders, quirks (Pick)                 │
├─────────────────────────────────────────────────────────┤
│ Layer 4 — Transverse Services                           │
│ retry-resolver, throttle-resolver, throttle-snapshot,   │
│ signal-composer, sanitizer, error-classifier-base,      │
│ logger, callId-generator, token-estimator, clock        │
└─────────────────────────────────────────────────────────┘
```

### 4.2 Liste exhaustive des modules et leur NIB-M

| Couche | Module | NIB-M | Rôle |
| --- | --- | --- | --- |
| L4 | retry-resolver + parseRetryAfter | NIB-M-RETRY-RESOLVER | Décision retry matérialisée + helper parseRetryAfter |
| L4 | throttle-resolver + throttle-snapshot | NIB-M-THROTTLE | Décision throttle + gestion stateful snapshot par adapter |
| L4 | token-estimator | NIB-M-TOKEN-ESTIMATOR | Estimation tokens call pour throttle |
| L4 | error-kind | NIB-M-ERROR-KIND | Union `LLMErrorKind`, `isRetriableKind` |
| L4 | sanitizer | NIB-M-SANITIZER | Strip thinking, strip JSON fence, detect truncation |
| L4 | signal-composer | NIB-M-SIGNAL-COMPOSER | `composeSignal`, `abortableSleep` |
| L4 | error-classifier-base | NIB-M-ERROR-CLASSIFIER-BASE | Classifier HTTP → erreur sémantique |
| L4 | clock, callId-generator, logger | NIB-M-INFRA-UTILS | Utilitaires techniques triviaux groupés |
| transv. | Taxonomie d'erreurs | NIB-M-ERRORS | Classe abstraite + 11 sous-classes |
| L3 | 4 bindings completion | NIB-M-BINDINGS-COMPLETION | Anthropic, OpenAI, OpenAI-compatible, Google |
| L3 | 1 binding embedding | NIB-M-BINDING-EMBEDDING | OpenAI Embeddings |
| L2 | executeCall | NIB-M-EXECUTE-CALL | Flow completion end-to-end |
| L2 | executeEmbedding | NIB-M-EXECUTE-EMBEDDING | Flow embedding end-to-end |
| L1 | Factories + surface publique | NIB-M-FACTORIES | 5 factories + exports + `buildSimplePrompt` |

### 4.3 Frontières de modules (types IN/OUT)

Chaque module consomme et produit des types canoniques. La coexistence de ces types assure la cohérence inter-module.

**Types publics** (exportés, Layer 1) :
- `LLMRequest`, `LLMResponse`, `LLMMessage`, `LLMRole`, `LLMUsage`, `LLMSanitizationInfo`, `LLMIntegrityInfo`, `TerminationReason`
- `ProviderAdapter`, `EmbeddingAdapter`, `AdapterStats`, `AdapterConfig`, `EmbeddingAdapterConfig`, `ProviderLongId`
- `LLMRuntimeError` (classe abstraite) + 11 sous-classes concrètes, `LLMErrorKind`, `isRetriableKind`
- `RetryPolicy`, `TimeoutPolicy`, `SanitizationPolicy`, `IntegrityPolicy`, `LoggingPolicy`, `LLMLogger`, `LLMEvent` (union discriminée)

**Types canoniques intermédiaires** (NON exportés, circulent entre layers) :
- `CanonicalHttpRequest` (§6.1) — produit par binding, consommé par engine
- `ParsedProviderResponse` (§6.2) — produit par binding, consommé par engine
- `ProviderErrorSignal` (§6.3) — produit par engine, consommé par classifier (binding ou base)
- `BindingConfig` (§6.4) — projection de `AdapterConfig` vers binding, produit par engine

**Types de décision matérialisée** (NON exportés) :
- `RetryDecision`, `ThrottleDecision`, `RateLimitSnapshot`

**Types d'events** (`LLMEvent` union, exportée pour consommateurs custom) :
- 14 variantes discriminées par `eventType` — voir §8

---

## 5. Surface publique (Layer 1) — contrat stable

### 5.1 Types exportés

```ts
// Messages & request
export type LLMRole = "system" | "user" | "assistant";
export interface LLMMessage {
  readonly role: LLMRole;
  readonly content: string;
}
export interface LLMRequest {
  readonly messages: readonly LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  stopSequences?: readonly string[];
}

// Response
export type TerminationReason =
  | "completed"
  | "max_tokens"
  | "stop_sequence"
  | "content_filter"
  | "unknown";

export interface LLMUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}
export interface LLMSanitizationInfo {
  thinkingTagsRemoved: boolean;
  jsonFenceRemoved: boolean;
}
export interface LLMIntegrityInfo {
  truncationDetected: boolean;
  truncationMode?: "explicit_max_tokens" | "heuristic_json_unclosed" | "silent_prompt_truncation";
}
export interface LLMResponse {
  callId: string;
  provider: ProviderLongId;
  model: string;
  providerModel?: string;
  rawContent: string;
  content: string;
  termination: TerminationReason;
  sanitization: LLMSanitizationInfo;
  integrity: LLMIntegrityInfo;
  usage: LLMUsage;
  attemptCount: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

// Adapters
export interface ProviderAdapter {
  readonly provider: ProviderLongId;
  readonly model: string;
  readonly stats: AdapterStats;
  call(
    request: LLMRequest,
    options?: { signal?: AbortSignal },
  ): Promise<LLMResponse>;
}
export interface EmbeddingAdapter {
  readonly provider: ProviderLongId;
  readonly model: string;
  readonly stats: AdapterStats;
  embed(
    texts: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<number[][]>;
}
export interface AdapterStats {
  readonly totalCalls: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalDurationMs: number;
}

// Provider set (fermé v1)
export type ProviderLongId =
  | "anthropic"
  | "openai"
  | "google"
  | "deepseek"
  | "mistral"
  | "groq"
  | "together"
  | "ollama";

// Configs
export interface AdapterConfig {
  model: string;
  apiKey: string;
  endpoint?: string;
  retry?: RetryPolicy;
  timeout?: TimeoutPolicy;
  sanitization: SanitizationPolicy;
  integrity?: IntegrityPolicy;
  logging?: LoggingPolicy;
  providerOptions?: unknown;
}
export interface EmbeddingAdapterConfig {
  model: string;
  apiKey: string;
  endpoint?: string;
  batchSize?: number;           // default 100
  retry?: RetryPolicy;
  timeout?: TimeoutPolicy;
  logging?: LoggingPolicy;
}

// Errors
export type LLMErrorKind =
  | "auth" | "invalid_request" | "rate_limit" | "overloaded"
  | "transient_provider" | "provider_protocol" | "response_parse"
  | "timeout" | "aborted" | "silent_truncation" | "content_filter";

export declare abstract class LLMRuntimeError extends Error {
  abstract readonly kind: LLMErrorKind;
  readonly provider?: ProviderLongId;
  readonly model?: string;
  readonly callId?: string;
  readonly attempts?: number;
}
// + 11 sous-classes concrètes (voir NIB-M-ERRORS)

export declare function isRetriableKind(kind: LLMErrorKind): boolean;

// Logger
export interface LLMLogger {
  emit(event: LLMEvent): void;
}
// + LLMEvent union discriminée (voir §8)
```

### 5.2 Policies exportées

```ts
export interface RetryPolicy {
  maxAttempts: number;         // default 5
  backoffBaseMs: number;       // default 2000
  maxBackoffMs: number;        // default 60000
}

export interface TimeoutPolicy {
  perAttemptMs: number;        // default 120000
}

export interface SanitizationPolicy {
  stripThinkingTags?: boolean;
  stripJsonFence?: boolean;
}

export interface IntegrityPolicy {
  detectHeuristicTruncation?: boolean;     // default false (opt-in)
  failOnSilentTruncation?: boolean;        // default false (opt-in)
  failOnUnknownTermination?: boolean;      // default false (opt-in)
  failOnModelMismatch?: boolean;           // default false (opt-in)
  modelMismatchPredicate?: (requested: string, resolved: string) => boolean;
}

export interface LoggingPolicy {
  logger?: LLMLogger;
  enabled?: boolean;
}
```

**Sémantique des policies** :

- `RetryPolicy.maxAttempts` = nombre total de tentatives, attempt initial inclus. Condition de retry : `attempt + 1 < maxAttempts` (attempt 0-indexé dans la boucle).
- `SanitizationPolicy` champs optionnels : absent = "ne pas override le défaut du binding". L'engine résout via `config.sanitization?.flag ?? binding.quirks.defaultSanitization.flag`. Dans `AdapterConfig`, le champ `sanitization` est **obligatoire** (objet toujours présent, vide `{}` autorisé).
- `IntegrityPolicy` tous les `failOn*` sont **opt-in** (default false). Par défaut : diagnostic (flags dans `LLMResponse.integrity`), pas de throw.
- `LoggingPolicy.enabled === false` coupe toute émission, y compris vers un logger injecté (sémantique single-switch).

### 5.3 Factories exportées

```ts
export declare function createAnthropicAdapter(config: AdapterConfig): ProviderAdapter;
export declare function createOpenAIAdapter(config: AdapterConfig): ProviderAdapter;
export declare function createOpenAICompatibleAdapter(config: AdapterConfig & { provider: Exclude<ProviderLongId, "anthropic"|"openai"|"google"> }): ProviderAdapter;
export declare function createGoogleAdapter(config: AdapterConfig): ProviderAdapter;
export declare function createOpenAIEmbeddingAdapter(config: EmbeddingAdapterConfig): EmbeddingAdapter;
```

### 5.4 Helper périphérique

```ts
export declare function buildSimplePrompt(params: {
  system?: string;
  user: string;
}): LLMMessage[];
```

Helper d'ergonomie. Ne prend aucune décision sémantique. Pas de normalisation de contenu.

---

## 6. Formes canoniques intermédiaires (non exportées)

Ces formes vivent entre les layers. Pas d'export dans `index.ts`. Mais elles sont **normatives** : tout binding et l'engine doivent les respecter.

### 6.1 CanonicalHttpRequest

```ts
interface CanonicalHttpRequest {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  bodyKind: "json";
  bodyJson: Record<string, unknown>;
}
```

**Règles normatives** :
- v1 : `method` fixé à `"POST"`. Extension future = breaking change.
- v1 : `bodyKind` fixé à `"json"`. Multipart/binary/empty hors scope v1.
- `bodyJson` est toujours présent et de type `Record<string, unknown>` — tout binding v1 produit un objet JSON.
- L'engine (pas le binding) sérialise via `JSON.stringify(bodyJson)`. Unique point de sérialisation.
- Le binding fournit **toujours** un objet JS pour `bodyJson`. **Jamais** une string pré-sérialisée.
- L'ordre des propriétés de `bodyJson` n'a aucune sémantique contractuelle.

### 6.2 ParsedProviderResponse

```ts
interface ParsedProviderResponse {
  rawContent: string;
  terminationSignal: string;
  usage: LLMUsage;
  providerResponseId?: string;
  providerModel?: string;
  metadata?: Record<string, unknown>;
}
```

**Règles normatives** :
- `parseResponse` n'applique **aucune** sanitization. Sortie brute extraite de la réponse HTTP.
- `parseResponse` n'infère **aucune** erreur métier. Si le parse échoue techniquement (JSON malformé, champ requis manquant), throw `ResponseParseError`.
- `parseResponse` n'interprète **aucune** heuristique (pas de detection de truncation, pas de normalisation de terminaison).
- `metadata` est **strictement opaque et non contractuelle**. Debug/inspection uniquement. **Enforcement par test automatisé** : aucun fichier de `src/engine/` ne référence `metadata`.

### 6.3 ProviderErrorSignal

```ts
interface ProviderErrorSignal {
  status?: number;
  headers: Record<string, string>;
  bodyText?: string;
  networkErrorKind?: "dns" | "connection" | "reset" | "unknown";
  timeout: boolean;
  aborted: boolean;
  providerCode?: string;
  providerMessage?: string;
}
```

**Règles** :
- Le classifier prend exactement ce signal en entrée, retourne une `LLMRuntimeError`.
- Le classifier est une fonction pure. Aucun effet de bord.
- L'engine construit ce signal avant de l'envoyer au classifier — jamais le binding ne classifie directement.
- `aborted` prime sur `timeout` (cf. priorité §13.2 du NX).
- Clés de `headers` en **lowercase** (I-13).

### 6.4 BindingConfig

```ts
interface BindingConfig {
  model: string;
  apiKey: string;
  endpoint?: string;
  providerOptions?: unknown;
}
```

Sous-ensemble de `AdapterConfig` restreint aux champs dont le binding a besoin pour construire la requête HTTP. Exclut les policies (retry, timeout, sanitization, integrity, logging) qui sont du ressort de l'engine. `providerOptions` est `unknown` dans cette interface normative — chaque binding l'affine en interne vers son propre type (ex. Anthropic y attend `{ extendedThinking?: { enabled, budgetTokens } }`).

Utilisé par les deux types de bindings (`ProviderBinding` et `EmbeddingBinding`).

### 6.5 ProviderBinding (completion)

```ts
interface ProviderBinding {
  provider: ProviderLongId;
  buildRequest(request: LLMRequest, config: BindingConfig): CanonicalHttpRequest;
  parseResponse(body: unknown, headers: Record<string, string>): ParsedProviderResponse;
  classifyError(signal: ProviderErrorSignal): LLMRuntimeError;
  readRateLimitHeaders(headers: Record<string, string>, nowMono: number, nowWall: Date): RateLimitSnapshot | null;
  terminationMap: Readonly<Record<string, TerminationReason>>;
  quirks: ProviderQuirks;
}

interface ProviderQuirks {
  defaultSanitization: Required<SanitizationPolicy>;
  hasRateLimitHeaders: boolean;
  mayRouteModel: boolean;
}
```

### 6.6 EmbeddingBinding

```ts
interface EmbeddingBinding {
  provider: ProviderLongId;
  buildRequest(texts: readonly string[], config: BindingConfig): CanonicalHttpRequest;
  parseEmbeddings(body: unknown, headers: Record<string, string>): number[][];
  classifyError(signal: ProviderErrorSignal): LLMRuntimeError;
  readRateLimitHeaders(headers: Record<string, string>, nowMono: number, nowWall: Date): RateLimitSnapshot | null;
  quirks: Pick<ProviderQuirks, "hasRateLimitHeaders">;
}
```

**Règle normative — séparation completion/embedding** : les deux interfaces sont distinctes par design. Un binding embedding n'a ni `terminationMap` (pas applicable aux vecteurs), ni `defaultSanitization` (embeddings jamais sanitizés), ni `mayRouteModel` (aliasing embeddings hors scope v1). Aucun champ mort.

### 6.7 Types de décisions matérialisées

```ts
type RetryDecision =
  | { readonly retry: false; readonly reason: RetryDecisionReason }
  | { readonly retry: true; readonly delayMs: number; readonly reason: RetryDecisionReason };

interface RateLimitSnapshot {
  remainingTokens: number;
  resetTokensAt: number;          // monotone ms
  lastCallOutputTokens: number;
  state: "known" | "partial" | "unknown";
}

type ThrottleDecision =
  | { readonly throttle: false; readonly reason: ThrottleDecisionReason }
  | { readonly throttle: true; readonly waitMs: number; readonly reason: ThrottleDecisionReason };
```

---

## 7. Règles de `LLMRequest` et `LLMResponse` (contrat)

### 7.1 Règles `LLMRequest`

- `messages` non vide. `messages: []` → `InvalidRequestError` levée par l'engine avant tout fetch.
- `messages` peut contenir 0 ou 1 `system` message (au début). Plusieurs system → `InvalidRequestError`.
- Les rôles restants alternent `user` et `assistant` ; le dernier message doit être `user` sauf pour assistant prefill (cas avancé géré au niveau binding).
- `temperature` et `maxTokens` overridden les defaults de la factory config si fournis.
- `stopSequences` passé au provider si supporté, sinon ignoré silencieusement par le binding.
- Si `signal.aborted === true` au moment de l'appel, throw `AbortedError` immédiat, pas de fetch.
- L'engine NE modifie JAMAIS l'objet request (I-11).

### 7.2 Garanties `LLMResponse`

- `content` et `rawContent` sont toujours des strings (jamais null/undefined). Chaîne vide possible.
- **Cas `content === ""` après sanitization** : résultat valide. Si `rawContent` est non vide mais `content === ""` après strip, le runtime retourne une `LLMResponse` valide avec `content: ""`, émet `llm_call_sanitized` (avec preview contrôlé), et laisse `integrity.truncationDetected = false`. Ce cas n'est jamais assimilé à une truncation silencieuse par le seul fait du vidage.
- `usage.X` est `undefined` si le provider n'expose pas la métrique. **Jamais 0 par invention.**
- `providerModel` est `undefined` si le provider ne retourne pas le modèle résolu dans la response body.
- `callId` est unique, généré mécaniquement au début de l'exécution.
- L'objet est auto-suffisant : peut être sérialisé seul, loggé seul, comparé seul sans contexte externe.

### 7.3 Règles `AdapterStats`

- Compteur passif mis à jour mécaniquement après chaque call **réussi uniquement**. Les calls qui throw n'incrémentent **aucun** compteur, pas même `totalCalls`.
- L'adapter ne prend **jamais** de décision basée sur `stats`. Pas de budget gate, pas de refus de call.
- Si `usage.inputTokens` ou `usage.outputTokens` est `undefined`, le compteur correspondant n'est pas incrémenté — jamais de 0 injecté.
- Compteurs process-local et liés à l'instance d'adapter (même scope que le throttle snapshot).
- Compteurs non réinitialisables. Un adapter = une durée de vie = un jeu de stats.
- Pour un `EmbeddingAdapter`, seuls `totalCalls` et `totalDurationMs` sont vivants ; `totalInputTokens` et `totalOutputTokens` restent à 0 (convention v1).

---

## 8. Observabilité — taxonomie fermée v1 (14 events)

### 8.1 Canal et format

- **Canal par défaut** : `stderr`
- **Format** : un objet JSON par ligne (NDJSON / JSONL)
- **Encodage** : UTF-8, fin de ligne LF
- **Logger injectable** via `LoggingPolicy.logger`
- **Désactivable** : `LoggingPolicy.enabled = false` → zéro émission

### 8.2 BaseEvent (champs communs)

```ts
interface BaseEvent {
  eventType: string;
  callId: string;
  provider: ProviderLongId;
  model: string;
  timestamp: string;         // ISO wall clock
  attempt?: number;
}

type LLMEvent =
  | LLMCallStartEvent
  | LLMCallAttemptStartEvent
  | LLMCallThrottledEvent
  | LLMCallRetryScheduledEvent
  | LLMCallFetchErrorEvent
  | LLMCallProviderErrorEvent
  | LLMCallParseErrorEvent
  | LLMCallSanitizedEvent
  | LLMCallUnknownErrorClassifiedEvent
  | LLMCallUnknownTerminationEvent
  | LLMCallEndEvent
  | LLMEmbeddingStartEvent
  | LLMEmbeddingBatchEvent
  | LLMEmbeddingEndEvent;
```

Union discriminée fermée par `eventType`. Chaque variante étend `BaseEvent` avec ses champs spécifiques. L'ajout d'un event = breaking change (major bump).

### 8.3 Liste des 14 events et champs spécifiques

| eventType | Quand | Champs spécifiques |
| --- | --- | --- |
| `llm_call_start` | Au début du call, une fois | `endpoint`, `messagesCount` |
| `llm_call_attempt_start` | Avant chaque fetch attempt | `attempt` |
| `llm_call_throttled` | Throttle proactif déclenche | `waitMs`, `reason`, `snapshotState`, `estimatedTokens` |
| `llm_call_retry_scheduled` | Après échec, avant sleep retry | `attempt`, `delayMs`, `reason`, `errorKind` |
| `llm_call_fetch_error` | Erreur réseau | `networkErrorKind`, `message` |
| `llm_call_provider_error` | Erreur HTTP non-2xx classifiée | `status`, `semanticErrorKind`, `retryable` |
| `llm_call_parse_error` | Échec `parseResponse` | `message` |
| `llm_call_sanitized` | Si sanitization a modifié le contenu | `thinkingTagsRemoved`, `jsonFenceRemoved`, `rawContentPreview?` |
| `llm_call_unknown_error_classified` | Erreur non classifiée reclassée en `transient_unknown` (warn) | `status`, `bodySnippet`, `networkErrorKind`, `rawMessage` |
| `llm_call_unknown_termination` | `terminationSignal` non mappé | `rawSignal` |
| `llm_call_end` | Fin du call (succès OU échec final) | `success`, `durationMs`, `attemptCount`, `termination?`, `usage?`, `providerModel?`, `errorKind?` |
| `llm_embedding_start` | Début du call embedding | `endpoint`, `textsCount`, `batchSize` |
| `llm_embedding_batch` | Après chaque batch réussi | `batchIndex`, `batchTextsCount`, `durationMs` |
| `llm_embedding_end` | Fin du call embedding (succès OU échec final) | `success`, `totalBatches`, `totalDurationMs`, `errorKind?` |

### 8.4 Discipline de `llm_call_end`

**Règle critique** : `llm_call_end` est le résumé terminal canonique. Ses champs sont figés. **Aucun champ de détail intermédiaire ne migre vers `llm_call_end`**.

Les détails intermédiaires (throttle waits, retry delays, fetch errors transients) vivent dans leurs events dédiés. L'agrégation est la responsabilité du consommateur (via `callId`).

Sans cette discipline, `llm_call_end` grossit sans contrôle et devient un sac fourre-tout. Testable : schéma de `llm_call_end` vérifié stable entre versions via test de shape.

### 8.5 Invariant de corrélation

Tout event d'un même call partage le même `callId`. Le consommateur peut regrouper par callId pour reconstruire la trace complète.

---

## 9. Modèle temporel

### 9.1 Deux horloges distinctes

**Horloge murale** (`new Date()` / `.toISOString()`) — utilisée pour :
- `LLMResponse.startedAt`
- `LLMResponse.endedAt`
- Tous les `timestamp` des événements de log

**Horloge monotone** (`performance.now()`) — utilisée pour :
- `LLMResponse.durationMs`
- Calcul des retry delays
- Calcul des throttle wait times
- Déclenchement des timeouts internes
- `snapshot.resetTokensAt` (stocké en ms monotone)

### 9.2 Règles normatives

- `durationMs` est **toujours ≥ 0**. Garanti par l'usage de l'horloge monotone.
- `startedAt` et `endedAt` peuvent paraître incohérents si l'horloge système jumpe pendant le call — c'est accepté. L'info de référence pour les durées reste `durationMs`.
- Les timeouts sont calculés en monotone (`startMono + timeoutMs`), pas en wall clock.
- Les events de log utilisent wall clock (lisibilité humaine), les calculs internes utilisent monotone.

### 9.3 Abstraction via module `clock`

```ts
export const clock = {
  nowWall: () => new Date(),
  nowWallIso: () => new Date().toISOString(),
  nowMono: () => performance.now(),
};
```

Pour les tests, ce module est mocké pour permettre des tests déterministes sur les durées.

---

## 10. Orchestration de haut niveau

### 10.1 Cycle de vie d'un adapter

```
Factory (ex. createAnthropicAdapter(config))
  │
  ├─ Valide config (champs obligatoires présents, policies cohérentes)
  ├─ Instancie binding (AnthropicBinding) avec ses quirks
  ├─ Instancie throttle-snapshot service (state local à l'adapter)
  ├─ Instancie stats (compteurs à 0)
  ├─ Fige la config (immutable via Object.freeze ou équivalent discipline)
  └─ Retourne un ProviderAdapter avec :
       provider: config.model mapping → "anthropic"
       model: config.model
       stats: (proxy sur le state interne, readonly)
       call(request) → executeCall(request, binding, config, stats, snapshotService, logger)
```

### 10.2 Flux d'un call completion (haut niveau)

Détaillé dans **NIB-M-EXECUTE-CALL**. Résumé :

```
executeCall(request, binding, config):
  1. Générer callId ULID
  2. Valider request (non vide, rôles cohérents)
  3. Charger snapshot throttle
  4. Pour attempt = 0..maxAttempts-1 :
     a. Checker abort
     b. Si attempt > 0 : resolveRetryDecision → sleep retry (ou throw si fatal/exhausted)
     c. resolveThrottleDecision → sleep throttle si nécessaire
     d. composeSignal (timeout interne + abort externe)
     e. binding.buildRequest → fetch
     f. Si erreur fetch : classifyError → continuer boucle
     g. Si status non-2xx : classifyError → continuer boucle (update snapshot sur 429/529)
     h. binding.parseResponse
     i. readRateLimitHeaders → persister snapshot
     j. Résoudre sanitization policy → appliquer sanitizer
     k. Détecter integrity (truncation)
     l. Mapper terminationSignal via binding.terminationMap
     m. Mismatch check si IntegrityPolicy l'exige
     n. Construire LLMResponse, update stats, log llm_call_end, return
  5. Si boucle épuisée : throw lastError enrichi (log llm_call_end success: false)
```

### 10.3 Flux d'un call embedding (haut niveau)

Détaillé dans **NIB-M-EXECUTE-EMBEDDING**. Résumé :

```
executeEmbedding(texts, binding, config, options):
  1. Si texts.length === 0 → return []
  2. Générer callId ULID
  3. Log llm_embedding_start
  4. Découper texts en batches de config.batchSize ?? 100
  5. Pour chaque batch :
     a. Même boucle retry/throttle qu'executeCall
     b. binding.buildRequest(batchTexts, bindingConfig) → fetch
     c. binding.parseEmbeddings → vecteurs
     d. Concat dans le résultat
     e. Log llm_embedding_batch
  6. Log llm_embedding_end, return number[][]
```

### 10.4 Dépendances externes v1

| Package | Version | Rôle | DC associé |
| --- | --- | --- | --- |
| `ai-json-safe-parse` | `^0.3.0` | Parsing défensif JSON LLM (fences, trailing commas, smart quotes, etc.) | **DC-AI-JSON-SAFE-PARSE** |
| `ulid` | `^2.x` | Génération callId (triable chronologiquement) | Pas de DC (API triviale `ulid() => string`) |

Tout le reste est écrit maison ou utilise l'API standard Node ≥ 20 natif :
- `fetch` natif (pas de `node-fetch`, `undici`, `axios`)
- `AbortSignal`, `AbortController`, `AbortSignal.timeout`, `AbortSignal.any` natifs
- `performance.now()` natif
- `crypto.randomUUID()` disponible mais non utilisé (ULID préféré)

**Règle normative** : toute nouvelle dépendance runtime requiert modification du NX et un nouveau NIB associé.

### 10.5 Target file tree (convention, hors scope NIB)

```
src/
├── index.ts                         # Exports publics
├── types/
│   ├── request-response.ts          # LLMRequest, LLMResponse, LLMMessage, etc.
│   ├── adapter.ts                   # ProviderAdapter, EmbeddingAdapter, AdapterStats
│   ├── config.ts                    # AdapterConfig, EmbeddingAdapterConfig, policies
│   ├── events.ts                    # LLMEvent union + 14 variantes
│   └── canonical.ts                 # CanonicalHttpRequest, ParsedProviderResponse, etc.
├── errors/
│   ├── base.ts                      # LLMRuntimeError abstract
│   ├── subclasses.ts                # 11 sous-classes concrètes
│   └── kind.ts                      # LLMErrorKind, isRetriableKind
├── services/
│   ├── retry-resolver.ts            # + parseRetryAfter inline
│   ├── throttle-resolver.ts
│   ├── throttle-snapshot.ts
│   ├── token-estimator.ts
│   ├── sanitizer.ts
│   ├── signal-composer.ts
│   ├── error-classifier-base.ts
│   ├── logger.ts
│   ├── callId-generator.ts
│   └── clock.ts
├── bindings/
│   ├── anthropic.ts
│   ├── openai.ts
│   ├── openai-compatible.ts
│   ├── google.ts
│   └── openai-embeddings.ts
├── engine/
│   ├── execute-call.ts
│   └── execute-embedding.ts
└── factories/
    ├── create-anthropic-adapter.ts
    ├── create-openai-adapter.ts
    ├── create-openai-compatible-adapter.ts
    ├── create-google-adapter.ts
    ├── create-openai-embedding-adapter.ts
    └── build-simple-prompt.ts
```

Cette structure est une **convention dérivée** du NIB-S. Elle est maintenue après construction (contrairement aux NIBs) : divergence immédiatement visible par comparaison avec l'arborescence réelle. Les tests correspondants suivent la structure miroir dans `tests/` (voir NIB-T §1.1).

---

## 11. Cross-cutting policies (résumées)

| Policy | Scope | NIB-M owner |
| --- | --- | --- |
| **P-IMMUT** : `LLMRequest` jamais modifié | Engine + tous | NIB-M-EXECUTE-CALL |
| **P-LOWERCASE-HEADERS** : clés headers toujours lowercase | Engine + bindings | NIB-M-EXECUTE-CALL (conversion au step 7.i) |
| **P-NO-PII** : pas de prompts/réponses dans logs | Logger + tous les émetteurs | NIB-M-INFRA-UTILS + tout consommateur du logger |
| **P-SEM-THROW** : toute erreur remontée = `LLMRuntimeError` (pas de `DOMException`, pas d'`Error` brut) | Engine + classifier + sleep | NIB-M-EXECUTE-CALL + NIB-M-SIGNAL-COMPOSER |
| **P-ENRICH** : erreurs enrichies (callId, provider, model, attempts) au throw par l'engine | Engine | NIB-M-EXECUTE-CALL |
| **P-DETERMINISTIC-DECISIONS** : retry/throttle/termination sont des fonctions pures | Services L4 | NIB-M-RETRY-RESOLVER, NIB-M-THROTTLE |
| **P-FAIL-CLOSED** : pas de fallback silencieux | Partout | Tous NIB-M |
| **P-METADATA-OPAQUE** : `ParsedProviderResponse.metadata` jamais lue par l'engine | Engine | NIB-M-EXECUTE-CALL (test automatisé d'enforcement) |

Les NIB-M renvoient à ces policies sans les redéfinir.

---

## 12. Critères de complétude du NIB-S

Le NIB-S est considéré complet si :

1. **Frontière v1 déclarée** : §2 établit ce qui est et n'est pas couvert (enforcement : checklist §2.2).
2. **Invariants transversaux listés** : §3 énumère les 13 invariants (I-1 à I-13) que tous les NIB-M doivent respecter.
3. **Liste exhaustive des modules** : §4.2 mappe chaque module à son NIB-M d'owner. Aucun module orphelin.
4. **Types publics figés** : §5 définit la surface publique complète. Tout type non listé est interne.
5. **Formes canoniques figées** : §6 définit les contrats inter-layers. Pas de forme canonique ajoutée par un NIB-M.
6. **Observabilité figée** : §8 liste les 14 events. Aucun NIB-M ne peut ajouter un event (breaking change).
7. **Policies cross-cutting listées** : §11 liste les policies transversales avec leurs NIB-M owners.
8. **Orchestration de haut niveau** : §10 décrit le flux général. Les NIB-M remplissent le détail.

---

## 13. Référence au NIB-T

Le NIB-T (`NIB-T-LLMRUNTIME v1.0`) est déjà rédigé. Il couvre :

- Les fonctions pures des services L4 (retry-resolver, throttle-resolver, parseRetryAfter, token-estimator, isRetriableKind, sanitizer, signal-composer, error-classifier-base)
- Les 5 bindings (anthropic, openai, openai-compatible, google, openai-embeddings)
- L'engine via adapters publics (`executeCall`, `executeEmbedding`) avec mocks `fetch` + `clock`
- La taxonomie d'erreurs (11 sous-classes + enrichissement)
- L'observabilité (14 events, corrélation callId, PII absence)
- Le modèle temporel (wall/monotone, clock jump resistance)
- Les signaux (priorité externe, propagation abort, timer ownership)

Chaque NIB-M doit avoir ses vecteurs de test correspondants dans le NIB-T. Le mapping est donné par trigramme (ex. `RR` → retry-resolver → NIB-M-RETRY-RESOLVER, `EC` → execute-call → NIB-M-EXECUTE-CALL).

**Cohérence inter-NIB** : un test qui échoue sur une implémentation fidèle d'un NIB-M révèle une incohérence entre NIB-M et NIB-T. L'architecte est responsable de la résolution.

---

*VegaCorp — Implicit-Free Execution (IFE) — "La fiabilité précède l'intelligence."*
