---
id: NIB-M-SIGNAL-COMPOSER
type: nib-module
version: "1.0.0"
scope: llm-runtime
module: signal-composer
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-M-SIGNAL-COMPOSER — Module Brief — `composeSignal` et `abortableSleep`

**Package** : `@vegacorp/llm-runtime`
**Source NX** : §5.5 (signal-composer), §13.2 (signaux — priorité externe sur interne, propagation abort sur sleeps)
**NIB-T associé** : §8 (signal-composer), §23 (contract invariants — signaux)

---

## 1. Purpose

Ce module héberge **deux primitives de gestion des signaux** utilisées par l'engine pour assurer :

1. **`composeSignal(timeoutMs, externalSignal?)`** : construit un `AbortSignal` composite qui s'active dès que **l'un des deux** sous-signaux s'active (timeout interne OU abort externe). Garantit que l'abort externe **prime** sur le timeout interne sémantiquement (via le reclassement de l'engine).

2. **`abortableSleep(ms, externalSignal?)`** : attend `ms` millisecondes, mais s'interrompt immédiatement si `externalSignal` devient aborted. Utilisé pour les delays de retry et de throttle.

Ces primitives formalisent un pattern récurrent (composer/attendre avec abort) et **isolent** les effets de bord temporels (timer ownership, cleanup) derrière une API claire. Elles garantissent les invariants critiques :

- **Invariant I-7 du NIB-S** : Abort externe propagé à toute attente.
- **Priorité §13.2 du NX** : Abort externe > timeout interne (sémantique au reclassement).
- **Timer ownership** : pas de leak de timer — chaque sleep posté est nettoyé (via `AbortSignal.timeout` natif, qui gère ça automatiquement).

Le reclassement `DOMException` → `AbortedError` / `TimeoutError` n'est **pas** fait ici — c'est une responsabilité de l'engine (NIB-M-EXECUTE-CALL steps 7.b, 7.d, 7.g, 7.h). Ce module produit des `AbortSignal` et des `Promise`-rejects bruts (typiquement `DOMException` avec `name === "AbortError"` ou `name === "TimeoutError"` selon l'origine).

---

## 2. Inputs / Outputs

### 2.1 Consommé par ce module

- API standard Node.js ≥ 20 :
  - `AbortSignal.timeout(ms)` — produit un signal qui s'active après `ms`.
  - `AbortSignal.any([sig1, sig2])` — produit un signal composite qui s'active dès qu'un des sous-signaux s'active.
  - `AbortSignal.addEventListener("abort", cb)`.
  - `setTimeout` / `clearTimeout` (pour `abortableSleep`).

### 2.2 Produit par ce module

**Interne (non exporté publiquement)** :

```ts
function composeSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal
): AbortSignal;

function abortableSleep(
  ms: number,
  externalSignal?: AbortSignal
): Promise<void>;
```

### 2.3 Consommateurs

- **NIB-M-EXECUTE-CALL** :
  - step 7.e : `composeSignal(config.timeout.perAttemptMs, externalSignal)` pour wrapper chaque `fetch`.
  - step 7.b : `abortableSleep(retryDecision.delayMs, externalSignal)` pour le delay retry.
  - step 6.c : `abortableSleep(throttleDecision.waitMs, externalSignal)` pour le throttle.

- **NIB-M-EXECUTE-EMBEDDING** : même pattern pour sa boucle batch.

---

## 3. Algorithme — `composeSignal`

### 3.1 Signature

```ts
function composeSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal
): AbortSignal;
```

