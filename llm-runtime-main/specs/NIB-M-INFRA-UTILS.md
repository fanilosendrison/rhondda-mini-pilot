---
id: NIB-M-INFRA-UTILS
type: nib-module
version: "1.0.0"
scope: llm-runtime
module: infra-utils
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-M-INFRA-UTILS — Module Brief — Utilitaires techniques (clock, callId-generator, logger)

**Package** : `@vegacorp/llm-runtime`
**Source NX** : §5.5 (Layer 4 — Transverse Services), §9.6 (LoggingPolicy), §11 (Observabilité), §12 (Modèle temporel)
**NIB-T associé** : §23 (Contract invariants — temporel), §22 (Contract invariants — observabilité)

---

## 1. Purpose

Ce module regroupe **trois utilitaires techniques indépendants mais triviaux**, tous de Layer 4, qui partagent le statut commun "petit, isolé, mockable pour tests" :

1. **`clock`** — abstraction pour l'accès à l'horloge murale (`new Date()`) et monotone (`performance.now()`). Permet le mock en test.
2. **`callId-generator`** — génération d'un ULID par call via la lib `ulid`. Unique par call de completion ou d'embedding.
3. **`logger`** — default logger (NDJSON stderr) + interface `LLMLogger` pour injection.

Le regroupement est motivé par la petite taille de chaque sous-module (< 30 LOC) et leur rôle commun d'infrastructure technique consommée par l'engine sans logique métier. Chacun reste dans son fichier dédié (conventions §10.5 du NIB-S) mais partage ce NIB-M.

---

## 2. Inputs / Outputs

### 2.1 Consommé par ce module

- **`clock`** : API standard Node `Date`, `performance.now()`.
- **`callId-generator`** : lib externe `ulid` (version `^2.x`, pas de Dependency Contract — API triviale `ulid() => string`).
- **`logger`** : API standard Node `process.stderr`.
- Type `LLMEvent` (union discriminée) défini dans NIB-S §8.2 — consommé par l'interface `LLMLogger`.

### 2.2 Produit par ce module

