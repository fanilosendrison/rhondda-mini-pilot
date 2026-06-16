---
id: NIB-M-ERROR-CLASSIFIER-BASE
type: nib-module
version: "1.0.0"
scope: llm-runtime
module: error-classifier-base
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-M-ERROR-CLASSIFIER-BASE — Module Brief — Classifier HTTP générique

**Package** : `@vegacorp/llm-runtime`
**Source NX** : §5.5 (error-classifier-base), §8.3 (mapping HTTP → erreur), §8.4 (override par binding)
**NIB-T associé** : §9 (error-classifier-base)

---

## 1. Purpose

Ce module fournit un **classifier HTTP → erreur sémantique générique**, appelé `classifyErrorBase(signal: ProviderErrorSignal): LLMRuntimeError`, utilisé comme **fallback commun** par les bindings qui n'ont pas besoin de logique provider-spécifique pour certains cas.

**Principe IFE-aligné** : un status HTTP donné (ex. 401) doit toujours produire la même famille d'erreur (ex. `AuthError`) à travers tous les providers, sauf override explicite par un binding. Cette règle garantit :

- **Cohérence inter-provider** : un 401 est toujours un `AuthError`, peu importe que l'API soit Anthropic, OpenAI, ou autre.
- **Testabilité** : un test contractuel vérifie `classifyErrorBase({ status: 401, ... })` → `AuthError`.
- **Override contrôlé** : chaque binding peut override le classifier pour des status qui ont une sémantique différente chez lui (ex. 529 est spécifique à Anthropic → `OverloadedError`).

Le classifier est **pur** : étant donné un `ProviderErrorSignal`, il retourne toujours la même `LLMRuntimeError`. Pas de log, pas d'accès réseau, pas de clock. **Pas d'enrichissement contextuel** (`callId`, `provider`, `model`, `attempts`) — cet enrichissement est fait par l'engine au moment du throw (§3.3 de NIB-M-ERRORS).

---

## 2. Inputs / Outputs

### 2.1 Consommé par ce module

- Type `ProviderErrorSignal` (forme canonique §6.3 NIB-S).
- 11 sous-classes de `LLMRuntimeError` (NIB-M-ERRORS).
- `parseRetryAfter` (NIB-M-RETRY-RESOLVER §3) — pour extraire `retryAfterMs` des erreurs 429/529/503.

### 2.2 Produit par ce module

**Interne (non exporté publiquement)** :

```ts
function classifyErrorBase(signal: ProviderErrorSignal): LLMRuntimeError;
```

### 2.3 Consommateurs

- **NIB-M-BINDINGS-COMPLETION** : chaque binding (Anthropic, OpenAI, etc.) implémente sa méthode `classifyError` qui typiquement :
  1. Gère d'abord les cas provider-spécifiques (ex. Anthropic 529).
  2. Pour tous les autres cas, délègue à `classifyErrorBase(signal)`.
- **NIB-M-BINDING-EMBEDDING** : idem.
- **NIB-M-EXECUTE-CALL** / **NIB-M-EXECUTE-EMBEDDING** : n'appellent **pas** directement ce module — ils appellent `binding.classifyError(signal)`. Le binding décide ensuite d'éventuellement déléguer à `classifyErrorBase`.

---

## 3. Algorithme

### 3.1 Signature

```ts
function classifyErrorBase(signal: ProviderErrorSignal): LLMRuntimeError;
```

**Entrée** : `ProviderErrorSignal` (voir NIB-S §6.3) avec les champs suivants :
- `status?: number` — status HTTP (absent si erreur réseau pure ou abort).
- `headers: Record<string, string>` — headers HTTP (clés lowercase, I-13).
- `bodyText?: string` — corps de réponse brut (utile pour diagnostic, pas pour classifier).
- `networkErrorKind?: "dns" | "connection" | "reset" | "unknown"` — catégorie d'erreur réseau.
- `timeout: boolean` — true si le composedSignal a déclenché par timeout interne.
- `aborted: boolean` — true si `externalSignal.aborted` était true.
- `providerCode?: string`, `providerMessage?: string` — opaques, hints (non utilisés v1).