**Entrée** :
- `timeoutMs: number` — durée du timeout interne en millisecondes. Doit être > 0 (non vérifié par la fonction — contrat du caller).
- `externalSignal?: AbortSignal` — signal externe optionnel (typiquement `options.signal` passé par le consommateur à `adapter.call(request, options?)`, transmis à l'engine par la factory).

**Sortie** : un `AbortSignal` composite qui s'active dès que :
- Le timeout interne expire (après `timeoutMs` ms), OU
- `externalSignal` devient aborted.

### 3.2 Implémentation

```ts
function composeSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  if (externalSignal === undefined) {
    return timeoutSignal;
  }

  return AbortSignal.any([externalSignal, timeoutSignal]);
}
```

### 3.3 Règles clés

**R-1 — Utilisation exclusive des APIs natives**.

Pas de polyfill, pas de gestion manuelle d'`AbortController`. `AbortSignal.timeout` et `AbortSignal.any` sont standard Node.js ≥ 20 (cohérent avec `"engines": { "node": ">=20" }` dans `package.json`).

**R-2 — `externalSignal` absent → retourne `timeoutSignal` directement**.

Optimisation sémantique : si le consommateur n'a pas fourni de signal externe, le composite est inutile. On retourne directement le `timeoutSignal`.

**R-3 — Pas d'ownership du timer**.

`AbortSignal.timeout(ms)` crée un timer géré par le runtime Node.js. Il est **automatiquement nettoyé** :
- Si le signal est aborted manuellement avant le timeout (via `AbortSignal.any` quand l'autre signal s'active).
- Si le signal devient `garbage-collected`.

Ce module **ne gère pas** de cleanup manuel. Pas de `clearTimeout` ici.

**R-4 — Aucune distinction timeout vs abort dans le signal composite**.

Un `AbortSignal.any` combine sans exposer **quelle** source a déclenché l'abort. C'est l'engine (NIB-M-EXECUTE-CALL step 7.g) qui inspecte `externalSignal.aborted` et `signal.reason?.name` pour reclasser en `AbortedError` vs `TimeoutError` (voir §5 ci-dessous).

### 3.4 Reclassement dans l'engine (rappel — hors scope de ce module)

Quand un `fetch(url, { signal })` rejette avec un `DOMException`, l'engine distingue :

```ts
// NIB-M-EXECUTE-CALL step 7.g (hors scope de ce NIB-M, rappel pour contexte) :
try {
  response = await fetch(canonicalHttp.url, {
    method: "POST", headers, body, signal: composedSignal
  });
} catch (err) {
  // R-4 : le signal composite ne dit pas d'où vient l'abort.
  // L'engine reclasse en regardant externalSignal d'abord (priorité).
  if (externalSignal?.aborted) {
    throw new AbortedError("Aborted by external signal", { cause: err, callId, provider, model });
  }
  // Sinon : c'est le timeout interne qui a déclenché.
  if (err instanceof DOMException && err.name === "TimeoutError") {
    throw new TimeoutError("Internal timeout", { cause: err, callId, provider, model, timeoutMs });
  }
  // Sinon : erreur réseau (DNS, connection reset, etc.)
  throw classifyNetworkError(err);
}
```

**Priorité externe > interne** garantie par l'ordre de vérification : on regarde `externalSignal?.aborted` **avant** de regarder `err.name === "TimeoutError"`.

---

## 4. Algorithme — `abortableSleep`

### 4.1 Signature

```ts
function abortableSleep(
  ms: number,
  externalSignal?: AbortSignal
): Promise<void>;
```

**Entrée** :
- `ms: number` — durée du sleep en millisecondes. Si `ms <= 0`, la Promise résout immédiatement (via `setTimeout(cb, 0)` ou `setTimeout(cb, negative)` — les deux sont équivalents à 0 en Node).
- `externalSignal?: AbortSignal` — signal externe. Si déjà aborted au moment de l'appel, la Promise reject immédiatement avec `DOMException("aborted", "AbortError")` (ou l'équivalent natif `signal.reason`).

**Sortie** :
- Resolve `void` après `ms` ms écoulés sans abort.
- Reject avec un `DOMException` (name `"AbortError"`) si `externalSignal` devient aborted avant l'échéance.

### 4.2 Implémentation

```ts
function abortableSleep(
  ms: number,
  externalSignal?: AbortSignal
): Promise<void> {
  // Short-circuit si déjà aborted
  if (externalSignal?.aborted) {
    return Promise.reject(externalSignal.reason ?? new DOMException("Aborted", "AbortError"));
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      externalSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(externalSignal!.reason ?? new DOMException("Aborted", "AbortError"));
    };

    if (externalSignal) {
      externalSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
```

