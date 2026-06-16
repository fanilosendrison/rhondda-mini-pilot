---
id: NIB-M-THROTTLE
type: nib-module
version: "1.0.0"
scope: llm-runtime
module: throttle
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-M-THROTTLE — Module Brief — `resolveThrottleDecision` et `throttle-snapshot`

**Package** : `@vegacorp/llm-runtime`
**Source NX** : §5.5 (throttle-resolver + throttle-snapshot), §10.2 (ThrottleDecision, RateLimitSnapshot), §13.3 (état par adapter)
**NIB-T associé** : §4 (throttle-resolver), §5 (throttle-snapshot stateful)

---

## 1. Purpose

Ce module héberge la **logique de throttling proactif** du runtime. Il est composé de **deux sous-modules** distincts mais étroitement couplés :

1. **`throttle-resolver`** : fonction **pure** `resolveThrottleDecision(snapshot, estimatedTokens, nowMs)` → `ThrottleDecision`. Détermine, à partir d'un snapshot de rate limit, d'une estimation du coût en tokens du prochain call, et de l'heure monotone courante, si le call doit être throttlé et combien de temps attendre.
2. **`throttle-snapshot`** : service **stateful** par adapter. Encapsule un `RateLimitSnapshot | null` persisté entre calls d'un même adapter, et expose `get()` / `update(headers, lastOutputTokens)`.

Le throttling est **proactif** (anticipe les 429/529 en lisant les headers `x-ratelimit-*` retournés par les providers qui les exposent) et **défensif** (fonctionne en mode dégradé si le provider n'expose pas les headers, via `snapshot.state: "unknown"`).

La séparation pure/stateful est normative : `resolveThrottleDecision` est testable exhaustivement sans mock, tandis que `throttle-snapshot` encapsule les effets de bord de lecture/écriture du state par adapter.

---

## 2. Inputs / Outputs

### 2.1 Consommé par ce module

- **`RateLimitSnapshot`** (type canonique, défini §6.7 NIB-S).
- **`clock.nowMono()`** (NIB-M-INFRA-UTILS) — pour `resolveThrottleDecision` et `throttle-snapshot.update`.
- **`readRateLimitHeaders`** de chaque binding (L3) — consommé par `throttle-snapshot.update` pour parser les headers providers-spécifiques.

### 2.2 Produit par ce module

**Interne (non exporté publiquement)** :

- Fonction `resolveThrottleDecision(snapshot, estimatedTokens, nowMs): ThrottleDecision`.
- Factory `createThrottleSnapshotService(binding): ThrottleSnapshotService`.
- Types `ThrottleDecision`, `RateLimitSnapshot`, `ThrottleSnapshotService`.

```ts
type ThrottleDecision =
  | { readonly throttle: false; readonly reason: ThrottleDecisionReason }
  | { readonly throttle: true; readonly waitMs: number; readonly reason: ThrottleDecisionReason };

interface RateLimitSnapshot {
  remainingTokens: number;
  resetTokensAt: number;            // monotone ms
  lastCallOutputTokens: number;
  state: "known" | "partial" | "unknown";
}

interface ThrottleSnapshotService {
  get(): RateLimitSnapshot | null;
  update(headers: Record<string, string>, lastCallOutputTokens: number): void;
}
```

### 2.3 Consommateurs

- **NIB-M-EXECUTE-CALL** : appelle `snapshotService.get()` → `resolveThrottleDecision(snapshot, estimated, clock.nowMono())` au step 6.b avant chaque attempt. Appelle `snapshotService.update(headers, usage.outputTokens ?? 0)` après chaque réponse reçue (2xx ou 4xx/5xx avec headers).
- **NIB-M-EXECUTE-EMBEDDING** : même pattern pour sa boucle batch.
- **NIB-M-FACTORIES** : instancie un `ThrottleSnapshotService` par adapter à la création, le capture dans la closure de `adapter.call` / `adapter.embed`.

---

## 3. Algorithme — `resolveThrottleDecision`

### 3.1 Signature

```ts
function resolveThrottleDecision(
  snapshot: RateLimitSnapshot | null,
  estimatedTokens: number,
  nowMs: number
): ThrottleDecision;
```

**Entrée** :
- `snapshot` : `RateLimitSnapshot` courant ou `null` si aucun snapshot disponible (premier call, ou provider sans headers rate-limit).
- `estimatedTokens` : estimation du coût en tokens du call à venir (obtenu via NIB-M-TOKEN-ESTIMATOR).
- `nowMs` : `clock.nowMono()` au moment de la décision.

**Sortie** : `ThrottleDecision` avec :
- `throttle: boolean`
- `waitMs?: number` (uniquement si `throttle === true`)
- `reason: string`

### 3.2 Table de décision

| Condition | Décision | `reason` | Application |
| --- | --- | --- | --- |
| `snapshot === null` | `{ throttle: false, reason: "no_snapshot" }` | Premier call, ou provider sans headers | T-TR-01 |
| `snapshot.state === "unknown"` | `{ throttle: false, reason: "snapshot_unknown" }` | Provider expose partiellement les headers mais on n'a rien de fiable | T-TR-02 |
| `estimatedTokens <= snapshot.remainingTokens` | `{ throttle: false, reason: "budget_ok" }` | Budget suffisant | T-TR-03 |
| `estimatedTokens > snapshot.remainingTokens` ET `nowMs >= snapshot.resetTokensAt` | `{ throttle: false, reason: "reset_passed" }` | Budget insuffisant mais la fenêtre de reset est déjà passée | T-TR-04 |
| `estimatedTokens > snapshot.remainingTokens` ET `nowMs < snapshot.resetTokensAt` | `{ throttle: true, waitMs: snapshot.resetTokensAt - nowMs, reason: "tokens_depleted" }` | Budget épuisé, attendre le reset | T-TR-05 |

### 3.3 Pseudocode

```ts
function resolveThrottleDecision(
  snapshot: RateLimitSnapshot | null,
  estimatedTokens: number,
  nowMs: number
): ThrottleDecision {
  if (snapshot === null) {
    return { throttle: false, reason: "no_snapshot" };
  }
  if (snapshot.state === "unknown") {
    return { throttle: false, reason: "snapshot_unknown" };
  }
  if (estimatedTokens <= snapshot.remainingTokens) {
    return { throttle: false, reason: "budget_ok" };
  }
  // Budget insuffisant
  if (nowMs >= snapshot.resetTokensAt) {
    return { throttle: false, reason: "reset_passed" };
  }
  return {
    throttle: true,
    waitMs: snapshot.resetTokensAt - nowMs,
    reason: "tokens_depleted"
  };
}
```

### 3.4 Règles clés

**R-1 — `snapshot.state: "partial"` NE bloque PAS la décision**.

Si `state === "partial"`, on dispose quand même de `remainingTokens` (potentiellement imparfait) et de `resetTokensAt`. Le resolver applique la même logique qu'en `"known"`. La valeur `partial` est informative (typiquement quand on a `remainingTokens` mais pas de `reset_at`, ou l'inverse — un binding peut interpoler).

