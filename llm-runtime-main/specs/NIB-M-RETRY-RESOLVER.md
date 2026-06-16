---
id: NIB-M-RETRY-RESOLVER
type: nib-module
version: "1.0.0"
scope: llm-runtime
module: retry-resolver
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-M-RETRY-RESOLVER — Module Brief — `resolveRetryDecision` et `parseRetryAfter`

**Package** : `@vegacorp/llm-runtime`
**Source NX** : §5.5 (retry-resolver + parseRetryAfter), §10.1 (RetryDecision, table), §9.2 (RetryPolicy)
**NIB-T associé** : §2 (retry-resolver), §3 (parseRetryAfter)

---

## 1. Purpose

Ce module héberge **deux fonctions pures** qui matérialisent la décision de retry d'un call LLM :

1. **`resolveRetryDecision(error, attempt, headers, policy)`** → `RetryDecision`. Prend une erreur, le numéro d'attempt courant, les headers HTTP de la dernière réponse, et la policy de retry. Retourne une décision matérialisée : retry oui/non, avec quel délai, pour quelle raison.
2. **`parseRetryAfter(headers)`** → `number | undefined`. Helper qui parse le header `Retry-After` RFC 7231 (formats "seconds" ou "HTTP-date") et retourne un délai en millisecondes.

Les deux fonctions sont hébergées dans le **même fichier** `src/services/retry-resolver.ts` (§5.5 NX). `parseRetryAfter` est utilisé **exclusivement** par `resolveRetryDecision` pour les erreurs `RateLimitError`, `OverloadedError`, `TransientProviderError`. Il n'est **pas** exporté publiquement.

`resolveRetryDecision` n'est pas non plus exporté publiquement — c'est un service interne consommé uniquement par l'engine. Seule la `RetryPolicy` (définie dans NIB-S §5.2) est exportée côté publique pour que le consommateur configure.

---

## 2. Inputs / Outputs

### 2.1 Consommé par ce module

- **`LLMRuntimeError`** et ses 11 sous-classes (NIB-M-ERRORS).
- **`RetryPolicy`** (NIB-S §5.2).
- **`clock.nowWall()`** (NIB-M-INFRA-UTILS) — utilisé par `parseRetryAfter` pour la branche HTTP-date.
- Le `Error` native JavaScript (type de fallback pour les erreurs non classifiées).

### 2.2 Produit par ce module

**Interne (non exporté publiquement)** :

- Fonction `resolveRetryDecision(error, attempt, headers, policy): RetryDecision`.
- Fonction `parseRetryAfter(headers): number | undefined`.
- Type `RetryDecision` (forme canonique interne — pas exporté).

```ts
type RetryDecision =
  | { readonly retry: false; readonly reason: RetryDecisionReason }
  | { readonly retry: true; readonly delayMs: number; readonly reason: RetryDecisionReason };
```

Discriminated union : `delayMs` est garanti présent uniquement quand `retry === true`. Le consommateur bénéficie du narrowing TypeScript natif sans assertion.

### 2.3 Consommateurs

- **NIB-M-EXECUTE-CALL** : au step 7.b, appelle `resolveRetryDecision(lastError, attempt, lastHeaders, config.retry)` pour décider si retry ou throw.
- **NIB-M-EXECUTE-EMBEDDING** : même usage pour sa propre boucle retry (voir NIB-M-EXECUTE-EMBEDDING).

---

## 3. Algorithme — `parseRetryAfter`

### 3.1 Signature

```ts
function parseRetryAfter(headers: Record<string, string>): number | undefined;
```

**Entrée** :
- `headers` : `Record<string, string>` avec clés **normalisées en lowercase** (invariant I-13 du NIB-S).
- Lit `headers["retry-after"]`.

**Sortie** :
- Durée en **millisecondes** (`number`), ou
- `undefined` si header absent / non parseable / valeur rejetée.

### 3.2 Formats acceptés (RFC 7231 §7.1.3)

**Format 1 — integer seconds** :
- Entier positif → multiplié par 1000 → retourne `N × 1000` ms.
- Valeur **négative** → retourne `undefined` (rejet défensif).
- Valeur **non entière** (ex. `"5.5"`) : v1 traite comme non parseable → `undefined`. Rationale : RFC 7231 parle explicitement de "non-negative decimal integer".