### 4.3 Règles clés

**R-1 — Nettoyage du listener après resolve**.

Si le timeout naturel se termine sans abort, le listener `onAbort` **doit être retiré** pour éviter un leak. `{ once: true }` sur `addEventListener` gère automatiquement la suppression après un unique déclenchement, mais on **retire explicitement** dans `setTimeout` aussi — pour couvrir le cas où le signal n'aborte jamais et que la Promise resolve.

Alternative : omettre `removeEventListener` dans le `resolve` — le `{ once: true }` fait que le listener est déjà marqué pour auto-suppression, et GC le cleanera quand le signal lui-même sera GC. En pratique, on laisse le `removeEventListener` explicite par **discipline défensive**.

**R-2 — Cleanup du timer si abort**.

Symétrique : si l'abort survient avant le timeout naturel, on `clearTimeout(timer)` pour éviter que le timer continue à tourner et résolve la Promise alors qu'elle a déjà reject.

**R-3 — Short-circuit si déjà aborted**.

Si `externalSignal.aborted === true` au moment de l'appel, on reject immédiatement **sans allouer de timer**. Important pour la performance et pour garantir la propagation immédiate de l'abort.

**R-4 — `signal.reason ?? new DOMException(...)`**.

Node ≥ 20 expose `AbortSignal.reason` (le motif passé à `controller.abort(reason)`). Si absent (abort programmatique sans reason), fallback sur un `DOMException("Aborted", "AbortError")` standard. Cohérent avec la sémantique des API Web modernes.

**R-5 — Pas de reclassement en `AbortedError`**.

Ce module rejecte avec le `DOMException` brut. Le reclassement en `AbortedError` est fait par l'engine (step 7.b/7.d catch block). Rationale : garder ce module découplé des types d'erreur spécifiques au runtime.

### 4.4 Reclassement dans l'engine (rappel — hors scope de ce module)

```ts
// NIB-M-EXECUTE-CALL step 7.b :
try {
  await abortableSleep(retryDecision.delayMs!, externalSignal);
} catch (e) {
  // Tout reject est assumé être un abort externe (R-1 garantit).
  throw new AbortedError("Aborted during retry sleep", {
    cause: e,
    provider: binding.provider,
    model: config.model,
    callId,
    attempts: attempt
  });
}
```

---

## 5. Exemples

### 5.1 `composeSignal` sans signal externe

```ts
const signal = composeSignal(5000);
// Équivalent de AbortSignal.timeout(5000)

await fetch(url, { signal });
// Throw DOMException("TimeoutError") après 5s si le fetch n'a pas fini.
```

### 5.2 `composeSignal` avec signal externe

```ts
const controller = new AbortController();
const signal = composeSignal(120000, controller.signal);

// L'utilisateur abort :
setTimeout(() => controller.abort(), 1000);

try {
  await fetch(url, { signal });
} catch (err) {
  // err est un DOMException("AbortError" ou "TimeoutError")
  // L'engine discrimine par externalSignal.aborted (externalSignal.aborted === true).
}
```

### 5.3 `abortableSleep` normal

```ts
await abortableSleep(2000);
// Resolve après 2s.
```

### 5.4 `abortableSleep` avec signal aborté en cours

```ts
const controller = new AbortController();
const sleepPromise = abortableSleep(10000, controller.signal);

setTimeout(() => controller.abort(), 500);

try {
  await sleepPromise;
} catch (e) {
  // e est un DOMException("Aborted", "AbortError")
  // Le timer de 10s a été clearTimeout() immédiatement.
}
```

### 5.5 `abortableSleep` avec signal déjà aborté

```ts
const controller = new AbortController();
controller.abort();  // abort AVANT l'appel

try {
  await abortableSleep(5000, controller.signal);
} catch (e) {
  // Reject immédiat, AUCUN timer créé.
}
```

### 5.6 `abortableSleep` avec `ms = 0`

```ts
await abortableSleep(0);
// Resolve au prochain tick de l'event loop.
```

### 5.7 Priorité externe vs interne (via engine)