**R-2 — `waitMs` toujours strictement positif si throttle**.

La branche `nowMs < snapshot.resetTokensAt` garantit `snapshot.resetTokensAt - nowMs > 0`. Si `nowMs >= snapshot.resetTokensAt`, on tombe dans `"reset_passed"`. Pas de `waitMs: 0` avec `throttle: true`.

**R-3 — Pureté stricte**.

`resolveThrottleDecision` est pure. Pas d'accès réseau, pas de log, pas de mutation. Testable exhaustivement par table de vérité.

**R-4 — `resetTokensAt` en ms monotone**.

La comparaison `nowMs >= snapshot.resetTokensAt` n'a de sens que si les deux valeurs utilisent la **même horloge**. Par convention, `resetTokensAt` est stocké en ms monotone (obtenu de `clock.nowMono() + deltaMs` où `deltaMs` vient du parsing de `x-ratelimit-reset-tokens` au moment de l'update — voir §4).

**R-5 — `reason` est un ensemble fermé**.

Les 5 valeurs possibles (`no_snapshot`, `snapshot_unknown`, `budget_ok`, `reset_passed`, `tokens_depleted`) forment un ensemble fermé. Ajout = breaking observable (consommateur peut logger la raison).

---

## 4. Algorithme — `throttle-snapshot` (stateful)

### 4.1 Cycle de vie

Un `ThrottleSnapshotService` est **instancié par adapter** au moment de la factory. Il capture :
- L'instance du `ProviderBinding` ou `EmbeddingBinding` (pour accéder à `binding.readRateLimitHeaders` et `binding.quirks.hasRateLimitHeaders`).
- Une variable locale `snapshot: RateLimitSnapshot | null`, initialement `null`.

