---
id: NIB-M-ERROR-KIND
type: nib-module
version: "1.0.0"
scope: llm-runtime
module: error-kind
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-M-ERROR-KIND — Module Brief — `LLMErrorKind` et `isRetriableKind`

**Package** : `@vegacorp/llm-runtime`
**Source NX** : §8.4 (Types et helpers d'erreur exportables)
**NIB-T associé** : §6 (Tests de `isRetriableKind`)

---

## 1. Purpose

Ce module définit deux artefacts publics minimaux mais contractuellement essentiels :

1. **`LLMErrorKind`** : union fermée des 11 valeurs possibles de `LLMRuntimeError.kind`, utilisée pour le logging, la sérialisation et la discrimination via `Set<LLMErrorKind>`.
2. **`isRetriableKind(kind)`** : helper pur qui indique si une famille d'erreur est **éligible au retry par nature** (propriété statique, indépendante du contexte courant).

La sémantique verrouillée de `isRetriableKind` est cruciale : elle exprime une **éligibilité statique par famille**, pas une décision contextuelle. Elle ne signifie **pas** qu'un retry va effectivement avoir lieu — cette décision contextuelle (budget disponible, etc.) dépend de `resolveRetryDecision` (voir NIB-M-RETRY-RESOLVER) et est tracée par l'event `llm_call_retry_scheduled`.

Cette distinction "nature vs décision courante" est citée comme note critique dans le NX (§8.4 et §11.3 du NX).

---

## 2. Inputs / Outputs

### 2.1 Consommé par ce module

- Aucun import externe au package.

### 2.2 Produit par ce module (exporté publiquement)

- **Type** : `LLMErrorKind` (union fermée de 11 string literals).
- **Constante interne** : `RETRIABLE_KINDS: ReadonlySet<LLMErrorKind>` (non exportée).
- **Fonction** : `isRetriableKind(kind: LLMErrorKind): boolean` (exportée publiquement).

### 2.3 Consommateurs

- **NIB-M-ERRORS** : chaque sous-classe concrète fixe son `kind` à une valeur de cette union via `readonly kind = "..." as const`.
- **NIB-M-RETRY-RESOLVER** : utilise `isRetriableKind` implicitement (via le mapping par famille). La table de décision de `resolveRetryDecision` peut être vérifiée cohérente avec `RETRIABLE_KINDS` par un test.
- **NIB-M-EXECUTE-CALL** : utilise `isRetriableKind(lastError.kind)` pour remplir le champ `retryable` de l'event `llm_call_provider_error` au step 7.k (§14.1 du NX).
- Le consommateur final : peut importer `isRetriableKind` pour raisonner sur les erreurs sans faire de `instanceof` chain.

---

## 3. Algorithme / contrats détaillés

### 3.1 Définition de `LLMErrorKind`

```ts
export type LLMErrorKind =
  | "auth"
  | "invalid_request"
  | "rate_limit"
  | "overloaded"
  | "transient_provider"
  | "provider_protocol"
  | "response_parse"
  | "timeout"
  | "aborted"
  | "silent_truncation"
  | "content_filter";
```

**Contraintes normatives** :
- Exactement **11 valeurs**, correspondant exactement aux 11 sous-classes concrètes de `LLMRuntimeError` (NIB-M-ERRORS §3.2).
- L'ordre des membres de l'union n'a pas de sémantique contractuelle, mais par convention on suit l'ordre de gravité croissante puis technique croissante (auth → invalid_request → rate_limit → overloaded → transient_provider → provider_protocol → response_parse → timeout → aborted → silent_truncation → content_filter).
- **Fermée en v1** : ajouter une valeur = breaking change (major bump) + ajout d'une sous-classe dans NIB-M-ERRORS + mise à jour de `RETRIABLE_KINDS` si pertinent.

### 3.2 Définition de `RETRIABLE_KINDS`

```ts
const RETRIABLE_KINDS: ReadonlySet<LLMErrorKind> = new Set([
  "rate_limit",
  "overloaded",
  "transient_provider",
  "timeout",
]);
```

**Contraintes normatives** :
- **Non exportée** (interne au module). Le consommateur passe par `isRetriableKind`.
- **Typée `ReadonlySet<LLMErrorKind>`** pour empêcher toute mutation et assurer le narrowing TypeScript.
- Les **4 valeurs** correspondent exactement aux familles d'erreur qui sont cochées "éligible au retry" dans la table §8.1 du NX et §10.1 (retry table).
- Un 5e membre (`"transient_unknown"`) **n'existe pas** dans `LLMErrorKind` — la reason `"transient_unknown"` est une propriété de `RetryDecision` (§10.1 NX), pas un `kind` d'erreur. Elle s'applique aux erreurs non classifiées (pas `LLMRuntimeError`) qui sont retried conservativement avec event warn.

**Liste complète des 11 kinds avec éligibilité retry (pour cohérence avec NIB-M-ERRORS §3.2)** :

| kind | Sous-classe concrète | Retriable par nature ? |
| --- | --- | --- |
| `"auth"` | `AuthError` | ❌ non |
| `"invalid_request"` | `InvalidRequestError` | ❌ non |
| `"rate_limit"` | `RateLimitError` | ✅ oui |
| `"overloaded"` | `OverloadedError` | ✅ oui |
| `"transient_provider"` | `TransientProviderError` | ✅ oui |
| `"provider_protocol"` | `ProviderProtocolError` | ❌ non |
| `"response_parse"` | `ResponseParseError` | ❌ non |
| `"timeout"` | `TimeoutError` | ✅ oui |
| `"aborted"` | `AbortedError` | ❌ non (voulu) |
| `"silent_truncation"` | `SilentTruncationError` | ❌ non |
| `"content_filter"` | `ContentFilterError` | ❌ non |

### 3.3 Définition de `isRetriableKind`

```ts
export const isRetriableKind = (kind: LLMErrorKind): boolean =>
  RETRIABLE_KINDS.has(kind);
```

**Contraintes normatives** :
- Fonction **pure**. Aucun effet de bord, aucune lecture d'état externe.
- Implémentation : lookup O(1) dans le `Set` statique `RETRIABLE_KINDS`.
- Retour `boolean` strict (pas `1/0`, pas `"yes"/"no"`).
- Sémantique verrouillée : **éligibilité par nature**. Indépendante du contexte d'exécution (attempt courant, policy retry, etc.).

---

## 4. Exemples

### 4.1 Usage du consommateur final

```ts
import { isRetriableKind, LLMRuntimeError } from "@vegacorp/llm-runtime";

try {
  await adapter.call(request);
} catch (err) {
  if (err instanceof LLMRuntimeError) {
    if (isRetriableKind(err.kind)) {
      console.warn(`Retriable error exhausted: ${err.kind}`);
      // Métrique "échec retriable" vs "échec fatal"
    } else {
      console.error(`Fatal error: ${err.kind}`);
    }
  }
}
```

### 4.2 Usage interne par l'engine (event `llm_call_provider_error`)

```ts
// NIB-M-EXECUTE-CALL step 7.k :
const lastError = binding.classifyError(signal);
logger.emit({
  eventType: "llm_call_provider_error",
  callId, provider, model, attempt, timestamp: clock.nowWallIso(),
  status: signal.status,
  semanticErrorKind: lastError.kind,
  retryable: isRetriableKind(lastError.kind)   // ← éligibilité statique
});
```

Note : `retryable: true` dans l'event **ne signifie pas** qu'un retry aura lieu. Il signifie que la famille d'erreur est de nature retriable. La décision effective (budget disponible) est matérialisée par l'event suivant `llm_call_retry_scheduled` si un retry a effectivement lieu.

### 4.3 Table de vérité exhaustive (11 entrées)

```ts
isRetriableKind("auth");                // false
isRetriableKind("invalid_request");     // false
isRetriableKind("rate_limit");          // true
isRetriableKind("overloaded");          // true
isRetriableKind("transient_provider");  // true
isRetriableKind("provider_protocol");   // false
isRetriableKind("response_parse");      // false
isRetriableKind("timeout");             // true
isRetriableKind("aborted");             // false
isRetriableKind("silent_truncation");   // false
isRetriableKind("content_filter");      // false
```

Ces 11 assertions forment la base des tests du NIB-T §6 (`T-EK-01` à `T-EK-11`).

---

## 5. Edge cases

| Cas | Comportement attendu | Test |
| --- | --- | --- |
| Appel avec une string hors union (`isRetriableKind("foo" as LLMErrorKind)`) | Retourne `false` (le `Set.has` ne trouve pas). TypeScript refuse le cast à `as LLMErrorKind`, mais le runtime ne throw pas. | Test défensif : P-EK-a |
| Appel avec `undefined` via cast | Retourne `false`. Pas de throw. | — |
| Appel sur `error.kind` quand l'erreur n'est pas une `LLMRuntimeError` (ex. `Error` brut) | Le typage empêche — `error.kind` n'existe pas sur `Error`. À utiliser uniquement après `instanceof LLMRuntimeError`. | — |
| Mutation tentée de `RETRIABLE_KINDS` | TypeScript empêche via `ReadonlySet`. Runtime : si le consommateur force via `as Set<...>`, comportement indéfini — hors scope. `RETRIABLE_KINDS` est non exportée de toute façon. | — |

---

## 6. Constraints (invariants spécifiques)

### C-EK1 — Cohérence avec les sous-classes

Les 11 valeurs de `LLMErrorKind` doivent correspondre **exactement** aux 11 valeurs de `kind` des sous-classes de `LLMRuntimeError` (NIB-M-ERRORS §3.2). Vérifiable par un test contractuel :

```ts
// Pseudo-test de cohérence :
const allKindsFromClasses = [
  new AuthError("").kind,
  new InvalidRequestError("").kind,
  // ... pour chaque sous-classe
].sort();

const allKindsFromUnion: LLMErrorKind[] = [
  "auth", "invalid_request", "rate_limit", "overloaded",
  "transient_provider", "provider_protocol", "response_parse",
  "timeout", "aborted", "silent_truncation", "content_filter"
].sort();

expect(allKindsFromClasses).toEqual(allKindsFromUnion);
```

### C-EK2 — Fermeture de l'union

Aucun `kind` ne peut apparaître dans le code runtime en dehors de l'union. Enforcement par TypeScript (le type `LLMErrorKind` est vérifié à tous les sites d'usage).