**Format 2 — HTTP-date (IMF-fixdate)** :
- Parser la date via `new Date(raw)` (reconnaît le format IMF-fixdate natif).
- Si `isNaN(parsedDate.getTime())` → `undefined`.
- Calculer `deltaMs = parsedDate.getTime() - clock.nowWall().getTime()`.
- Si `deltaMs <= 0` → retourner `0` (date déjà passée, retry immédiat — robuste face au clock skew et au temps de transit).
- Sinon → retourner `deltaMs`.

### 3.3 Pseudocode

```ts
function parseRetryAfter(headers: Record<string, string>): number | undefined {
  const raw = headers["retry-after"];
  if (!raw || raw.trim() === "") return undefined;

  // Tentative 1 : integer seconds
  const trimmed = raw.trim();
  if (/^-?\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    if (n < 0) return undefined;
    return n * 1000;
  }

  // Tentative 2 : HTTP-date (IMF-fixdate)
  const parsedDate = new Date(trimmed);
  if (isNaN(parsedDate.getTime())) return undefined;

  const deltaMs = parsedDate.getTime() - clock.nowWall().getTime();
  return deltaMs <= 0 ? 0 : deltaMs;
}
```

### 3.4 Tolérance et pureté

- **Tolérance** : valeur non numérique ET non parseable comme HTTP-date → `undefined` (pas de throw).
- **Pureté** : fonction pure **modulo l'accès à `clock.nowWall()`** pour la branche HTTP-date. En test, l'horloge est mockée via le module `clock` (NIB-M-INFRA-UTILS).
- La branche "integer seconds" est purement déterministe (pas d'accès horloge).

### 3.5 Exemples de comportement

| `headers["retry-after"]` | Sortie | Raison |
| --- | --- | --- |
| `"10"` | `10000` | 10 secondes |
| `"0"` | `0` | 0 secondes valide |
| `"-5"` | `undefined` | valeur négative rejetée |
| `"5.5"` | `undefined` | non entier, et IMF-fixdate ne match pas |
| `""` | `undefined` | vide |
| `"not-a-number"` | `undefined` | ni entier ni date |
| absent (`headers` ne contient pas la clé) | `undefined` | — |
| `"Wed, 21 Oct 2026 07:28:00 GMT"` (futur de 60s) | `60000` (approx) | `deltaMs` positif |
| `"Wed, 21 Oct 2020 07:28:00 GMT"` (passé) | `0` | `deltaMs <= 0` → retry immédiat |
| `"2026-04-17T14:32:05Z"` (ISO 8601, pas IMF-fixdate) | `60000` (approx, selon now) | `new Date()` parse aussi ISO — toléré en v1 |

---

## 4. Algorithme — `resolveRetryDecision`

### 4.1 Signature

```ts
function resolveRetryDecision(
  error: LLMRuntimeError | Error,
  attempt: number,                      // 0-indexé dans la boucle
  headers: Record<string, string>,
  policy: RetryPolicy
): RetryDecision;
```

**Entrée** :
- `error` : une `LLMRuntimeError` (instance d'une des 11 sous-classes) OU un `Error` brut (cas `transient_unknown`).
- `attempt` : numéro de l'attempt qui **vient d'échouer**, 0-indexé (attempt 0 = premier attempt).
- `headers` : headers HTTP de la dernière réponse (ou `{}` si erreur réseau / abort / timeout).
- `policy` : `RetryPolicy` avec `maxAttempts`, `backoffBaseMs`, `maxBackoffMs`.

**Sortie** : `RetryDecision` avec :
- `retry: boolean` — doit-on retenter ?
- `delayMs?: number` — délai avant le prochain attempt (uniquement si `retry === true`).
- `reason: string` — raison explicite de la décision.

### 4.2 Table de décision (source : §10.1 NX)

Avec `attempt` 0-indexé, la condition "budget disponible" est `attempt + 1 < maxAttempts`.

| Type erreur (ordre d'inspection) | Budget disponible ? | Décision | Application |
| --- | --- | --- | --- |
| `AuthError` | peu importe | `{ retry: false, reason: "fatal_auth" }` | T-RR-01 |
| `InvalidRequestError` | peu importe | `{ retry: false, reason: "fatal_invalid_request" }` | T-RR-02 |
| `ResponseParseError` | peu importe | `{ retry: false, reason: "fatal_parse_error" }` | T-RR-03 |
| `ContentFilterError` | peu importe | `{ retry: false, reason: "fatal_content_filter" }` | T-RR-04 |
| `AbortedError` | peu importe | `{ retry: false, reason: "fatal_aborted" }` | T-RR-05 |
| `ProviderProtocolError` | peu importe | `{ retry: false, reason: "fatal_protocol" }` | T-RR-06 |
| `SilentTruncationError` | peu importe | `{ retry: false, reason: "fatal_truncation" }` | T-RR-07 |
| `RateLimitError` | oui | `{ retry: true, delayMs: parseRetryAfter(headers) ?? backoff, reason: "transient_rate_limit" }` | T-RR-08..12 |
| `OverloadedError` | oui | `{ retry: true, delayMs: parseRetryAfter(headers) ?? backoff, reason: "transient_overloaded" }` | T-RR-13..14 |
| `TransientProviderError` | oui | `{ retry: true, delayMs: parseRetryAfter(headers) ?? backoff, reason: "transient_provider" }` | T-RR-15..16 |
| `TimeoutError` | oui | `{ retry: true, delayMs: backoff, reason: "transient_timeout" }` | T-RR-17..18 |
| Retriable épuisé (budget = false) | non | `{ retry: false, reason: "retry_exhausted" }` | T-RR-19..24 |
| Autre `Error` (non classifié) | oui | `{ retry: true, delayMs: backoff, reason: "transient_unknown" }` | T-RR-25..28 |
| Autre `Error` (non classifié) | non | `{ retry: false, reason: "retry_exhausted" }` | T-RR-27 |

### 4.3 Règles clés

**R-1 — `TimeoutError` n'utilise jamais `Retry-After`**.

Seuls `RateLimitError`, `OverloadedError`, `TransientProviderError` utilisent `parseRetryAfter`. `TimeoutError` retombe toujours sur `backoff(attempt, policy)`.

Rationale : `Retry-After` est sémantique "le serveur te dit quand retry". Un timeout est un problème côté client — l'attente suit le backoff standard.

**R-2 — `transient_unknown` + warn observable**.

Les `Error` bruts (pas `LLMRuntimeError`) tombent en `transient_unknown`. Approche hybride : retry conservateur + event warn `llm_call_unknown_error_classified` émis par l'engine au step 7.b (non émis par `resolveRetryDecision` — pure function, pas d'effet de bord). Le mainteneur voit les warnings dans les logs et sait qu'il y a un trou dans le classifier à combler.

**R-3 — Budget épuisé prime**.

Si l'erreur est retriable par nature **mais** `attempt + 1 >= maxAttempts`, la décision est `{ retry: false, reason: "retry_exhausted" }`. Cela inclut les `Error` bruts (ligne `transient_unknown` épuisé → `retry_exhausted`, voir T-RR-27).

**R-4 — Backoff exponentiel capé**.

```ts
function backoff(attempt: number, policy: RetryPolicy): number {
  return Math.min(policy.backoffBaseMs * 2 ** attempt, policy.maxBackoffMs);
}
```

Ex. avec `backoffBaseMs: 2000`, `maxBackoffMs: 60000` :
- attempt=0 → 2000 ms
- attempt=1 → 4000 ms
- attempt=2 → 8000 ms
- attempt=3 → 16000 ms
- attempt=4 → 32000 ms
- attempt=5 → 60000 ms (capé, car 64000 > 60000)
- attempt=6 → 60000 ms (capé)

Fonction pure.

**R-5 — `parseRetryAfter` prime si valeur définie**.

Pour `RateLimitError`, `OverloadedError`, `TransientProviderError` :
- Si `parseRetryAfter(headers)` retourne un nombre (y compris `0`) → utilise cette valeur.
- Si retourne `undefined` → fallback sur `backoff(attempt, policy)`.

Ex. `RateLimitError` avec `headers["retry-after"] = "10"` → `delayMs = 10000` même si `backoff` aurait donné `2000` (T-RR-11).

**R-6 — `parseRetryAfter` vaut 0 → utilisé**.

Si `parseRetryAfter` retourne `0` (HTTP-date déjà passée), c'est une valeur valide — on retry immédiatement (`delayMs: 0`). Ce cas est **différent** de `undefined` (header absent/invalide).

### 4.4 Pseudocode

```ts
function resolveRetryDecision(
  error: LLMRuntimeError | Error,
  attempt: number,
  headers: Record<string, string>,
  policy: RetryPolicy
): RetryDecision {
  // 1. Erreurs fatales (jamais retry, peu importe l'attempt)
  if (error instanceof AuthError)            return { retry: false, reason: "fatal_auth" };
  if (error instanceof InvalidRequestError)  return { retry: false, reason: "fatal_invalid_request" };
  if (error instanceof ResponseParseError)   return { retry: false, reason: "fatal_parse_error" };
  if (error instanceof ContentFilterError)   return { retry: false, reason: "fatal_content_filter" };
  if (error instanceof AbortedError)         return { retry: false, reason: "fatal_aborted" };
  if (error instanceof ProviderProtocolError) return { retry: false, reason: "fatal_protocol" };
  if (error instanceof SilentTruncationError) return { retry: false, reason: "fatal_truncation" };

  // 2. Budget check
  const budgetAvailable = attempt + 1 < policy.maxAttempts;
  const bo = backoff(attempt, policy);

  // 3. Erreurs retriables par nature
  if (error instanceof RateLimitError) {
    if (!budgetAvailable) return { retry: false, reason: "retry_exhausted" };
    return {
      retry: true,
      delayMs: parseRetryAfter(headers) ?? bo,
      reason: "transient_rate_limit"
    };
  }

  if (error instanceof OverloadedError) {
    if (!budgetAvailable) return { retry: false, reason: "retry_exhausted" };
    return {
      retry: true,
      delayMs: parseRetryAfter(headers) ?? bo,
      reason: "transient_overloaded"
    };
  }

  if (error instanceof TransientProviderError) {
    if (!budgetAvailable) return { retry: false, reason: "retry_exhausted" };
    return {
      retry: true,
      delayMs: parseRetryAfter(headers) ?? bo,
      reason: "transient_provider"
    };
  }

  if (error instanceof TimeoutError) {
    if (!budgetAvailable) return { retry: false, reason: "retry_exhausted" };
    return {
      retry: true,
      delayMs: bo,                         // PAS parseRetryAfter pour Timeout
      reason: "transient_timeout"
    };
  }

  // 4. Erreur non classifiée (Error brut, pas LLMRuntimeError) → transient_unknown
  if (!budgetAvailable) return { retry: false, reason: "retry_exhausted" };
  return {
    retry: true,
    delayMs: bo,
    reason: "transient_unknown"
  };
}

function backoff(attempt: number, policy: RetryPolicy): number {
  return Math.min(policy.backoffBaseMs * 2 ** attempt, policy.maxBackoffMs);
}
```

### 4.5 Pureté

`resolveRetryDecision` est une fonction **pure** modulo l'accès à `clock.nowWall()` (uniquement si `parseRetryAfter` est appelée avec une HTTP-date). Testable exhaustivement sur l'ensemble des combinaisons (erreur × attempt × headers × policy).

Propriété **P-RR-a** : deux appels avec mêmes arguments → même résultat (voir NIB-T §2.7).

---

## 5. Exemples

### 5.1 Erreur fatale (peu importe attempt/policy)

```ts
const err = new AuthError("401 Unauthorized");
const result = resolveRetryDecision(err, 0, {}, {
  maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60000
});
// result === { retry: false, reason: "fatal_auth" }

// Même résultat avec attempt=4, headers avec retry-after, etc.
const result2 = resolveRetryDecision(err, 4, { "retry-after": "10" }, {
  maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60000
});
// result2 === { retry: false, reason: "fatal_auth" }  — policy et headers ignorés
```

### 5.2 RateLimitError avec header `Retry-After`

```ts
const err = new RateLimitError("429 Too Many Requests");
const result = resolveRetryDecision(err, 0, { "retry-after": "10" }, {
  maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60000
});
// result === { retry: true, delayMs: 10000, reason: "transient_rate_limit" }
// (header prime sur backoff de 2000)
```

### 5.3 RateLimitError sans header → backoff

```ts
const err = new RateLimitError("429");
const result = resolveRetryDecision(err, 2, {}, {
  maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60000
});
// result === { retry: true, delayMs: 8000, reason: "transient_rate_limit" }
// (backoff = 2000 * 2^2 = 8000)
```

### 5.4 TimeoutError ignore `Retry-After`

```ts
const err = new TimeoutError("Internal timeout", { timeoutMs: 120000 });
const result = resolveRetryDecision(err, 2, { "retry-after": "999" }, {
  maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60000
});
// result === { retry: true, delayMs: 8000, reason: "transient_timeout" }
// (backoff, PAS 999000)
```

### 5.5 Budget épuisé

```ts
const err = new TransientProviderError("500");
const result = resolveRetryDecision(err, 4, {}, {
  maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60000
});
// attempt + 1 === maxAttempts → budget épuisé
// result === { retry: false, reason: "retry_exhausted" }
```

### 5.6 Erreur non classifiée (`transient_unknown`)

```ts
const err = new Error("weird");   // pas LLMRuntimeError
const result = resolveRetryDecision(err, 0, {}, {
  maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60000
});
// result === { retry: true, delayMs: 2000, reason: "transient_unknown" }
// L'engine émettra un event `llm_call_unknown_error_classified` (warn) au step 7.b
```

### 5.7 Backoff capé

```ts
const err = new TransientProviderError("503");
const result = resolveRetryDecision(err, 5, {}, {
  maxAttempts: 10, backoffBaseMs: 2000, maxBackoffMs: 60000
});
// backoff = min(2000 * 2^5, 60000) = min(64000, 60000) = 60000
// result === { retry: true, delayMs: 60000, reason: "transient_provider" }
```

### 5.8 `parseRetryAfter` formats

```ts
parseRetryAfter({ "retry-after": "10" })                    // 10000
parseRetryAfter({ "retry-after": "0" })                     // 0
parseRetryAfter({ "retry-after": "-5" })                    // undefined
parseRetryAfter({ "retry-after": "" })                      // undefined
parseRetryAfter({ "retry-after": "not-a-number" })          // undefined
parseRetryAfter({})                                         // undefined
parseRetryAfter({ "retry-after": "Wed, 21 Oct 2099 07:28:00 GMT" })  // ~ deltaMs vers futur
parseRetryAfter({ "retry-after": "Wed, 21 Oct 2000 07:28:00 GMT" })  // 0 (passé)
```

---

## 6. Edge cases

| Cas | Comportement attendu | Test |
| --- | --- | --- |
| `attempt === 0`, policy `maxAttempts = 1` | `attempt + 1 >= maxAttempts` → budget épuisé même au premier appel. Result : `retry_exhausted`. | T-RR-23 |
| `attempt >= maxAttempts` (par défensive) | Budget pas disponible → `retry_exhausted`. | T-RR-24 (attempt=5, maxAttempts=5) |
| Erreur est `undefined` ou `null` | Hors contrat — le caller doit toujours fournir une `Error`. Si passé quand même, TypeScript refuse ; runtime : comportement indéfini (fallback sur `transient_unknown` probablement). | Non testé (hors contrat) |
| Headers avec clé `"Retry-After"` (majuscules) | **Ne match pas** (invariant I-13 — clés en lowercase). L'engine normalise via `Object.fromEntries(response.headers.entries())` avant d'appeler le resolver. `parseRetryAfter` ne fait pas de lowercasing lui-même. | Contract invariant implicit |
| Headers vides `{}` | `parseRetryAfter` retourne `undefined` → fallback backoff. | T-RR-36 |
| `parseRetryAfter` retourne `0` | `0 ?? backoff` → `0` (nullish coalescing traite `0` comme défini). Le retry sera immédiat. | — |
| `policy.backoffBaseMs = 0` | `backoff` calcule `0 * 2^n = 0`, capé à `maxBackoffMs`. Valeur 0 valide (retry immédiat sans backoff). | — |
| `policy.maxBackoffMs < backoffBaseMs` | `Math.min` retourne toujours `maxBackoffMs`. Config discutable mais cohérente. | — |
| `LLMRuntimeError` sous-classe inconnue (théoriquement impossible) | Tombe dans la branche `transient_unknown` puisqu'aucun `instanceof` ne match. Défensif. | — |

---

## 7. Constraints (invariants spécifiques)

### C-RR1 — Pureté

`resolveRetryDecision` et `parseRetryAfter` sont des fonctions pures (modulo `clock.nowWall()` pour HTTP-date). Pas d'effet de bord observable, pas d'émission de log, pas d'accès réseau.

### C-RR2 — Seules 4 familles utilisent `parseRetryAfter`

`RateLimitError`, `OverloadedError`, `TransientProviderError`, **pas** `TimeoutError`. Cette règle est normative — elle empêche qu'un header `Retry-After` pollue une décision de retry sur timeout.

### C-RR3 — `delayMs` est toujours défini si `retry: true`

Jamais de `{ retry: true, delayMs: undefined }`. Soit `parseRetryAfter` retourne une valeur (y compris `0`), soit le fallback `backoff` retourne un nombre.

### C-RR4 — `reason` est une string discriminable

Les valeurs possibles de `reason` forment un ensemble fermé :
- Fatales : `fatal_auth`, `fatal_invalid_request`, `fatal_parse_error`, `fatal_content_filter`, `fatal_aborted`, `fatal_protocol`, `fatal_truncation`
- Retriables : `transient_rate_limit`, `transient_overloaded`, `transient_provider`, `transient_timeout`, `transient_unknown`
- Épuisé : `retry_exhausted`

Total : **13 valeurs**. Fermé en v1. Ajout = breaking change (impact sur logging/analytics consommateur).

### C-RR5 — Indépendance de `policy` et `headers` pour les fatales

Pour les 7 erreurs fatales, la décision est **indépendante** de `policy` et `headers`. Testable : P-RR-b avec 5 policies et 5 headers différents → même résultat.

### C-RR6 — Lecture headers en lowercase

`parseRetryAfter` lit exclusivement `headers["retry-after"]`. Aucun fallback sur d'autres casings. C'est l'engine qui garantit le lowercasing avant d'appeler le resolver (I-13 du NIB-S).

### C-RR7 — Pas de lookup dynamique sur `RETRIABLE_KINDS`

L'implémentation utilise des `instanceof` explicites (branches plates) plutôt qu'un lookup `RETRIABLE_KINDS.has(error.kind)`. Rationale : permet de traiter différemment `TimeoutError` (pas de `parseRetryAfter`) vs les 3 autres retriables. Utiliser `isRetriableKind` ici forcerait un second switch. L'alternative est écartée.

---

## 8. Integration (consommation par l'engine)

### 8.1 Depuis `executeCall` (NIB-M-EXECUTE-CALL)

```ts
// Step 7.b : au début de chaque attempt > 0 :
if (attempt > 0) {
  const retryDecision = resolveRetryDecision(lastError, attempt, lastHeaders, config.retry);

  // Warning observable pour erreurs non classifiées :
  if (retryDecision.reason === "transient_unknown") {
    logger.emit({
      eventType: "llm_call_unknown_error_classified",
      callId, provider, model, attempt, timestamp: clock.nowWallIso(),
      status: extractStatus(lastError),
      bodySnippet: extractBodySnippet(lastError),
      networkErrorKind: extractNetworkErrorKind(lastError),
      rawMessage: lastError.message
    });
  }

  if (retryDecision.retry === false) {
    // Enrichir + throw (voir NIB-M-EXECUTE-CALL + NIB-M-ERRORS §3.3)
    throw enrichError(lastError, { provider, model, callId, attempts: attempt });
  }

  // Log retry scheduled
  logger.emit({
    eventType: "llm_call_retry_scheduled",
    callId, provider, model, attempt, timestamp: clock.nowWallIso(),
    delayMs: retryDecision.delayMs!,
    reason: retryDecision.reason,
    errorKind: (lastError as LLMRuntimeError).kind ?? "unknown"
  });

  // Sleep interruptible
  try {
    await abortableSleep(retryDecision.delayMs!, externalSignal);
  } catch (e) {
    // Reclassement en AbortedError — voir NIB-M-SIGNAL-COMPOSER
    throw new AbortedError("Aborted during retry sleep", {
      cause: e, provider, model, callId, attempts: attempt
    });
  }
}
```

### 8.2 Depuis `executeEmbedding` (NIB-M-EXECUTE-EMBEDDING)

Même pattern, sur la boucle retry d'un batch.

---

## 9. Relationship avec les autres NIB-M

| NIB-M | Relation |
| --- | --- |
| **NIB-M-ERRORS** | Consomme les 11 sous-classes pour discriminer via `instanceof`. |
| **NIB-M-ERROR-KIND** | Cohérence : les 4 kinds retriables de `RETRIABLE_KINDS` doivent être exactement les 4 sous-classes qui ont `retry: true` dans la table (contract invariant C-EK3). `resolveRetryDecision` n'utilise pas directement `isRetriableKind` (cf. C-RR7). |
| **NIB-M-INFRA-UTILS** | Consomme `clock.nowWall()` pour `parseRetryAfter` HTTP-date. |
| **NIB-M-EXECUTE-CALL** | Appelle `resolveRetryDecision` au step 7.b. Émet les events `llm_call_retry_scheduled` et `llm_call_unknown_error_classified` selon la décision. |
| **NIB-M-EXECUTE-EMBEDDING** | Même usage que executeCall pour sa boucle retry. |

---

## 10. Tests de référence (NIB-T §2, §3)

| Zone | ID tests NIB-T |
| --- | --- |
| Erreurs fatales jamais retry (7 classes) | T-RR-01..07 |
| `RateLimitError` avec/sans header | T-RR-08..12 |
| `OverloadedError`, `TransientProviderError` | T-RR-13..16 |
| `TimeoutError` ignore `Retry-After` | T-RR-17..18 (T-RR-18 critique) |
| Budget épuisé (`retry_exhausted`) | T-RR-19..24 |
| Erreurs non classifiées (`transient_unknown`) | T-RR-25..28 |
| Backoff cap | T-RR-29..32 |
| `Retry-After` invalide/absent | T-RR-33..36 |
| Pureté | P-RR-a |
| Indépendance `policy`/`headers` pour fatales | P-RR-b |
| `parseRetryAfter` format seconds | T-PA-01..08 (NIB-T §3) |
| `parseRetryAfter` format HTTP-date | T-PA-09..16 (NIB-T §3) |

---

## 11. Implémentation cible

### 11.1 Fichier `src/services/retry-resolver.ts` (~100 LOC)

Contient les deux fonctions + le helper `backoff`. Import des 11 sous-classes de `LLMRuntimeError` depuis `../errors`. Import de `clock` depuis `./clock`.

La fonction `parseRetryAfter` est exportée au niveau module (pour tests unitaires dédiés NIB-T §3) **mais pas réexportée** depuis `src/index.ts` — elle n'est pas publique.

```ts
// src/services/retry-resolver.ts
import {
  AuthError, InvalidRequestError, RateLimitError, OverloadedError,
  TransientProviderError, ProviderProtocolError, ResponseParseError,
  TimeoutError, AbortedError, SilentTruncationError, ContentFilterError,
  LLMRuntimeError
} from "../errors/subclasses";
import type { RetryPolicy } from "../types/config";
import { clock } from "./clock";

export interface RetryDecision {
  retry: boolean;
  delayMs?: number;
  reason: string;
}

export function parseRetryAfter(headers: Record<string, string>): number | undefined {
  // ... voir §3
}

function backoff(attempt: number, policy: RetryPolicy): number {
  return Math.min(policy.backoffBaseMs * 2 ** attempt, policy.maxBackoffMs);
}

export function resolveRetryDecision(
  error: LLMRuntimeError | Error,
  attempt: number,
  headers: Record<string, string>,
  policy: RetryPolicy
): RetryDecision {
  // ... voir §4.4
}
```

---

*VegaCorp — Implicit-Free Execution (IFE) — "La fiabilité précède l'intelligence."*