Sa durée de vie = durée de vie de l'adapter (typiquement toute la session du process pour l'adapter correspondant).

Scope : **process-local**, lié à **une instance d'adapter**. Pas de partage entre adapters (même si ils pointent vers le même provider avec le même `apiKey` — c'est une limitation documentée §13.3 NX, hors scope v1).

### 4.2 Interface

```ts
interface ThrottleSnapshotService {
  get(): RateLimitSnapshot | null;
  update(headers: Record<string, string>, lastCallOutputTokens: number): void;
}
```

### 4.3 `get()` — lecture

Lecture simple, retourne la valeur courante de la variable interne `snapshot`. Pas de cloning — le resolver **ne doit pas muter** l'objet retourné (convention, pas enforcement runtime).

### 4.4 `update(headers, lastCallOutputTokens)` — écriture

**Appelée après chaque réponse HTTP reçue** par l'engine, que le call ait été 2xx ou 4xx/5xx. Raison : les providers exposent les headers `x-ratelimit-*` même sur des réponses d'erreur (ex. 429 Anthropic vient souvent avec des headers rate-limit à jour).

**Appelée également après un 429 ou 529** pour rafraîchir le snapshot. L'engine appelle `update` après `classifyError` dans la branche d'erreur HTTP (§14.1 step 7.h du NX).

**Pseudocode** :

```ts
function update(headers: Record<string, string>, lastCallOutputTokens: number): void {
  if (!binding.quirks.hasRateLimitHeaders) {
    // Provider ne supporte pas du tout les headers rate-limit
    // Exemple : google gemini v1 ne les expose pas de manière fiable
    snapshot = null;   // ou laisser l'ancien snapshot si on en avait un ? Voir R-6.
    return;
  }

  const parsed = binding.readRateLimitHeaders(headers);
  if (parsed === null) {
    // Headers absents de cette réponse spécifique (ex. 401 auth error sans rate-limit)
    // Ne pas écraser un snapshot existant avec null — préserver l'info précédente
    return;
  }

  snapshot = {
    remainingTokens: parsed.remainingTokens,
    resetTokensAt: parsed.resetTokensAt,
    lastCallOutputTokens,
    state: parsed.state
  };
}
```

### 4.5 Règles clés

**R-6 — `readRateLimitHeaders` retourne `null` n'écrase pas le snapshot existant**.

Si un binding supporte les headers rate-limit mais qu'une réponse spécifique n'en a pas (ex. erreur 401 sans headers), on **garde** le snapshot précédent. Rationale : la dernière information valide reste pertinente tant qu'on n'a pas mieux.

**R-7 — `lastCallOutputTokens: 0` si usage absent**.

Lorsque l'engine appelle `update`, il passe `usage.outputTokens ?? 0`. Le snapshot capture cette valeur pour d'éventuelles estimations futures (non utilisée dans `resolveThrottleDecision` v1, mais tracée pour debug/future).

**R-8 — Conversion `resetTokensAt` au moment du parse**.

Le binding (`readRateLimitHeaders`) lit le header `x-ratelimit-reset-tokens` (format variable selon le provider : delta secondes, delta ms, timestamp Unix, timestamp ISO). Le binding **convertit** en **ms monotone relatif à `clock.nowMono()` au moment du parse**. Cette conversion se fait à l'update, pas à la lecture.

Format cible dans `RateLimitSnapshot.resetTokensAt` : **ms monotone**, comparable directement avec `clock.nowMono()`.

**R-9 — `state: "known" | "partial" | "unknown"`** :

- `"known"` : tous les headers attendus sont présents et parsables → snapshot complet.
- `"partial"` : certains headers manquent mais on dispose d'assez pour une décision (ex. `remainingTokens` présent mais pas `reset_at` → le binding interpole un reset par défaut, ou inversement).
- `"unknown"` : headers absents, incohérents, ou non parseables → snapshot non fiable, resolver short-circuit en `snapshot_unknown`.

Le mapping exact `state ∈ {known, partial, unknown}` est décidé par chaque binding (NIB-M-BINDINGS-COMPLETION §4 par binding).

### 4.6 Pas de persistance cross-process