### C-EK3 — `RETRIABLE_KINDS` cohérent avec la table retry

Les 4 membres de `RETRIABLE_KINDS` (`"rate_limit"`, `"overloaded"`, `"transient_provider"`, `"timeout"`) doivent correspondre exactement aux types d'erreur qui ont une ligne `retry: true` dans la table §10.1 du NX. Vérifiable par un test contractuel qui compare les deux listes (cf. NIB-M-RETRY-RESOLVER).

### C-EK4 — Pureté de `isRetriableKind`

La fonction est pure. Testable sur 50+ appels avec mêmes inputs → mêmes outputs. Aucun effet de bord observable (pas d'allocation, pas de log).

### C-EK5 — `isRetriableKind` ne prend pas l'erreur

La fonction prend un `LLMErrorKind` (string), **pas** une `LLMRuntimeError`. Rationale : permet l'usage dans des contextes où seul le kind est disponible (sérialisation, logs, events), et évite les imports circulaires entre `errors` et `error-kind`.

---

## 7. Integration (comment les autres modules consomment ce module)

### 7.1 Depuis `NIB-M-ERRORS` (cohérence types)

Chaque sous-classe concrète de `LLMRuntimeError` fixe son `kind` à une valeur de l'union :

```ts
// NIB-M-ERRORS :
import { LLMErrorKind } from "./error-kind";

abstract class LLMRuntimeError extends Error {
  abstract readonly kind: LLMErrorKind;
  // ...
}

class RateLimitError extends LLMRuntimeError {
  readonly kind = "rate_limit" as const;  // ← doit être dans l'union
  // ...
}
```

Le `as const` fait le narrowing TypeScript au littéral exact, ce qui vérifie à la compilation que la valeur appartient à l'union.

### 7.2 Depuis `NIB-M-RETRY-RESOLVER`

La table de décision `resolveRetryDecision` discrimine les familles d'erreur qui sont retriables. Implémentation alternative idiomatique (non normative) : utiliser `isRetriableKind` pour la branche générique `if` au lieu d'une table explicite. Ce NIB-M ne contraint pas l'implémentation — la table §10.1 du NX reste la source de vérité.

### 7.3 Depuis `NIB-M-EXECUTE-CALL` (event `llm_call_provider_error`)

L'event `llm_call_provider_error` (§11.3 NX) porte un champ `retryable` qui est rempli par `isRetriableKind(lastError.kind)` au step 7.k (§14.1 NX). Ce champ exprime l'éligibilité statique — la décision effective (retry effectif) est tracée par l'event suivant `llm_call_retry_scheduled`.

---

## 8. Relationship avec les autres NIB-M

| NIB-M | Relation |
| --- | --- |
| **NIB-M-ERRORS** | `LLMErrorKind` est utilisé dans la signature `abstract readonly kind: LLMErrorKind`. Cohérence validée par test C-EK1. |
| **NIB-M-RETRY-RESOLVER** | Consomme `isRetriableKind` (ou reflète sa logique via la table de décision). Test contractuel de cohérence entre la table retry et `RETRIABLE_KINDS`. |
| **NIB-M-EXECUTE-CALL** | Utilise `isRetriableKind(lastError.kind)` au step 7.k pour remplir `retryable` dans l'event `llm_call_provider_error`. |

---

## 9. Tests de référence (NIB-T §6)

| Zone | ID tests NIB-T |
| --- | --- |
| `isRetriableKind("rate_limit") === true` | `T-EK-01` à `T-EK-04` (4 kinds retriables) |
| `isRetriableKind("auth") === false` | `T-EK-05` à `T-EK-11` (7 kinds non retriables) |
| Pureté (invocations répétées) | `P-EK-a` |
| Cohérence union ↔ sous-classes (C-EK1) | Contract invariant dans §21 du NIB-T |
| Cohérence `RETRIABLE_KINDS` ↔ table retry | Contract invariant dans §21 ou §2 du NIB-T |

---

## 10. Implémentation cible (fichier unique)

```ts
// src/errors/kind.ts

export type LLMErrorKind =
  | "auth"
  | "invalid_request"
  | "rate_limit"
  | "overloaded"
  | "transient_provider"
  | "provider_protocol"
  | "response_parse"
  | "timeout"
  | "aborted"
  | "silent_truncation"
  | "content_filter";

const RETRIABLE_KINDS: ReadonlySet<LLMErrorKind> = new Set([
  "rate_limit",
  "overloaded",
  "transient_provider",
  "timeout",
]);

export const isRetriableKind = (kind: LLMErrorKind): boolean =>
  RETRIABLE_KINDS.has(kind);
```

Taille cible : **~20 LOC** (types + Set + 1 ligne de fonction). La simplicité est un objectif normatif — toute complexité ajoutée à ce fichier devrait être challengée.

---

*VegaCorp — Implicit-Free Execution (IFE) — "La fiabilité précède l'intelligence."*