**Sortie** : une `LLMRuntimeError` (sous-classe spécifique) — non enrichie avec le contexte call-level.

### 3.2 Table de classification (priorité descendante)

Appliquée dans l'ordre — **premier match gagne**.

| Condition | Classe retournée | `message` suggéré | Champs extras | Source NX |
| --- | --- | --- | --- | --- |
| `signal.aborted === true` | `AbortedError` | `"Aborted by external signal"` | — | §13.2 |
| `signal.timeout === true` | `TimeoutError` | `"Internal timeout"` | `timeoutMs`: non connu ici → propagé via `cause` ou convention (voir R-3) | §13.2 |
| `signal.networkErrorKind !== undefined` | `TransientProviderError` | `"Network error: <kind>"` | `networkErrorKind` | §8.3 |
| `signal.status === 401 || signal.status === 403` | `AuthError` | `"Auth error: <status>"` | — | §8.3 |
| `signal.status === 400 || signal.status === 404` | `InvalidRequestError` | `"Invalid request: <status>"` | — | §8.3 |
| `signal.status === 429` | `RateLimitError` | `"Rate limit: 429"` | `retryAfterMs` via `parseRetryAfter` | §8.3 |
| `signal.status === 529` | `OverloadedError` | `"Overloaded: 529"` | `retryAfterMs` via `parseRetryAfter` | §8.3 (spécifique Anthropic — override base par binding possible) |
| `signal.status === 500 || signal.status === 502 || signal.status === 503` | `TransientProviderError` | `"Transient provider: <status>"` | `status`, `retryAfterMs` (via parseRetryAfter si 503) | §8.3 |
| `signal.status` autre (5xx non standard, 3xx, etc.) | `TransientProviderError` conservateur | `"Unexpected status: <status>"` | `status` | §8.3 (catch-all) |
| `signal.status === undefined` && réseau non identifié | `TransientProviderError` | `"Unknown error"` | `networkErrorKind: "unknown"` | §8.3 |

### 3.3 Pseudocode

```ts
function classifyErrorBase(signal: ProviderErrorSignal): LLMRuntimeError {
  // 1. Abort externe prime (cohérent avec §13.2 NX)
  if (signal.aborted) {
    return new AbortedError("Aborted by external signal");
  }

  // 2. Timeout interne
  if (signal.timeout) {
    // timeoutMs n'est pas connu à ce niveau. L'engine (caller) peut enrichir.
    // Par convention, on met 0 ; l'engine re-construira un TimeoutError avec le vrai timeoutMs
    // si nécessaire, ou modifie le signal en amont pour propager la valeur.
    // Alternative discutée dans R-3.
    return new TimeoutError("Internal timeout", { timeoutMs: 0 });
  }

  // 3. Erreur réseau (pas de status HTTP)
  if (signal.networkErrorKind) {
    return new TransientProviderError(
      `Network error: ${signal.networkErrorKind}`,
      { networkErrorKind: signal.networkErrorKind }
    );
  }

  // 4. Classification par status HTTP
  const status = signal.status;

  if (status === 401 || status === 403) {
    return new AuthError(`Auth error: ${status}`);
  }

  if (status === 400 || status === 404) {
    return new InvalidRequestError(`Invalid request: ${status}`);
  }

  if (status === 429) {
    return new RateLimitError("Rate limit: 429", {
      retryAfterMs: parseRetryAfter(signal.headers)
    });
  }

  if (status === 529) {
    return new OverloadedError("Overloaded: 529", {
      retryAfterMs: parseRetryAfter(signal.headers)
    });
  }

  if (status === 500 || status === 502 || status === 503) {
    return new TransientProviderError(
      `Transient provider: ${status}`,
      {
        status,
        retryAfterMs: status === 503 ? parseRetryAfter(signal.headers) : undefined
      }
    );
  }

  if (status !== undefined) {
    // 5xx non standard, 3xx, ou autre : conservatism → transient
    return new TransientProviderError(
      `Unexpected status: ${status}`,
      { status }
    );
  }

  // 5. Fallback : ni status, ni networkErrorKind identifiés
  return new TransientProviderError(
    "Unknown error",
    { networkErrorKind: "unknown" }
  );
}
```