Le snapshot vit en mémoire du process. Aucune persistance disque/DB. Si le process redémarre, le snapshot est perdu — le prochain call part avec `snapshot === null` → `no_snapshot` → pas de throttle → risque de 429 → retry kick in.

Accepté en v1. Extension future (persistance cross-process, coordination distribuée) = NX séparé.

---

## 5. Exemples

### 5.1 Premier call de l'adapter

```ts
const snapshotService = createThrottleSnapshotService(anthropicBinding);
snapshotService.get();  // null (initial)

const decision = resolveThrottleDecision(null, 1000, clock.nowMono());
// { throttle: false, reason: "no_snapshot" }
// → engine fait le call sans attente
```

### 5.2 Après une réponse 200 avec headers

```ts
// Response 200 Anthropic avec :
// anthropic-ratelimit-tokens-remaining: 8000
// anthropic-ratelimit-tokens-reset: 2026-04-17T14:35:00Z  (dans 60s)
snapshotService.update(responseHeaders, 500);

snapshotService.get();
// {
//   remainingTokens: 8000,
//   resetTokensAt: <nowMono + 60000 approximatif>,
//   lastCallOutputTokens: 500,
//   state: "known"
// }
```

### 5.3 Call suivant, budget OK

```ts
const snapshot = snapshotService.get();
const now = clock.nowMono();

const decision = resolveThrottleDecision(snapshot, 2000, now);
// { throttle: false, reason: "budget_ok" }  (2000 <= 8000)
```

### 5.4 Call suivant, budget épuisé avant reset

```ts
// Snapshot a été mis à jour à 50 tokens restants, reset dans 30s
snapshotService.update(lowBudgetHeaders, 400);

const now = clock.nowMono();  // T
const snapshot = snapshotService.get();
// snapshot.remainingTokens = 50
// snapshot.resetTokensAt = T + 30000

const decision = resolveThrottleDecision(snapshot, 1000, now);
// { throttle: true, waitMs: 30000, reason: "tokens_depleted" }
// → engine sleep 30s avant le prochain fetch
```

### 5.5 Reset déjà passé

```ts
const now = clock.nowMono();  // T = 100000
const snapshot = {
  remainingTokens: 0,
  resetTokensAt: 90000,         // T - 10s (déjà passé)
  lastCallOutputTokens: 500,
  state: "known"
};

const decision = resolveThrottleDecision(snapshot, 2000, now);
// { throttle: false, reason: "reset_passed" }
// → engine fait le call (l'info est stale, on retente)
```

### 5.6 Provider sans headers

```ts
// Binding Google Gemini v1 : quirks.hasRateLimitHeaders = false
const snapshotService = createThrottleSnapshotService(googleBinding);

snapshotService.update(googleHeaders, 500);
// update est no-op, snapshot reste null

const decision = resolveThrottleDecision(null, 5000, clock.nowMono());
// { throttle: false, reason: "no_snapshot" }
// → pas de throttle, on se repose sur retry réactif en cas de 429
```

### 5.7 Snapshot `partial`

```ts
// OpenAI expose `x-ratelimit-remaining-tokens` mais ne donne parfois pas `x-ratelimit-reset-tokens`
// Le binding OpenAI décide : state = "partial", resetTokensAt = nowMono + 60000 (fallback conservateur)
snapshotService.update(openaiPartialHeaders, 200);

const snapshot = snapshotService.get();
// snapshot.state === "partial"
// snapshot.remainingTokens = 500
// snapshot.resetTokensAt = nowMono + 60000 (interpolé)

const decision = resolveThrottleDecision(snapshot, 1000, clock.nowMono());
// Même logique qu'en "known" : 1000 > 500 → tokens_depleted → waitMs ~= 60000
```

---

## 6. Edge cases

