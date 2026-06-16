---
id: NIB-M-ERRORS
type: nib-module
version: "1.0.0"
scope: llm-runtime
module: errors
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-M-ERRORS — Module Brief — Taxonomie d'erreurs sémantiques

**Package** : `@vegacorp/llm-runtime`
**Source NX** : §8 (Taxonomie d'erreurs sémantiques)
**NIB-T associé** : §21 (Contract invariants — taxonomie d'erreurs)

---

## 1. Purpose

Ce module définit l'intégralité de la taxonomie d'erreurs exportée publiquement par `@vegacorp/llm-runtime`. Il matérialise le contrat stable que les consommateurs utilisent pour discriminer et traiter les échecs d'appels LLM (`instanceof RateLimitError`, `error.kind === "rate_limit"`, `isRetriableKind(error.kind)`).

La taxonomie est fermée (11 sous-classes concrètes + 1 classe abstraite parente) et chaque sous-classe correspond à une situation d'échec distincte avec une politique de retry claire (voir NIB-M-RETRY-RESOLVER).

Toutes les erreurs remontées par le runtime héritent de la classe abstraite `LLMRuntimeError`. Aucune erreur non-`LLMRuntimeError` (ex. `DOMException` brut d'abort, `TypeError` de fetch) ne remonte au consommateur — l'engine les reclasse via le classifier (voir NIB-M-ERROR-CLASSIFIER-BASE).

---

## 2. Inputs / Outputs

### 2.1 Consommé par ce module

- Types primitifs et types publics du NIB-S : `ProviderLongId`, `LLMErrorKind` (défini dans NIB-M-ERROR-KIND).
- La classe `Error` native de JavaScript (hérite via `extends`).

### 2.2 Produit par ce module (exporté publiquement)

- **Classe abstraite** : `LLMRuntimeError` (exportée pour `instanceof` idiomatique).
- **11 sous-classes concrètes** : `AuthError`, `InvalidRequestError`, `RateLimitError`, `OverloadedError`, `TransientProviderError`, `ProviderProtocolError`, `ResponseParseError`, `TimeoutError`, `AbortedError`, `SilentTruncationError`, `ContentFilterError`.

Ces classes sont consommées par :
- **NIB-M-ERROR-CLASSIFIER-BASE** : construit et retourne ces erreurs depuis un `ProviderErrorSignal`.
- **NIB-M-RETRY-RESOLVER** : discrimine via `instanceof` ou `error.kind` pour la décision retry.
- **NIB-M-EXECUTE-CALL** / **NIB-M-EXECUTE-EMBEDDING** : enrichit ces erreurs avec `(callId, provider, model, attempts)` avant throw.
- **NIB-M-BINDINGS-COMPLETION** / **NIB-M-BINDING-EMBEDDING** : override du classifier par défaut peut produire directement la bonne sous-classe.
- Le consommateur final : discrimine via `instanceof` ou `error.kind`.

---

## 3. Algorithme / contrats détaillés

### 3.1 Classe abstraite `LLMRuntimeError`

```ts
abstract class LLMRuntimeError extends Error {
  abstract readonly kind: LLMErrorKind;
  readonly provider?: ProviderLongId;
  readonly model?: string;
  readonly callId?: string;
  readonly attempts?: number;

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      provider?: ProviderLongId;
      model?: string;
      callId?: string;
      attempts?: number;
    }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.provider = options?.provider;
    this.model = options?.model;
    this.callId = options?.callId;
    this.attempts = options?.attempts;
  }
}
```

**Contraintes normatives** :
- `LLMRuntimeError` est **abstract** — ne peut pas être instanciée directement. Seules les 11 sous-classes concrètes peuvent être construites.
- `kind` est **abstract readonly** — chaque sous-classe concrète le fixe à sa valeur d'union (ex. `readonly kind = "rate_limit" as const`).
- `provider`, `model`, `callId`, `attempts` sont **readonly** et **optionnels**. Ils sont remplis au moment du throw par l'engine (voir NIB-M-EXECUTE-CALL step 7.b, 7.a, 5, 8 — enrichissement par écrasement systématique).
- `cause` utilise le mécanisme standard ES2022 (`Error.prototype.cause`) — préservé pour traçabilité (ex. erreur native fetch enveloppée).
- `name` est fixé à `this.constructor.name` pour que `error.name === "RateLimitError"` soit toujours vrai (facilite le logging).

**Test contractuel C-ER-01** : `new AnyConcreteSubclass("msg") instanceof LLMRuntimeError === true`.
**Test contractuel C-ER-02** : tentative d'instancier `LLMRuntimeError` directement doit throw ou être rejetée par TypeScript (abstract). Enforcement par TS compile-time + runtime (si pertinent).

### 3.2 Les 11 sous-classes concrètes

Chaque sous-classe suit le même patron : `class X extends LLMRuntimeError { readonly kind = "..." as const; [champs spécifiques optionnels] }`.

#### 3.2.1 `AuthError` (kind: "auth")

```ts
class AuthError extends LLMRuntimeError {
  readonly kind = "auth" as const;
}
```

**Situation** : 401, 403, clé API invalide, quota compte épuisé.
**Retriable** : Non (fatal).
**Champs spécifiques** : aucun.

#### 3.2.2 `InvalidRequestError` (kind: "invalid_request")

```ts
class InvalidRequestError extends LLMRuntimeError {
  readonly kind = "invalid_request" as const;
}
```

**Situation** : 400, payload malformé, modèle inexistant (404), prompt trop long, `messages` vide, plusieurs system messages, rôles incohérents.
**Retriable** : Non (fatal).
**Champs spécifiques** : aucun.

#### 3.2.3 `RateLimitError` (kind: "rate_limit")

```ts
class RateLimitError extends LLMRuntimeError {
  readonly kind = "rate_limit" as const;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      provider?: ProviderLongId;
      model?: string;
      callId?: string;
      attempts?: number;
      retryAfterMs?: number;
    }
  ) {
    super(message, options);
    this.retryAfterMs = options?.retryAfterMs;
  }
}
```

**Situation** : 429 épuisé après retries.
**Retriable** : éligible au retry par nature (`isRetriableKind("rate_limit") === true`). Propagée au consommateur uniquement après épuisement du budget `maxAttempts`.
**Champs spécifiques** : `retryAfterMs?: number` — la valeur parsée du header `Retry-After` à l'attempt final (si disponible), en millisecondes. Utile au consommateur pour décider d'un backoff applicatif.

#### 3.2.4 `OverloadedError` (kind: "overloaded")

```ts
class OverloadedError extends LLMRuntimeError {
  readonly kind = "overloaded" as const;
  readonly retryAfterMs?: number;

  constructor(message: string, options?: { /* idem RateLimitError */ }) {
    super(message, options);
    this.retryAfterMs = options?.retryAfterMs;
  }
}
```

**Situation** : 529 (Anthropic "overloaded") épuisé après retries.
**Retriable** : éligible au retry (`isRetriableKind("overloaded") === true`).
**Champs spécifiques** : `retryAfterMs?: number` — même sémantique que `RateLimitError`.

#### 3.2.5 `TransientProviderError` (kind: "transient_provider")

```ts
class TransientProviderError extends LLMRuntimeError {
  readonly kind = "transient_provider" as const;
  readonly status?: number;
  readonly networkErrorKind?: "dns" | "connection" | "reset" | "unknown";

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      provider?: ProviderLongId;
      model?: string;
      callId?: string;
      attempts?: number;
      status?: number;
      networkErrorKind?: "dns" | "connection" | "reset" | "unknown";
    }
  ) {
    super(message, options);
    this.status = options?.status;
    this.networkErrorKind = options?.networkErrorKind;
  }
}
```

**Situation** : 500/502/503 épuisé, erreur réseau transitoire épuisée (DNS, connection reset, etc.).
**Retriable** : éligible au retry (`isRetriableKind("transient_provider") === true`).
**Champs spécifiques** :
- `status?: number` — status HTTP si erreur HTTP (undefined si erreur réseau pure).
- `networkErrorKind?: ...` — catégorie d'erreur réseau si erreur de transport (undefined si erreur HTTP pure).

#### 3.2.6 `ProviderProtocolError` (kind: "provider_protocol")

```ts
class ProviderProtocolError extends LLMRuntimeError {
  readonly kind = "provider_protocol" as const;
}
```

**Situation** : réponse provider non conforme au protocole attendu. Exemples : `terminationSignal` non mappé ET `IntegrityPolicy.failOnUnknownTermination === true` ; model mismatch avec `failOnModelMismatch === true` ; signal d'erreur incohérent (règle défensive §8.3 (5) du NX).
**Retriable** : Non (fatal). Signale un bug ou une régression provider non gérée.
**Champs spécifiques** : aucun.

#### 3.2.7 `ResponseParseError` (kind: "response_parse")

```ts
class ResponseParseError extends LLMRuntimeError {
  readonly kind = "response_parse" as const;
}
```

**Situation** : impossible de parser la réponse HTTP (JSON malformé, champ requis absent dans `parseResponse`).
**Retriable** : Non (fatal). Signale soit un bug de binding, soit une réponse provider corrompue.
**Champs spécifiques** : aucun.

#### 3.2.8 `TimeoutError` (kind: "timeout")

```ts
class TimeoutError extends LLMRuntimeError {
  readonly kind = "timeout" as const;
  readonly timeoutMs: number;

  constructor(
    message: string,
    options: {
      cause?: unknown;
      provider?: ProviderLongId;
      model?: string;
      callId?: string;
      attempts?: number;
      timeoutMs: number;
    }
  ) {
    super(message, options);
    this.timeoutMs = options.timeoutMs;
  }
}
```

**Situation** : timeout interne déclenché (`AbortSignal.timeout(config.timeout.perAttemptMs)`).
**Retriable** : éligible au retry (`isRetriableKind("timeout") === true`).
**Champs spécifiques** : `timeoutMs: number` — **obligatoire** (pas optionnel). Valeur du timeout qui a déclenché, pour debug et pour permettre au consommateur de raisonner sur la config.

**Note discriminante** : `TimeoutError` n'utilise **jamais** le header `Retry-After` pour calculer son retry delay (voir NIB-M-RETRY-RESOLVER T-RR-18). Le header `Retry-After` est sémantique de "le serveur te dit quand retry" ; un timeout est un problème côté client, l'attente doit suivre le backoff exponentiel standard.

#### 3.2.9 `AbortedError` (kind: "aborted")

```ts
class AbortedError extends LLMRuntimeError {
  readonly kind = "aborted" as const;
}
```

**Situation** : signal externe `AbortSignal.aborted === true` (soit au début de l'appel, soit pendant un fetch, soit pendant un sleep de retry/throttle).
**Retriable** : Non (volontaire — l'utilisateur a abort, on respecte).
**Champs spécifiques** : aucun.

**Règle normative importante** : tout reject d'un `abortableSleep` par abort externe est reclassé par l'engine en `AbortedError` enrichie, `cause` préservé pour traçabilité. Aucun `DOMException` brut ne remonte du runtime (voir NIB-M-SIGNAL-COMPOSER et NIB-M-EXECUTE-CALL steps 7.b/7.d).

#### 3.2.10 `SilentTruncationError` (kind: "silent_truncation")

```ts
class SilentTruncationError extends LLMRuntimeError {
  readonly kind = "silent_truncation" as const;
  readonly truncationMode: "heuristic_json_unclosed" | "silent_prompt_truncation";

  constructor(
    message: string,
    options: {
      cause?: unknown;
      provider?: ProviderLongId;
      model?: string;
      callId?: string;
      attempts?: number;
      truncationMode: "heuristic_json_unclosed" | "silent_prompt_truncation";
    }
  ) {
    super(message, options);
    this.truncationMode = options.truncationMode;
  }
}
```

**Situation** : truncation silencieuse détectée par heuristique (`IntegrityPolicy.detectHeuristicTruncation === true`) ET policy stricte active (`IntegrityPolicy.failOnSilentTruncation === true`).
**Retriable** : Non (fatal — signale un problème de taille de prompt / maxTokens que retry n'aiderait pas).
**Champs spécifiques** : `truncationMode: ...` — obligatoire. Deux modes en v1 :
- `"heuristic_json_unclosed"` : JSON détecté incomplet par le sanitizer (accolades/crochets non fermés).
- `"silent_prompt_truncation"` : ratio `prompt_tokens < sentChars / 8` suspect (héritage de la détection de md-structural-normalizer).

**Note** : le mode `"explicit_max_tokens"` (voir `LLMIntegrityInfo.truncationMode` du NIB-S §5.1) n'est **pas** une erreur — c'est une information sur le flag `LLMResponse.integrity.truncationDetected` quand le provider a explicitement signalé `finish_reason: "max_tokens"`. Il ne déclenche jamais de `SilentTruncationError`.

#### 3.2.11 `ContentFilterError` (kind: "content_filter")

```ts
class ContentFilterError extends LLMRuntimeError {
  readonly kind = "content_filter" as const;
  readonly reason?: string;
}
```

**Situation** : safety block explicite par le provider (Gemini `SAFETY`, Anthropic refusal, OpenAI `content_filter` finish_reason avec réponse vide).
**Retriable** : Non (fatal — pas de retry automatique sur refus de politique, le consommateur doit adapter son prompt).
**Champs spécifiques** : `reason?: string` — chaîne libre décrivant la catégorie du block si le provider la fournit (ex. `"SAFETY"`, `"RECITATION"`).

---

### 3.3 Patron d'enrichissement au throw

Chaque erreur est **enrichie par l'engine** au moment du throw avec le contexte d'exécution. Cette règle est **normative** :

```ts
// Au step 7.b de NIB-M-EXECUTE-CALL (retry fatal décidé), step 7.a (abort initial), step 5 (validation), step 8 (budget épuisé) :
throw new RateLimitError(originalError.message, {
  cause: originalError.cause,
  provider: bindingConfig.provider,         // écrase systématiquement
  model: bindingConfig.model,               // écrase systématiquement
  callId: callId,                           // écrase systématiquement
  attempts: attempt + 1,                    // ou attempt, selon le step (voir §14.1 NX)
  retryAfterMs: originalError.retryAfterMs  // préservé si présent
});
```

**Règle d'écrasement** : l'engine écrase **systématiquement** les champs `provider`, `model`, `callId`, `attempts` même s'ils sont déjà présents dans l'erreur d'origine (construite par `binding.classifyError` ou par l'error-classifier-base). Rationale : l'engine connaît toujours mieux le contexte d'exécution que le binding (voir §14.1 step 7.b du NX).

**Règle de préservation** : les champs spécifiques à la sous-classe (`retryAfterMs`, `status`, `networkErrorKind`, `timeoutMs`, `truncationMode`, `reason`) sont **préservés** depuis l'erreur d'origine — l'engine ne les recalcule pas. Seul le classifier a cette information.

---

## 4. Exemples

### 4.1 Instanciation et vérification `instanceof`

```ts
const e = new RateLimitError("429 from Anthropic", {
  provider: "anthropic",
  model: "claude-opus-4-6-20260301",
  callId: "01J9ZT5H3...",
  attempts: 5,
  retryAfterMs: 10000
});

// Vérifications attendues :
e instanceof RateLimitError;   // true
e instanceof LLMRuntimeError;  // true
e instanceof Error;            // true
e.kind === "rate_limit";       // true
e.name === "RateLimitError";   // true
e.retryAfterMs === 10000;      // true
e.provider === "anthropic";    // true
e.attempts === 5;              // true
e.message === "429 from Anthropic"; // true
```

### 4.2 Préservation de `cause`

```ts
const netErr = new TypeError("fetch failed: ECONNRESET");
const e = new TransientProviderError("Network reset", {
  cause: netErr,
  provider: "openai",
  networkErrorKind: "reset"
});

e.cause === netErr;            // true (ES2022 standard)
e.networkErrorKind === "reset"; // true
```

### 4.3 Discrimination par le consommateur

```ts
try {
  const resp = await adapter.call({ messages: [...] });
} catch (err) {
  if (err instanceof RateLimitError) {
    // attendre err.retryAfterMs avant de retry applicatif
  } else if (err instanceof AuthError) {
    // fatal — alerter l'opérateur
  } else if (err instanceof TimeoutError) {
    // informer l'utilisateur, proposer un prompt plus court
  } else if (err instanceof LLMRuntimeError) {
    // autre erreur runtime typée
  } else {
    // théoriquement impossible : le runtime ne remonte que des LLMRuntimeError
    throw err; // par prudence
  }
}
```

### 4.4 Discrimination par `kind` (usage logging/sérialisation)

```ts
function logError(e: LLMRuntimeError) {
  const entry = {
    kind: e.kind,
    provider: e.provider,
    callId: e.callId,
    retriable: isRetriableKind(e.kind),  // voir NIB-M-ERROR-KIND
    message: e.message
  };
  console.error(JSON.stringify(entry));
}
```

### 4.5 Patron d'enrichissement dans l'engine

```ts
// Extrait conceptuel du flow executeCall, step 7.b (voir NIB-M-EXECUTE-CALL) :
const retryDecision = resolveRetryDecision(lastError, attempt, lastHeaders, config.retry);
if (retryDecision.retry === false) {
  // Enrichissement par écrasement systématique :
  const ctor = lastError.constructor as new (msg: string, opts?: any) => LLMRuntimeError;
  // Note : on ne peut pas muter lastError (readonly fields) — on reconstruit via le bon constructor.
  // Alternative idiomatique : helper enrichError(lastError, context) qui clone avec les champs écrasés.
  throw enrichError(lastError, {
    provider: bindingConfig.provider,
    model: bindingConfig.model,
    callId,
    attempts: attempt
  });
}
```

**Note d'implémentation** : le helper `enrichError` (non exporté) est une fonction utilitaire interne dont l'algorithme est décrit dans NIB-M-EXECUTE-CALL. Il n'appartient pas à ce module — ce NIB-M définit uniquement les types.

---

## 5. Edge cases

| Cas | Comportement attendu | Test |
| --- | --- | --- |
| Instanciation directe de `LLMRuntimeError` | Rejetée par TS (abstract class). Runtime : accepté par JS mais `kind` sera `undefined` → test contractuel doit vérifier qu'aucun code de production n'instancie directement. | C-ER-02 |
| `cause` non fourni | `error.cause === undefined` (pas d'erreur, comportement natif ES2022). | — |
| `cause: undefined` explicite passé | Identique à "non fourni" (la surcharge du constructor ne passe pas l'option à `super` si cause undefined). | — |
| `retryAfterMs: 0` | Valide, préservé tel quel (ne pas le transformer en undefined). Un delay de 0ms est différent de "header absent". | — |
| `attempts: 0` | Valide (ex. erreur au step 5 de validation, avant toute tentative de fetch). | — |
| Erreur enrichie deux fois | L'écrasement est systématique : les nouveaux champs remplacent les anciens. Pas de "si déjà setté, préserver" (voir §14.1 step 7.b du NX). | C-ER-04 |
| Sérialisation JSON d'une `LLMRuntimeError` | Par défaut, `JSON.stringify(error)` ne sérialise **pas** `message` ni `name` (comportement natif Error). Consommateur doit utiliser un custom `toJSON` ou un replacer. **Ce NIB-M ne fournit pas de `toJSON` — si le besoin émerge, ajout en minor bump.** | — |
| Propagation hors process (IPC, worker) | Les erreurs ne sont **pas** structurellement sérialisables par `structuredClone` par défaut. Cross-process = responsabilité du consommateur. Hors scope v1. | — |

---

## 6. Constraints (invariants spécifiques)

### C-M1 — Fermeture de la taxonomie

La liste des 11 sous-classes est **fermée** en v1. Ajouter une sous-classe = breaking change (modifie la surface publique + potentiellement `LLMErrorKind`) = major bump + mise à jour coordonnée de NIB-M-ERROR-KIND.

### C-M2 — `kind` est figé par sous-classe

Chaque sous-classe fixe son `kind` à une valeur de l'union `LLMErrorKind` via `readonly kind = "..." as const`. Le `as const` est normatif — il garantit le narrowing TypeScript et empêche la réassignation.

### C-M3 — `LLMRuntimeError` est abstract

L'instanciation directe de `LLMRuntimeError` est interdite. Enforcement par TypeScript (`abstract class`) + revue manuelle.

### C-M4 — Champs contextuels sont readonly

`provider`, `model`, `callId`, `attempts` sont déclarés `readonly`. L'enrichissement par l'engine passe par la reconstruction (pas la mutation) — voir NIB-M-EXECUTE-CALL.

### C-M5 — Pas de champ `retryable` dans l'erreur

La propriété "cette erreur est retriable ?" n'est **pas** portée par l'erreur elle-même. Elle est calculée via `isRetriableKind(error.kind)` (voir NIB-M-ERROR-KIND). Rationale : `isRetriableKind` exprime une **éligibilité statique par famille**, pas une décision contextuelle. La décision contextuelle (va-t-on effectivement retry maintenant ?) est portée par `RetryDecision` issue de `resolveRetryDecision`.

### C-M6 — Pas de messages hardcodés

Les classes ne portent pas de messages par défaut. Le message est toujours fourni par l'appelant (classifier ou engine). Rationale : les messages dépendent du contexte (provider, status, body snippet, etc.).

### C-M7 — Cohérence avec `LLMErrorKind`

L'union `LLMErrorKind` (définie dans NIB-M-ERROR-KIND) doit contenir exactement les 11 valeurs correspondant aux 11 sous-classes. Une discordance = incohérence inter-NIB à corriger.

---

## 7. Integration (comment les autres modules consomment ce module)

### 7.1 Depuis le classifier de base

```ts
// NIB-M-ERROR-CLASSIFIER-BASE :
import { AuthError, RateLimitError, TransientProviderError, /* ... */ } from "./errors";

export function classifyErrorBase(signal: ProviderErrorSignal): LLMRuntimeError {
  if (signal.aborted) return new AbortedError("Aborted by external signal");
  if (signal.timeout) return new TimeoutError("Internal timeout", { timeoutMs: /* read from context */ });
  // etc.
}
```

### 7.2 Depuis un binding (override)

```ts
// NIB-M-BINDINGS-COMPLETION (extrait Anthropic) :
import { OverloadedError, RateLimitError } from "../errors";

function classifyError(signal: ProviderErrorSignal): LLMRuntimeError {
  if (signal.status === 529) {
    return new OverloadedError("Anthropic overloaded", {
      retryAfterMs: parseRetryAfter(signal.headers)
    });
  }
  // fallback to base classifier for other cases
  return classifyErrorBase(signal);
}
```

### 7.3 Depuis l'engine (enrichissement)

```ts
// NIB-M-EXECUTE-CALL step 7.b / 7.a / 5 / 8 :
throw enrichError(lastError, { provider, model, callId, attempts });
```

### 7.4 Depuis le consommateur final

```ts
import { RateLimitError, AuthError, TimeoutError, LLMRuntimeError } from "@vegacorp/llm-runtime";

try {
  const resp = await adapter.call(request);
} catch (err) {
  if (err instanceof RateLimitError) { /* ... */ }
  // etc.
}
```

---

## 8. Relationship avec les autres NIB-M

| NIB-M | Relation |
| --- | --- |
| **NIB-M-ERROR-KIND** | Définit `LLMErrorKind` et `isRetriableKind`. Doit être cohérent avec les 11 `kind` des sous-classes. |
| **NIB-M-ERROR-CLASSIFIER-BASE** | Consomme ces classes pour construire une `LLMRuntimeError` depuis un `ProviderErrorSignal`. |
| **NIB-M-RETRY-RESOLVER** | Discrimine via `instanceof` ou `error.kind` pour produire `RetryDecision`. |
| **NIB-M-SIGNAL-COMPOSER** | Produit des rejects reclassés en `AbortedError` par l'engine (règle P-SEM-THROW du NIB-S). |
| **NIB-M-BINDINGS-COMPLETION** / **NIB-M-BINDING-EMBEDDING** | Peuvent produire directement une sous-classe via override de classifier (ex. Anthropic 529 → `OverloadedError`). |
| **NIB-M-EXECUTE-CALL** / **NIB-M-EXECUTE-EMBEDDING** | Enrichit les erreurs par écrasement systématique avant throw. |

---

## 9. Tests de référence (NIB-T §21)

| Zone | ID tests NIB-T |
| --- | --- |
| Instanciation et `instanceof` de chaque sous-classe | `C-ER-01`, `C-ER-02`, `C-ER-03` (approximatif) |
| Préservation de `cause` ES2022 | `C-ER-XX` |
| Enrichissement par écrasement | `C-ER-04` |
| `name === constructor.name` | `C-ER-XX` |
| Union `LLMErrorKind` correspond exactement aux 11 `kind` | `C-ER-XX` (cohérence avec NIB-M-ERROR-KIND) |

(Les IDs exacts sont dans le NIB-T §21 — préfixe `C-ER-`.)

---

*VegaCorp — Implicit-Free Execution (IFE) — "La fiabilité précède l'intelligence."*