### 3.4 Règles clés

**R-1 — Priorité abort > timeout > réseau > status HTTP**.

L'ordre des branches est normatif. Un signal avec `aborted: true` ET `status: 429` doit retourner `AbortedError` (pas `RateLimitError`). Rationale : l'abort externe prime (§13.2 NX).

**R-2 — 529 traité dans le classifier de base**.

Bien que 529 soit "spécifique Anthropic" (pas un status HTTP standard), on le traite ici pour que tout binding qui voit un 529 produise un `OverloadedError` cohérent. Anthropic binding peut néanmoins override si la sémantique de 529 évolue ou diffère.

**R-3 — `timeoutMs` inconnu à ce niveau**.

Le classifier ne connaît pas la policy timeout qui a déclenché. Deux options :
- **(a)** Le classifier construit `new TimeoutError(..., { timeoutMs: 0 })` comme placeholder ; l'engine reconstruit avec la vraie valeur après catch (redondant).
- **(b)** Le caller (binding ou engine) passe `timeoutMs` dans le signal étendu.

**V1 retient (a)** par simplicité. L'engine **reconstruit** le `TimeoutError` dans son catch block au step 7.g avec le `timeoutMs` correct :

```ts
// NIB-M-EXECUTE-CALL step 7.g :
catch (err) {
  if (externalSignal?.aborted) {
    throw new AbortedError("Aborted by external signal", { cause: err, callId, provider, model });
  }
  if (err instanceof DOMException && err.name === "TimeoutError") {
    throw new TimeoutError("Internal timeout", {
      cause: err,
      callId, provider, model,
      timeoutMs: config.timeout.perAttemptMs  // ← l'engine connaît la valeur
    });
  }
  // Sinon : erreur réseau → construire ProviderErrorSignal → classifyError
}
```