```ts
// L'utilisateur définit un abort rapide
const userController = new AbortController();
setTimeout(() => userController.abort(), 100);

const request: LLMRequest = {
  messages: [{ role: "user", content: "test" }],
  signal: userController.signal
};

const adapter = createAnthropicAdapter({
  // ... timeout: { perAttemptMs: 120000 }  (timeout interne plus long)
});

try {
  await adapter.call(request);
} catch (e) {
  // e est AbortedError (pas TimeoutError), car externalSignal.aborted === true
  // malgré que AbortSignal.any combine les deux.
  // Reclassement fait par NIB-M-EXECUTE-CALL step 7.g.
}
```

---

## 6. Edge cases

| Cas | Comportement attendu | Test |
| --- | --- | --- |
| `composeSignal(ms, undefined)` | Retourne `AbortSignal.timeout(ms)` directement (pas d'`AbortSignal.any`). | T-SC-XX |
| `abortableSleep(0)` | Resolve au prochain tick via `setTimeout(cb, 0)`. | T-SC-XX |
| `abortableSleep(-10)` | Même comportement que `0` (setTimeout traite les valeurs négatives comme 0). | T-SC-XX |
| `abortableSleep(ms, alreadyAbortedSignal)` | Reject immédiat, aucun timer créé. | T-SC-XX |
| `abortableSleep(ms)` sans signal | Resolve après `ms`. Pas de listener. | T-SC-XX |
| `AbortSignal.any([externalSignal])` avec externalSignal déjà aborted | `AbortSignal.any` retourne un signal déjà aborted. `fetch` throw immédiatement. | — |
| Multiple abortableSleep en parallèle partageant le même signal | Tous reject simultanément quand le signal s'active. Chacun clean son timer. | T-SC-XX |
| `signal.reason` est un objet custom | Repropagé tel quel comme reason du reject (cohérent avec sémantique standard). | — |
| Appel de `abortableSleep` avec un `AbortSignal` qui devient aborted exactement au moment du timeout naturel | Race condition : la première callback qui se déclenche gagne. Comportement atomique via event loop Node. Acceptable (pas de garantie stricte d'ordre). | — |

---

## 7. Constraints (invariants spécifiques)

### C-SC1 — Priorité externe > interne (semantic, via engine)

Ce module **ne gère pas** la priorité sémantique abort vs timeout — il produit des signaux/rejects bruts. L'engine (NIB-M-EXECUTE-CALL step 7.g, 7.b, 7.d) inspecte `externalSignal?.aborted` **avant** le `name` du DOMException pour reclasser.

### C-SC2 — Pas de leak de timer

`abortableSleep` nettoie systématiquement son timer (soit via `clearTimeout(timer)` sur abort, soit via fin naturelle du timer). Testable : après 1000 sleeps, aucun timer Node en attente (inspection via `process._getActiveHandles()` en test).

### C-SC3 — `AbortSignal.any` si externalSignal présent

La règle composite est : `AbortSignal.any([externalSignal, AbortSignal.timeout(ms)])`. Ne jamais construire un `AbortController` custom pour fusionner — on utilise l'API native `any`.

### C-SC4 — `abortableSleep` resolve `void`

Le type de retour est `Promise<void>`. Ne pas retourner de valeur métier.

### C-SC5 — Short-circuit sur signal déjà aborted

`abortableSleep` vérifie `externalSignal?.aborted` avant d'allouer un timer. Micro-optimisation essentielle pour garantir la propagation immédiate de l'abort quand l'engine est dans une boucle serrée.

### C-SC6 — Utilisation exclusive des APIs Node ≥ 20

Pas de polyfill. Pas de `setTimeout` promise-wrap custom. Dépendance sur `AbortSignal.timeout`, `AbortSignal.any`, `AbortSignal.reason`.

---

## 8. Integration (consommation par l'engine)

### 8.1 `composeSignal` dans `executeCall` step 7.e

```ts
const composedSignal = composeSignal(config.timeout.perAttemptMs, externalSignal);

let response: Response;
try {
  response = await fetch(canonicalHttp.url, {
    method: canonicalHttp.method,
    headers: canonicalHttp.headers,
    body: canonicalHttp.bodyKind === "json"
      ? JSON.stringify(canonicalHttp.bodyJson)
      : undefined,
    signal: composedSignal
  });
} catch (err) {
  // Reclassement (step 7.g) :
  if (externalSignal?.aborted) throw new AbortedError(/* ... */);
  if (err instanceof DOMException && err.name === "TimeoutError") throw new TimeoutError(/* ... */);
  throw classifyNetworkError(err);
}
```

### 8.2 `abortableSleep` dans `executeCall` step 7.b (retry)

```ts
if (retryDecision.retry) {
  logger.emit({ eventType: "llm_call_retry_scheduled", ... });
  try {
    await abortableSleep(retryDecision.delayMs!, externalSignal);
  } catch (e) {
    throw new AbortedError("Aborted during retry sleep", {
      cause: e, provider, model, callId, attempts: attempt
    });
  }
}
```

### 8.3 `abortableSleep` dans `executeCall` step 6.c (throttle)

```ts
if (throttleDecision.throttle) {
  logger.emit({ eventType: "llm_call_throttled", ... });
  try {
    await abortableSleep(throttleDecision.waitMs!, externalSignal);
  } catch (e) {
    throw new AbortedError("Aborted during throttle wait", {
      cause: e, provider, model, callId, attempts: attempt
    });
  }
}
```

---

## 9. Relationship avec les autres NIB-M

| NIB-M | Relation |
| --- | --- |
| **NIB-M-EXECUTE-CALL** / **NIB-M-EXECUTE-EMBEDDING** | Seuls consommateurs. Utilisent `composeSignal` autour de chaque `fetch`, `abortableSleep` pour retry et throttle waits. Effectuent le reclassement `DOMException` → `AbortedError`/`TimeoutError`. |
| **NIB-M-ERRORS** | Les erreurs `AbortedError` et `TimeoutError` sont construites par l'engine, pas ici. Ce module produit du `DOMException` brut. |
| **NIB-M-RETRY-RESOLVER** / **NIB-M-THROTTLE** | Produisent les `delayMs`/`waitMs` consommés par `abortableSleep`. Aucune dépendance directe de ce module vers eux. |

Aucune dépendance vers `clock` (NIB-M-INFRA-UTILS) — on utilise uniquement `AbortSignal.timeout` et `setTimeout` natifs, qui ont leur propre horloge monotone interne.

---

## 10. Tests de référence (NIB-T §8, §23)

| Zone | ID tests NIB-T |
| --- | --- |
| `composeSignal` timeout déclenche | T-SC-01 |
| `composeSignal` sans signal externe | T-SC-02 |
| `composeSignal` abort externe prime (via engine — reclassement) | T-SC-03 / C-SI-XX |
| `abortableSleep` resolve après délai | T-SC-04 |
| `abortableSleep` reject sur abort externe | T-SC-05 |
| `abortableSleep` reject immédiat si signal déjà aborted | T-SC-06 |
| Pas de leak de timer | T-SC-07 / P-SC-a |
| Nettoyage listener après resolve | T-SC-08 |
| `abortableSleep(0)` | T-SC-09 |
| Contract : abort externe propagé à abortableSleep | C-SI-XX (§23) |
| Contract : priorité abort externe > timeout interne | C-SI-XX (§23) |

---

## 11. Implémentation cible

**Fichier** : `src/services/signal-composer.ts` — **~40 LOC**

```ts
// src/services/signal-composer.ts

export function composeSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (externalSignal === undefined) return timeoutSignal;
  return AbortSignal.any([externalSignal, timeoutSignal]);
}

export function abortableSleep(
  ms: number,
  externalSignal?: AbortSignal
): Promise<void> {
  if (externalSignal?.aborted) {
    return Promise.reject(
      externalSignal.reason ?? new DOMException("Aborted", "AbortError")
    );
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(externalSignal!.reason ?? new DOMException("Aborted", "AbortError"));
    };

    if (externalSignal) {
      externalSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
```

---

*VegaCorp — Implicit-Free Execution (IFE) — "La fiabilité précède l'intelligence."*