| Cas | Comportement attendu | Test |
| --- | --- | --- |
| `estimatedTokens === 0` | Toujours `budget_ok` (0 <= remainingTokens par définition, même si remainingTokens = 0). | T-TR-XX |
| `snapshot.remainingTokens === 0` ET `estimatedTokens === 0` | `{ throttle: false, reason: "budget_ok" }` (0 <= 0). | — |
| `snapshot.remainingTokens === 0` ET `estimatedTokens === 1` | Si `nowMs < resetTokensAt` → throttle. Sinon → `reset_passed`. | — |
| `snapshot.resetTokensAt === nowMs` exactement | `nowMs >= resetTokensAt` → `reset_passed` (pas de throttle). | — |
| Mise à jour avec headers vides `{}` | `readRateLimitHeaders({})` retourne `null` → update no-op (préserve snapshot existant). | T-TS-XX |
| `update` appelée avec `hasRateLimitHeaders: false` | No-op strict (`snapshot` reste ce qu'il était — voir R-6 pour subtilité). Par cohérence avec R-6 : si jamais on passe d'un binding à un autre en changeant les quirks (impossible v1), l'ancien snapshot pourrait rester. Non réaliste. | — |
| Deux adapters avec le même `apiKey`, même provider | Chacun a son `ThrottleSnapshotService` isolé. Pas de partage. Limitation documentée §13.3 NX. | — |
| `update` appelée en concurrence (plusieurs calls en parallèle sur le même adapter) | V1 n'implémente pas de verrou. Dernière mise à jour gagne. Les calls simultanés peuvent lire des snapshots incohérents. Accepté en v1 (calls concurrents sont un cas dégradé, throttle approximatif). | — |

---

## 7. Constraints (invariants spécifiques)

### C-TR1 — Pureté de `resolveThrottleDecision`

Fonction pure stricte. Pas d'accès `clock`, pas de log. Testable exhaustivement par table de vérité.

### C-TR2 — Isolation par adapter

Chaque `ThrottleSnapshotService` est lié à une instance d'adapter. Testable : créer deux adapters, faire un call sur le premier, vérifier que le second a toujours `snapshot === null`.

### C-TR3 — `update` ne déclenche pas de décision

`update` met à jour le state, **ne décide pas**. La décision est prise par `resolveThrottleDecision` au step 6.b du flow executeCall. Séparation stricte lecture/écriture vs décision.

### C-TR4 — Resource non-exposée

`RateLimitSnapshot` et `ThrottleDecision` ne sont **pas exportés** publiquement. Le consommateur ne manipule jamais directement ces types. Enforcement : absence de re-export depuis `src/index.ts`.

### C-TR5 — `waitMs` monotone-cohérent

Le calcul `resetTokensAt - nowMs` produit un delta **en ms monotone**. Ce delta est ensuite utilisé comme argument de `abortableSleep` (NIB-M-SIGNAL-COMPOSER) qui utilise `AbortSignal.timeout` — ce dernier utilise aussi l'horloge monotone interne de Node. Cohérence garantie.

### C-TR6 — Pas de jitter sur `waitMs`

`waitMs` est calculé directement sans jitter aléatoire. Cohérent avec l'invariant "pas de jitter" de la §2.2 du NIB-S (hors scope v1).

### C-TR7 — Headers lowercase

Comme `parseRetryAfter`, `readRateLimitHeaders` lit les headers en **clés lowercase** (I-13). L'engine normalise avant d'appeler `update`.

---

## 8. Integration (consommation par l'engine)

### 8.1 Depuis la factory (NIB-M-FACTORIES)

```ts
// NIB-M-FACTORIES — createAnthropicAdapter :
const binding = new AnthropicBinding();
const snapshotService = createThrottleSnapshotService(binding);
// ... captured in closure of adapter.call
```

### 8.2 Depuis `executeCall` (NIB-M-EXECUTE-CALL)

**Step 3 — Charger le snapshot actuel** :

```ts
let snapshot = snapshotService.get();
```

**Step 6.b — Avant chaque fetch (dans la boucle attempt)** :

```ts
const estimated = estimateCallTokens(request, config.model);
const throttleDecision = resolveThrottleDecision(snapshot, estimated, clock.nowMono());

if (throttleDecision.throttle) {
  logger.emit({
    eventType: "llm_call_throttled",
    callId, provider, model, attempt, timestamp: clock.nowWallIso(),
    waitMs: throttleDecision.waitMs!,
    reason: throttleDecision.reason,
    snapshotState: snapshot?.state ?? "none",
    estimatedTokens: estimated
  });

  try {
    await abortableSleep(throttleDecision.waitMs!, externalSignal);
  } catch (e) {
    throw new AbortedError("Aborted during throttle wait", {
      cause: e, provider, model, callId, attempts: attempt
    });
  }
}
```

**Step 7.h / 7.i / 7.j — Après réception HTTP (succès ou erreur)** :

```ts
// Update snapshot with latest headers
snapshotService.update(responseHeaders, parsed.usage.outputTokens ?? 0);
snapshot = snapshotService.get();   // relecture pour la prochaine itération
```

---

## 9. Relationship avec les autres NIB-M

| NIB-M | Relation |
| --- | --- |
| **NIB-M-INFRA-UTILS** | Consomme `clock.nowMono()` pour update et decision. |
| **NIB-M-TOKEN-ESTIMATOR** | Fournit `estimatedTokens` pour `resolveThrottleDecision`. |
| **NIB-M-BINDINGS-COMPLETION** / **NIB-M-BINDING-EMBEDDING** | Chaque binding implémente `readRateLimitHeaders` et `quirks.hasRateLimitHeaders`. Le service délègue au binding pour le parsing provider-spécifique. |
| **NIB-M-SIGNAL-COMPOSER** | `abortableSleep` consommé par l'engine pour attendre `throttleDecision.waitMs` de manière interruptible. |
| **NIB-M-EXECUTE-CALL** / **NIB-M-EXECUTE-EMBEDDING** | Orchestrateurs principaux : chargent snapshot, appellent resolver, mettent à jour, loggent event. |
| **NIB-M-FACTORIES** | Instancie `ThrottleSnapshotService` par adapter. |

---

## 10. Tests de référence (NIB-T §4, §5)

| Zone | ID tests NIB-T |
| --- | --- |
| Table de décision (5 branches) | T-TR-01..05 |
| Pureté | P-TR-a |
| Edge cases (0 tokens, égalité nowMs = resetAt) | T-TR-XX |
| `snapshot.state === "partial"` comporte comme `"known"` | T-TR-XX |
| Snapshot vide au démarrage | T-TS-01 |
| `update` avec headers valides | T-TS-02 |
| `update` avec headers sans rate-limit (ne pas écraser) | T-TS-03 |
| Isolation par adapter | T-TS-04 |
| `hasRateLimitHeaders: false` → update no-op | T-TS-05 |

---

## 11. Implémentation cible

### 11.1 Fichier `src/services/throttle-resolver.ts` (~40 LOC)

```ts
import type { RateLimitSnapshot, ThrottleDecision } from "../types/canonical";

export function resolveThrottleDecision(
  snapshot: RateLimitSnapshot | null,
  estimatedTokens: number,
  nowMs: number
): ThrottleDecision {
  if (snapshot === null) {
    return { throttle: false, reason: "no_snapshot" };
  }
  if (snapshot.state === "unknown") {
    return { throttle: false, reason: "snapshot_unknown" };
  }
  if (estimatedTokens <= snapshot.remainingTokens) {
    return { throttle: false, reason: "budget_ok" };
  }
  if (nowMs >= snapshot.resetTokensAt) {
    return { throttle: false, reason: "reset_passed" };
  }
  return {
    throttle: true,
    waitMs: snapshot.resetTokensAt - nowMs,
    reason: "tokens_depleted"
  };
}
```

### 11.2 Fichier `src/services/throttle-snapshot.ts` (~35 LOC)

```ts
import type { ProviderBinding, EmbeddingBinding } from "../types/canonical";
import type { RateLimitSnapshot } from "../types/canonical";

export interface ThrottleSnapshotService {
  get(): RateLimitSnapshot | null;
  update(headers: Record<string, string>, lastCallOutputTokens: number): void;
}

export function createThrottleSnapshotService(
  binding: Pick<ProviderBinding | EmbeddingBinding, "readRateLimitHeaders" | "quirks">
): ThrottleSnapshotService {
  let snapshot: RateLimitSnapshot | null = null;

  return {
    get: () => snapshot,
    update: (headers, lastCallOutputTokens) => {
      if (!binding.quirks.hasRateLimitHeaders) return;

      const parsed = binding.readRateLimitHeaders(headers);
      if (parsed === null) return;  // Préserve snapshot existant

      snapshot = {
        remainingTokens: parsed.remainingTokens,
        resetTokensAt: parsed.resetTokensAt,
        lastCallOutputTokens,
        state: parsed.state,
      };
    }
  };
}
```

**Taille cible** : ~75 LOC cumulés (40 + 35). Cohérent avec l'étiquette "service transverse simple".

---

*VegaCorp — Implicit-Free Execution (IFE) — "La fiabilité précède l'intelligence."*