**Conséquence** : `classifyErrorBase` est appelé **principalement** pour les erreurs HTTP (signal avec status), **pas** pour les DOMException. Les DOMException sont traitées directement par l'engine. Cette séparation est cohérente avec l'architecture (l'engine connaît les valeurs de policy, le classifier ne les connaît pas).

**Clarification** : les champs `signal.timeout` et `signal.aborted` sont **défensifs** — ils couvrent le cas où un binding construirait un `ProviderErrorSignal` à partir d'une DOMException (ce qui est rare en pratique). En usage principal, ils sont à `false`.

**R-4 — `parseRetryAfter` uniquement pour 429, 529, 503**.

Les autres status (500, 502, 4xx, etc.) n'utilisent pas `parseRetryAfter`. Si le header est présent, il est ignoré. Rationale : sémantiquement, `Retry-After` est associé au rate-limiting et à la disponibilité. Pour une erreur 500 (server error générique), le retry se fait en backoff.

**R-5 — Pas d'enrichissement contextuel**.

Les erreurs retournées **ne portent pas** `callId`, `provider`, `model`, `attempts`. Ces champs sont remplis par l'engine au moment du throw (voir NIB-M-ERRORS §3.3 — "Enrichissement par écrasement systématique"). Testable : `classifyErrorBase(signal).provider === undefined`.

**R-6 — Pas de throw**

La fonction ne throw jamais. Inputs pathologiques → fallback `TransientProviderError("Unknown error")`. Conservative par défaut.

**R-7 — Status `undefined` + `networkErrorKind` `undefined` → `TransientProviderError("Unknown error")`**

Cas de signal vide (théoriquement impossible mais défensif). Classé en transient pour permettre au retry de rattraper.

---

## 4. Exemples

### 4.1 401 → AuthError

```ts
const err = classifyErrorBase({
  status: 401,
  headers: {},
  timeout: false,
  aborted: false
});

err instanceof AuthError;     // true
err.kind === "auth";          // true
err.message === "Auth error: 401";  // true
err.provider === undefined;   // true (pas d'enrichissement)
```

### 4.2 429 avec `Retry-After`

```ts
const err = classifyErrorBase({
  status: 429,
  headers: { "retry-after": "30" },
  timeout: false,
  aborted: false
});

err instanceof RateLimitError;  // true
err.retryAfterMs === 30000;     // true
```

### 4.3 529 (Anthropic-specific via base)

```ts
const err = classifyErrorBase({
  status: 529,
  headers: {},
  timeout: false,
  aborted: false
});

err instanceof OverloadedError;  // true
err.retryAfterMs === undefined;  // true (pas de header)
```

### 4.4 500 → TransientProvider

```ts
const err = classifyErrorBase({
  status: 500,
  headers: {},
  timeout: false,
  aborted: false
});

err instanceof TransientProviderError;  // true
err.status === 500;                     // true
err.retryAfterMs === undefined;         // toujours undefined pour 500 (seul 503 utilise)
```

### 4.5 503 avec Retry-After

```ts
const err = classifyErrorBase({
  status: 503,
  headers: { "retry-after": "5" },
  timeout: false,
  aborted: false
});

err instanceof TransientProviderError;  // true
err.status === 503;                     // true
err.retryAfterMs === 5000;              // true
```

### 4.6 Network reset

```ts
const err = classifyErrorBase({
  networkErrorKind: "reset",
  headers: {},
  timeout: false,
  aborted: false
  // status absent
});

err instanceof TransientProviderError;   // true
err.networkErrorKind === "reset";        // true
err.status === undefined;                // true
```

### 4.7 Abort externe prime sur status

```ts
const err = classifyErrorBase({
  status: 429,
  headers: {},
  timeout: false,
  aborted: true
});

err instanceof AbortedError;     // true (abort prime)
```

### 4.8 Status 418 (I'm a teapot) → TransientProvider conservateur

```ts
const err = classifyErrorBase({
  status: 418,
  headers: {},
  timeout: false,
  aborted: false
});

err instanceof TransientProviderError;  // true (fallback conservateur)
err.status === 418;                     // true
```

### 4.9 Signal complètement vide

```ts
const err = classifyErrorBase({
  headers: {},
  timeout: false,
  aborted: false
  // status et networkErrorKind absents
});

err instanceof TransientProviderError;       // true
err.networkErrorKind === "unknown";          // true
err.status === undefined;                    // true
```

---

## 5. Edge cases

| Cas | Comportement attendu | Test |
| --- | --- | --- |
| `status: 0` | Tombe dans `status !== undefined` → `TransientProviderError("Unexpected status: 0")`. Défensif. | T-EC-XX |
| `status: 200` (ne devrait pas être classifié mais défensif) | `TransientProviderError("Unexpected status: 200")`. Si ça arrive, c'est un bug d'appel. | — |
| Headers avec clé `"Retry-After"` (majuscule) | **Ne match pas** (I-13 — lowercase attendu). Le caller doit normaliser avant. `retryAfterMs` sera `undefined`. | — |
| `status: 429` sans header `Retry-After` | `RateLimitError` avec `retryAfterMs: undefined`. | T-EC-XX |
| `status: 429` ET `aborted: true` | `AbortedError` (abort prime). | T-EC-XX |
| `status: 429` ET `timeout: true` | `TimeoutError` (timeout prime sur status). | — |
| `timeout: true` ET `aborted: true` | `AbortedError` (abort prime sur timeout). | — |
| `providerCode`, `providerMessage` non utilisés | Ignorés en v1. Accepté dans le type mais pas exploités. | — |
| `bodyText` très long | Ignoré en v1 (non lu par le classifier). | — |

---

## 6. Constraints (invariants spécifiques)

### C-EC1 — Pureté

Fonction pure. Pas d'accès clock, pas de log, pas d'I/O. Testable exhaustivement par vecteurs.

### C-EC2 — Ordre de priorité normatif

Abort > Timeout > Network > HTTP status. Cet ordre est **normatif** et testable (vecteur combiné `{status: 429, aborted: true}` → `AbortedError`).

### C-EC3 — Pas d'enrichissement contextuel

Les erreurs retournées n'ont pas `callId`, `provider`, `model`, `attempts`. Testable : `classifyErrorBase({status: 401, ...}).callId === undefined`.

### C-EC4 — `parseRetryAfter` uniquement pour 429, 529, 503

Testable : `classifyErrorBase({status: 500, headers: {"retry-after": "10"}, ...}).retryAfterMs === undefined`.

### C-EC5 — Pas de lecture de `bodyText`, `providerCode`, `providerMessage`

Ces champs du signal sont acceptés (pour que les bindings puissent les fournir si utile), mais **pas utilisés** par le classifier de base. Un override de binding peut, lui, les utiliser.

### C-EC6 — Fallback conservateur

Status inconnu / signal vide → `TransientProviderError`. Rationale : fail-open pour que le retry rattrape ; fail-closed si retry épuisé (via `retry_exhausted` dans le resolver).

### C-EC7 — Une seule LLMRuntimeError retournée

Pas de wrapping ni de multi-erreur. Une branche = une erreur.

---

## 7. Integration (consommation par les bindings)

### 7.1 Pattern type dans un binding Anthropic

```ts
// NIB-M-BINDINGS-COMPLETION — extrait Anthropic :
import { classifyErrorBase } from "../services/error-classifier-base";
import { OverloadedError } from "../errors/subclasses";
import { parseRetryAfter } from "../services/retry-resolver";

const anthropicBinding: ProviderBinding = {
  // ...
  classifyError(signal: ProviderErrorSignal): LLMRuntimeError {
    // 529 est spécifique à Anthropic. Le base le gère déjà mais
    // on peut override ici pour un message plus précis si souhaité.
    if (signal.status === 529) {
      return new OverloadedError("Anthropic overloaded (529)", {
        retryAfterMs: parseRetryAfter(signal.headers)
      });
    }

    // Tous les autres cas : délègue au classifier de base
    return classifyErrorBase(signal);
  },
  // ...
};
```

### 7.2 Pattern type dans un binding OpenAI

```ts
const openaiBinding: ProviderBinding = {
  // ...
  classifyError(signal: ProviderErrorSignal): LLMRuntimeError {
    // OpenAI utilise 429 pour plusieurs situations distinguables via le body.
    // V1 : on ne discrimine pas, on laisse le base classifier faire 429 → RateLimit.
    return classifyErrorBase(signal);
  },
  // ...
};
```

### 7.3 Pattern type binding OpenAI-compatible (DeepSeek, Groq, etc.)

```ts
const openaiCompatibleBinding: ProviderBinding = {
  // ...
  classifyError(signal: ProviderErrorSignal): LLMRuntimeError {
    // Même logique qu'OpenAI : le base classifier suffit.
    return classifyErrorBase(signal);
  },
  // ...
};
```

### 7.4 L'engine n'appelle pas directement `classifyErrorBase`

**Règle normative** : `executeCall` et `executeEmbedding` appellent uniquement `binding.classifyError(signal)`. Le binding décide de déléguer ou non au base classifier. Cette indirection garantit :
- Le binding a le dernier mot sur la classification pour ses erreurs spécifiques.
- Le base classifier reste un helper pour les cas "générique HTTP".

---

## 8. Relationship avec les autres NIB-M

| NIB-M | Relation |
| --- | --- |
| **NIB-M-ERRORS** | Construit des instances des 11 sous-classes (principalement `AuthError`, `InvalidRequestError`, `RateLimitError`, `OverloadedError`, `TransientProviderError`, `TimeoutError`, `AbortedError`). |
| **NIB-M-RETRY-RESOLVER** | Consomme `parseRetryAfter` pour 429/529/503. |
| **NIB-M-BINDINGS-COMPLETION** / **NIB-M-BINDING-EMBEDDING** | Consomme ce module comme fallback dans leur `classifyError`. Override possible. |
| **NIB-M-EXECUTE-CALL** / **NIB-M-EXECUTE-EMBEDDING** | N'appelle PAS ce module directement. Toujours via `binding.classifyError`. |

---

## 9. Tests de référence (NIB-T §9)

| Zone | ID tests NIB-T |
| --- | --- |
| 401/403 → AuthError | T-EC-01..02 |
| 400/404 → InvalidRequestError | T-EC-03..04 |
| 429 → RateLimitError (avec/sans Retry-After) | T-EC-05..07 |
| 529 → OverloadedError (avec/sans Retry-After) | T-EC-08..10 |
| 500/502/503 → TransientProviderError | T-EC-11..13 |
| 503 avec Retry-After → retryAfterMs renseigné | T-EC-14 |
| Status inconnu → TransientProvider conservateur | T-EC-15 |
| `networkErrorKind` seul | T-EC-16..19 |
| `timeout: true` | T-EC-20 |
| `aborted: true` prime sur tout | T-EC-21..22 |
| Signal vide → TransientProvider fallback | T-EC-23 |
| Pureté | P-EC-a |
| Pas d'enrichissement contextuel | C-EC-XX |

---

## 10. Implémentation cible

**Fichier** : `src/services/error-classifier-base.ts` — **~80 LOC**

```ts
import type { ProviderErrorSignal } from "../types/canonical";
import {
  LLMRuntimeError,
  AuthError, InvalidRequestError, RateLimitError, OverloadedError,
  TransientProviderError, TimeoutError, AbortedError
} from "../errors/subclasses";
import { parseRetryAfter } from "./retry-resolver";

export function classifyErrorBase(signal: ProviderErrorSignal): LLMRuntimeError {
  if (signal.aborted) {
    return new AbortedError("Aborted by external signal");
  }
  if (signal.timeout) {
    return new TimeoutError("Internal timeout", { timeoutMs: 0 });
  }
  if (signal.networkErrorKind) {
    return new TransientProviderError(
      `Network error: ${signal.networkErrorKind}`,
      { networkErrorKind: signal.networkErrorKind }
    );
  }

  const status = signal.status;
  if (status === 401 || status === 403) {
    return new AuthError(`Auth error: ${status}`);
  }
  if (status === 400 || status === 404) {
    return new InvalidRequestError(`Invalid request: ${status}`);
  }
  if (status === 429) {
    return new RateLimitError("Rate limit: 429", {
      retryAfterMs: parseRetryAfter(signal.headers)
    });
  }
  if (status === 529) {
    return new OverloadedError("Overloaded: 529", {
      retryAfterMs: parseRetryAfter(signal.headers)
    });
  }
  if (status === 500 || status === 502 || status === 503) {
    return new TransientProviderError(
      `Transient provider: ${status}`,
      {
        status,
        retryAfterMs: status === 503 ? parseRetryAfter(signal.headers) : undefined
      }
    );
  }
  if (status !== undefined) {
    return new TransientProviderError(`Unexpected status: ${status}`, { status });
  }

  return new TransientProviderError("Unknown error", { networkErrorKind: "unknown" });
}
```

---

*VegaCorp — Implicit-Free Execution (IFE) — "La fiabilité précède l'intelligence."*