**Exporté publiquement** :
- **Interface** `LLMLogger` (consommée par `LoggingPolicy.logger`).
- Aucun autre export public pour `clock` et `callId-generator` (internes, consommés uniquement par l'engine et les services).

**Interne (non exporté)** :
- Constante `clock` (objet avec méthodes `nowWall`, `nowWallIso`, `nowMono`).
- Fonction `generateCallId()`.
- Fonction `createDefaultLogger()`.

### 2.3 Consommateurs

- **NIB-M-EXECUTE-CALL** : consomme `clock.nowWallIso()`, `clock.nowMono()`, `generateCallId()`, le logger courant (via `LoggingPolicy`).
- **NIB-M-EXECUTE-EMBEDDING** : idem.
- **NIB-M-RETRY-RESOLVER** : consomme `clock.nowWall()` pour `parseRetryAfter` (format HTTP-date).
- **NIB-M-THROTTLE** : consomme `clock.nowMono()` pour `resolveThrottleDecision` et la gestion du snapshot.
- **NIB-M-SIGNAL-COMPOSER** : consomme `clock.nowMono()` indirectement via `AbortSignal.timeout` natif (utilise sa propre horloge monotone).

---

## 3. Algorithme / contrats détaillés

### 3.1 `clock`

**Fichier** : `src/services/clock.ts`

#### 3.1.1 Interface

```ts
export const clock = {
  nowWall: (): Date => new Date(),
  nowWallIso: (): string => new Date().toISOString(),
  nowMono: (): number => performance.now(),
};
```

**Contraintes normatives** :
- **Objet simple**, pas une classe. Permet le **mock facile** via réassignation ou spy.
- Les trois méthodes sont **stateless** (pas de state interne).
- `nowWall()` retourne une nouvelle `Date` à chaque appel — pas de cache.
- `nowWallIso()` est un helper d'ergonomie équivalent à `clock.nowWall().toISOString()`. Rationale : 90% des appels dans le runtime veulent une string ISO, pas une `Date`.
- `nowMono()` retourne un `number` en millisecondes **monotone** (jamais négatif relativement à un point d'origine du process, immune aux clock jumps).

#### 3.1.2 Règles d'usage

**Utilisation obligatoire de `nowWall`/`nowWallIso`** :
- `LLMResponse.startedAt` (step 2 de NIB-M-EXECUTE-CALL)
- `LLMResponse.endedAt` (step 7.r)
- Tous les `timestamp` des 14 events d'observabilité

**Utilisation obligatoire de `nowMono`** :
- `LLMResponse.durationMs` : calculé comme `Math.round(clock.nowMono() - startMono)`
- Retry delays (addition ou comparaison monotone)
- Throttle wait times (`snapshot.resetTokensAt - nowMs`)
- Timeouts internes (déclenchés via `AbortSignal.timeout`, qui utilise sa propre horloge monotone — cohérent)
- `RateLimitSnapshot.resetTokensAt` : stocké en **ms monotone**, pas en wall clock

**Mélange interdit** : ne jamais comparer un `nowMono()` avec un `nowWall().getTime()`. Ils n'ont pas la même origine.

#### 3.1.3 Mock en test

En test, le module `clock` est remplacé par un mock contrôlable :

```ts
// tests/helpers/mock-clock.ts :
export function createMockClock(initialWallMs: number, initialMonoMs: number) {
  let wall = initialWallMs;
  let mono = initialMonoMs;
  return {
    advance: (ms: number) => { wall += ms; mono += ms; },
    advanceWall: (ms: number) => { wall += ms; },          // pour tester clock jump
    advanceMono: (ms: number) => { mono += ms; },
    setWall: (ms: number) => { wall = ms; },
    nowWall: () => new Date(wall),
    nowWallIso: () => new Date(wall).toISOString(),
    nowMono: () => mono,
  };
}
```

La discipline du mock : **toutes les opérations temporelles du runtime doivent passer par `clock`**. Aucun code production ne peut appeler directement `Date.now()`, `new Date()`, ou `performance.now()` en dehors de ce module (enforcement par convention — test potentiel d'AST).

### 3.2 `callId-generator`

**Fichier** : `src/services/callId-generator.ts`

#### 3.2.1 Interface

```ts
import { ulid } from "ulid";

export function generateCallId(): string {
  return ulid();
}
```

**Contraintes normatives** :
- Utilise la lib externe `ulid` (`^2.x`, ~2 KB, zéro sous-dépendance).
- Retourne une string au format ULID (26 caractères Crockford Base32, ex. `01J9ZT5H3G8NK2M4X9YZQRT7AB`).
- Unique par call : chaque invocation produit un ULID différent (même dans la même milliseconde, grâce à l'entropie 80 bits).
- **Triable lexicographiquement = triable chronologiquement** (timestamp embarqué dans les 48 premiers bits).

#### 3.2.2 Rationale du choix ULID

Documenté dans le NX §5.5 :
- ULID vs UUID v4 : UUID v4 n'est **pas** triable.
- ULID vs UUID v7 : UUID v7 n'est **pas encore** standard largement supporté.
- ULID vs nanoid : nanoid n'embarque **pas** de timestamp.

#### 3.2.3 Testabilité

La fonction est non déterministe (génère une valeur différente à chaque appel). Pour les tests qui ont besoin d'un callId prévisible, on mocke l'import :

```ts
// tests/engine/execute-call-happy-path.test.ts :
vi.mock("../../src/services/callId-generator", () => ({
  generateCallId: () => "01J9ZT5H3G8NK2M4X9YZQRT7AB"  // fixed ULID for deterministic assertion
}));
```

Pattern alternatif : injecter `generateCallId` comme paramètre dans les factories ou l'engine. **Non retenu en v1** pour préserver une signature simple `executeCall(request, binding, config)` — le mock via module replacement est suffisant.

### 3.3 `logger`

**Fichier** : `src/services/logger.ts`

#### 3.3.1 Interface `LLMLogger` (exportée publiquement)

```ts
export interface LLMLogger {
  emit(event: LLMEvent): void;
}
```

**Contraintes normatives** :
- Unique méthode : `emit(event: LLMEvent)`. Pas de niveau (debug/info/warn/error) — le niveau est implicite dans le `eventType` (ex. `llm_call_unknown_error_classified` est un warn).
- Retour `void`. L'émission est **fire-and-forget** ; les erreurs internes au logger (ex. stderr cassé) ne remontent pas à l'engine.
- Le paramètre `event: LLMEvent` est la union discriminée définie dans NIB-S §8.2.

#### 3.3.2 Default logger (NDJSON stderr)

```ts
export function createDefaultLogger(): LLMLogger {
  return {
    emit(event: LLMEvent): void {
      try {
        const line = JSON.stringify(event) + "\n";
        process.stderr.write(line);
      } catch {
        // Swallow — logger failures never break the runtime.
        // En cas d'erreur (ex. event contenant un objet non sérialisable), on perd silencieusement l'event.
      }
    }
  };
}
```

**Contraintes normatives** :
- **Canal** : `process.stderr` (jamais stdout).
- **Format** : NDJSON / JSONL — un objet JSON par ligne, séparateur `\n` (LF).
- **Encodage** : UTF-8 (par défaut de Node).
- **Robustesse** : les failures de sérialisation ou d'écriture sont silenced via `try/catch` vide. Rationale : un logger défaillant ne doit jamais casser un call LLM en cours.
- **Synchrone** : `process.stderr.write` peut être bloquant ou non selon le canal en aval. Accepté en v1.

#### 3.3.3 Résolution du logger courant par l'engine

L'engine détermine quel logger utiliser via la sémantique suivante (selon `LoggingPolicy` de l'`AdapterConfig`) :

```ts
// Dans l'adapter factory (NIB-M-FACTORIES) :
function resolveLogger(policy: LoggingPolicy): LLMLogger {
  if (policy.enabled === false) {
    return createNoopLogger();
  }
  return policy.logger ?? createDefaultLogger();
}

function createNoopLogger(): LLMLogger {
  return { emit: () => { /* noop */ } };
}
```

**Règle critique (§9.6 du NX)** : `enabled === false` **coupe toute émission**, y compris vers un logger injecté. Un consommateur qui injecte un logger custom mais met `enabled: false` ne recevra rien. Sémantique single-switch — un seul cran de désactivation.

Pour une désactivation partielle (certains events filtrés), le logger injecté filtre lui-même. Ce n'est pas la responsabilité de la policy.

#### 3.3.4 Contraintes PII (I-12 du NIB-S)

Le logger ne **sait pas** ce qu'est une PII — c'est la responsabilité des **émetteurs** (engine, bindings) de ne pas mettre de PII dans les events. Ce NIB-M ne filtre rien.

Exception contrôlée : `llm_call_sanitized` peut contenir `rawContentPreview?: string` (500 chars max) — cette inclusion est décidée par l'engine au step 7.n (NIB-M-EXECUTE-CALL) selon des règles précises (voir §11.5 NX).

---

## 4. Exemples

### 4.1 `clock` — utilisation par l'engine

```ts
// Extrait NIB-M-EXECUTE-CALL step 2-3 :
const startedAt = clock.nowWallIso();   // "2026-04-17T14:32:05.123Z"
const startMono = clock.nowMono();      // 1234567.89 (ms monotone)

// ... après le fetch réussi, step 7.r-s :
const endedAt = clock.nowWallIso();
const durationMs = Math.round(clock.nowMono() - startMono);  // toujours ≥ 0
```

### 4.2 `clock` — test de clock jump

```ts
// tests/contracts/temporal.test.ts :
it("C-TM-XX | durationMs remains ≥ 0 even if wall clock jumps backward", async () => {
  const mockClock = createMockClock(1234567890000, 1000);
  const startMono = mockClock.nowMono(); // 1000

  // Wall jumps backward (ex. NTP sync correction)
  mockClock.advanceWall(-5000);  // wall jumps -5s
  mockClock.advanceMono(200);    // mono advances +200ms

  const duration = Math.round(mockClock.nowMono() - startMono);
  expect(duration).toBe(200);    // ✅ ≥ 0, monotone
});
```

### 4.3 `callId-generator` — unicité

```ts
import { generateCallId } from "./callId-generator";

const ids = new Set<string>();
for (let i = 0; i < 10000; i++) ids.add(generateCallId());
expect(ids.size).toBe(10000);  // tous uniques
```

### 4.4 `logger` — default stderr

```ts
const logger = createDefaultLogger();
logger.emit({
  eventType: "llm_call_start",
  callId: "01J9ZT5H3G8NK2M4X9YZQRT7AB",
  provider: "anthropic",
  model: "claude-opus-4-7",
  timestamp: "2026-04-17T14:32:05.123Z",
  endpoint: "https://api.anthropic.com/v1/messages",
  messagesCount: 3
});
// stderr reçoit :
// {"eventType":"llm_call_start","callId":"01J9ZT5H3G8NK2M4X9YZQRT7AB","provider":"anthropic","model":"claude-opus-4-7","timestamp":"2026-04-17T14:32:05.123Z","endpoint":"https://api.anthropic.com/v1/messages","messagesCount":3}\n
```

### 4.5 `logger` — injection custom

```ts
const collected: LLMEvent[] = [];
const customLogger: LLMLogger = {
  emit: (event) => { collected.push(event); }
};

const adapter = createAnthropicAdapter({
  model: "claude-opus-4-7",
  apiKey: process.env.ANTHROPIC_API_KEY!,
  retry: { maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60000 },
  timeout: { perAttemptMs: 120000 },
  sanitization: {},
  integrity: { detectHeuristicTruncation: false, failOnSilentTruncation: false,
               failOnUnknownTermination: false, failOnModelMismatch: false },
  logging: { logger: customLogger, enabled: true }
});

await adapter.call({ messages: [{ role: "user", content: "hi" }] });

// collected contient maintenant tous les events du call
expect(collected.filter(e => e.eventType === "llm_call_start")).toHaveLength(1);
```

### 4.6 `logger` — disabled

```ts
const adapter = createAnthropicAdapter({
  // ... config
  logging: { logger: customLogger, enabled: false }  // ← disabled override injection
});

await adapter.call({ messages: [{ role: "user", content: "hi" }] });
// collected est vide — enabled: false a priorité absolue
```

---

## 5. Edge cases

| Cas | Comportement attendu | Test |
| --- | --- | --- |
| `clock.nowMono()` appelé deux fois rapidement | La seconde valeur est **≥** la première (monotone, égalité possible si même tick). | Propriété `P-TM-a` |
| Wall clock jumpe en arrière pendant un call | `durationMs` reste **> 0** (calculé sur monotone). | C-TM-XX |
| `generateCallId()` appelé en rafale (ex. 1000 calls en parallèle) | Tous les IDs sont uniques (ULID entropie 80 bits + compteur interne ulid lib). | P-OB-a (dans NIB-T §25) |
| `logger.emit` throw | Silenced (try/catch dans default logger). Pour un logger custom, l'engine ne gère pas — si le custom logger throw, l'erreur remonte (comportement accepté, le consommateur est responsable de son logger). | — |
| Event avec champ `undefined` | `JSON.stringify` omet naturellement les `undefined`. Ex. `usage.inputTokens: undefined` → n'apparaît pas dans la ligne NDJSON. | — |
| Event contenant un objet circulaire | `JSON.stringify` throw → silenced dans default logger → event perdu. **Invariant normatif** : les emetteurs ne construisent jamais d'event avec objet circulaire. | — |
| `LoggingPolicy.enabled === false` ET `logger` non défini | `resolveLogger` retourne un noop. Pas d'erreur. | C-OB-XX |
| `LoggingPolicy.enabled === true` ET `logger` non défini | `resolveLogger` retourne le default (stderr NDJSON). | — |
| `LoggingPolicy.enabled === true` ET `logger` défini | `resolveLogger` retourne le logger injecté. | — |
| `LoggingPolicy.enabled === false` ET `logger` défini | `resolveLogger` retourne un **noop** — le logger injecté ne reçoit rien. Règle critique (§9.6 NX). | C-OB-XX |

---

## 6. Constraints (invariants spécifiques)

### C-IU1 — `clock` est le seul accès temporel

Aucun fichier de production dans `src/` (hors `src/services/clock.ts`) ne doit appeler `Date.now()`, `new Date()`, ou `performance.now()`. Tout accès temporel passe par `clock`.

Enforcement : revue manuelle + potentiellement un lint custom (ex. `eslint-plugin-no-restricted-syntax` avec règle sur `CallExpression`).

### C-IU2 — `callId` unique par call

Chaque invocation de `generateCallId()` produit un ID unique. Testable sur 10k+ itérations.

### C-IU3 — Default logger ne throw jamais

Tout échec du default logger (stderr cassé, JSON.stringify en erreur) est silenced. Un logger défaillant ne doit jamais casser un call en cours.

### C-IU4 — `enabled: false` coupe l'injection

La sémantique single-switch de `LoggingPolicy.enabled` est normative. Testable par injection d'un logger custom qui throw à chaque `emit` + `enabled: false` → aucun throw observable.

### C-IU5 — `LLMLogger.emit` signature stable

La signature `emit(event: LLMEvent): void` est figée. Ajouter un paramètre ou changer le retour = breaking change (major bump).

### C-IU6 — Pas de filtrage PII dans le logger

Le logger **n'inspecte pas** le contenu des events. La discipline "pas de prompts dans les logs" est appliquée par les émetteurs (engine, bindings). Le logger est un sink transparent.

---

## 7. Integration (comment les autres modules consomment ce module)

### 7.1 `clock` — consommation dans l'engine

```ts
// NIB-M-EXECUTE-CALL step 2-3 :
import { clock } from "../services/clock";

const startedAt = clock.nowWallIso();
const startMono = clock.nowMono();
```

### 7.2 `clock` — consommation dans `parseRetryAfter`

```ts
// NIB-M-RETRY-RESOLVER (sous-section parseRetryAfter) :
import { clock } from "../services/clock";

function parseRetryAfter(headers: Record<string, string>): number | undefined {
  const raw = headers["retry-after"];
  if (!raw) return undefined;
  // ... format "seconds"
  // ... format HTTP-date :
  const parsedDate = new Date(raw); // format IMF-fixdate
  if (isNaN(parsedDate.getTime())) return undefined;
  const deltaMs = parsedDate.getTime() - clock.nowWall().getTime();
  return deltaMs <= 0 ? 0 : deltaMs;
}
```

### 7.3 `callId-generator` — consommation dans l'engine

```ts
// NIB-M-EXECUTE-CALL step 1 :
import { generateCallId } from "../services/callId-generator";

const callId = generateCallId();  // partagé par tous les events du call

// NIB-M-EXECUTE-EMBEDDING step 2 : idem.
```

### 7.4 `logger` — injection dans l'adapter

```ts
// NIB-M-FACTORIES :
import { createDefaultLogger } from "../services/logger";

function resolveLogger(policy: LoggingPolicy): LLMLogger {
  if (policy.enabled === false) return { emit: () => {} };
  return policy.logger ?? createDefaultLogger();
}

// Dans executeCall/executeEmbedding :
const logger = resolveLogger(config.logging);
logger.emit({ eventType: "llm_call_start", /* ... */ });
```

---

## 8. Relationship avec les autres NIB-M

| NIB-M | Relation |
| --- | --- |
| **NIB-M-EXECUTE-CALL** / **NIB-M-EXECUTE-EMBEDDING** | Consomme `clock` (timestamps, durées), `generateCallId` (callId par call), `resolveLogger` (logger courant). |
| **NIB-M-RETRY-RESOLVER** | Consomme `clock.nowWall()` pour `parseRetryAfter` (format HTTP-date). |
| **NIB-M-THROTTLE** | Consomme `clock.nowMono()` pour `resolveThrottleDecision` (now vs `snapshot.resetTokensAt`). |
| **NIB-M-SIGNAL-COMPOSER** | Utilise `AbortSignal.timeout` natif (horloge monotone Node interne — cohérent avec `clock.nowMono`). |
| **NIB-M-FACTORIES** | Résout le logger effectif selon `LoggingPolicy`. |

---

## 9. Tests de référence (NIB-T §23, §22, §25)

| Zone | ID tests NIB-T |
| --- | --- |
| `clock.nowMono` monotone sous clock jump | `C-TM-XX` (§23) |
| `durationMs ≥ 0` garanti | `C-TM-XX` (§23) |
| Unicité des callId (10k itérations) | `P-OB-a` (§25) |
| Default logger écrit NDJSON sur stderr | `C-OB-XX` (§22) |
| `enabled: false` coupe l'injection | `C-OB-XX` (§22) |
| Logger injecté reçoit tous les events du call | via engine tests §15-§20 |
| Corrélation callId à travers tous les events d'un call | `C-OB-XX` (§22) |

---

## 10. Implémentation cible (3 fichiers)

### 10.1 `src/services/clock.ts` (~10 LOC)

```ts
export const clock = {
  nowWall: (): Date => new Date(),
  nowWallIso: (): string => new Date().toISOString(),
  nowMono: (): number => performance.now(),
};
```

### 10.2 `src/services/callId-generator.ts` (~5 LOC)

```ts
import { ulid } from "ulid";
export function generateCallId(): string {
  return ulid();
}
```

### 10.3 `src/services/logger.ts` (~30 LOC)

```ts
import type { LLMEvent } from "../types/events";

export interface LLMLogger {
  emit(event: LLMEvent): void;
}

export function createDefaultLogger(): LLMLogger {
  return {
    emit(event: LLMEvent): void {
      try {
        process.stderr.write(JSON.stringify(event) + "\n");
      } catch {
        // Swallow — logger failures never break the runtime.
      }
    },
  };
}

export function createNoopLogger(): LLMLogger {
  return { emit: () => { /* noop */ } };
}

// Helper utilisé par les factories
export function resolveLogger(policy: { enabled: boolean; logger?: LLMLogger }): LLMLogger {
  if (policy.enabled === false) return createNoopLogger();
  return policy.logger ?? createDefaultLogger();
}
```

**Taille totale des 3 fichiers** : **~45 LOC** (cohérent avec l'étiquette "utilitaires triviaux").

---

*VegaCorp — Implicit-Free Execution (IFE) — "La fiabilité précède l'intelligence."*
