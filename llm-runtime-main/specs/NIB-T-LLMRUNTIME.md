---
id: SPEC-NIB-T-LLMRUNTIME
version: "0.1.0"
scope: NIB-T-LLMRUNTIME — TDD Tests Brief
status: draft
---

# NIB-T-LLMRUNTIME — TDD Tests Brief

**Package** : `@vegacorp/llm-runtime`
**Statut** : v1.0 — éclatement RED, consommable par Claude Code
**Date** : 2026-04-17

---

## 0. Préambule

Ce document est la spécification de tests à implémenter **avant** toute ligne de code de production (étape RED du cycle TDD). Il matérialise le **contrat observable** de `@vegacorp/llm-runtime` : ce que le système doit faire, vu de l'extérieur.

### 0.1 Portée du NIB-T

Le NIB-T couvre trois types de tests :

- **Acceptance tests (test vectors)** — paires entrée/sortie concrètes. "Étant donné ce `LLMRequest` et ce binding, le système doit produire ce `LLMResponse`." Chaque vecteur spécifie l'input, l'output attendu, et la propriété vérifiée. C'est le gros du NIB-T (préfixe `T-`).
- **Property tests (anti-cheat)** — invariants structurels qui empêchent le hardcoding et l'overfitting. Idempotence des fonctions pures, stabilité face à l'ordre des inputs, préservation du `callId` à travers les events, non-modification de l'objet `LLMRequest`, etc. (préfixe `P-`).
- **Contract invariants** — assertions transversales qui s'appliquent à tous les fixtures. "Un event de log ne contient jamais de PII." "Un `LLMResponse.callId` est toujours présent et unique par call." "Le `stats` n'est jamais incrémenté sur échec terminal." Documentées une fois, enforcées partout (préfixe `C-`).

Le NIB-T ne décrit **pas** les tests unitaires d'implémentation interne. Les fonctions internes non exportées (ex. `inferNetworkErrorKind`, détails de structure du sanitizer, implémentation du throttle-snapshot) n'ont pas de vecteurs dédiés ici — ils émergeront naturellement pendant la GREEN comme tests de support au refactor. Ce qui est testé ici, c'est le contrat exporté par `@vegacorp/llm-runtime`.

### 0.2 Surface testée

Sont couverts dans ce NIB-T, dans l'ordre des fichiers de test :

1. **Services transversaux purs** (Layer 4) — exportés ou matérialisés comme décisions observables : `resolveRetryDecision`, `resolveThrottleDecision`, `parseRetryAfter`, `estimateCallTokens`, `isRetriableKind`, `sanitizer` (strip thinking tags, strip JSON fence, heuristic truncation), `composeSignal` / `abortableSleep`, `error-classifier-base`.
2. **Bindings providers** (Layer 3) — `buildRequest`, `parseResponse`, `classifyError`, `readRateLimitHeaders`, `terminationMap` pour chacun des 4 completion bindings + `EmbeddingBinding`.
3. **Engine** (Layer 2) — `executeCall` et `executeEmbedding` vus à travers les adapters publics, avec mocks de `fetch` et `clock`.
4. **Adapters publics** (Layer 1) — factories, `ProviderAdapter.call()`, `EmbeddingAdapter.embed()`, `stats`.
5. **Taxonomie d'erreurs** — chaque sous-classe de `LLMRuntimeError`, enrichissement au throw, union `LLMErrorKind`.
6. **Observabilité** — 14 types d'events, corrélation par `callId`, PII absence.
7. **Modèle temporel** — séparation wall/monotone, `durationMs ≥ 0` sous clock jump.
8. **Signaux** — priorité signal externe, propagation abort, timer ownership.

### 0.3 Contenu interdit

Ce NIB-T **ne contient pas** :

- De détails d'implémentation de production (forme interne du retry-resolver, algorithme du sanitizer, structure de fichiers `src/`).
- De tests sur du comportement interne non observable (ex. "la fonction `X` appelle `Y` avant `Z`").
- De tests unitaires sur fonctions internes non exportées — ceux-là émergent pendant GREEN.

---

## 1. Organisation des fixtures

### 1.1 Arborescence

```
tests/
├── fixtures/
│   ├── provider-responses/       # Bodies HTTP canoniques par provider
│   │   ├── anthropic/
│   │   │   ├── ok-simple.json
│   │   │   ├── ok-with-thinking.json
│   │   │   ├── ok-max-tokens.json
│   │   │   ├── ok-stop-sequence.json
│   │   │   ├── ok-tool-use.json
│   │   │   ├── error-400.json
│   │   │   ├── error-401.json
│   │   │   ├── error-429.json
│   │   │   ├── error-529.json
│   │   │   └── error-529-headers.json
│   │   ├── openai/
│   │   │   ├── ok-simple.json
│   │   │   ├── ok-length.json
│   │   │   ├── ok-content-filter.json
│   │   │   ├── ok-deepseek-r1-think.json
│   │   │   ├── error-400.json
│   │   │   ├── error-401.json
│   │   │   ├── error-429.json
│   │   │   └── error-500.json
│   │   ├── google/
│   │   │   ├── ok-simple.json
│   │   │   ├── ok-max-tokens.json
│   │   │   ├── ok-safety-block.json
│   │   │   ├── ok-unknown-finish.json
│   │   │   ├── error-400.json
│   │   │   └── error-429.json
│   │   └── openai-embeddings/
│   │       ├── ok-3-texts.json
│   │       ├── ok-empty.json
│   │       └── error-400.json
│   ├── rate-limit-headers/       # Snapshots headers pour tests de parsing
│   │   ├── anthropic-ok.json
│   │   ├── openai-ok.json
│   │   ├── groq-ok.json
│   │   ├── together-ok.json
│   │   ├── mistral-no-reset.json
│   │   └── retry-after-variants.json
│   └── events-schemas/           # Schémas JSON des 14 events pour validation de shape
│       ├── llm-call-start.schema.json
│       ├── llm-call-attempt-start.schema.json
│       ├── ... (un fichier par eventType)
│       └── llm-embedding-end.schema.json
├── helpers/
│   ├── mock-fetch.ts             # Fabrication de réponses HTTP programmables
│   ├── mock-clock.ts             # Horloges wall/monotone contrôlables
│   ├── mock-logger.ts            # Logger qui collecte les events en mémoire
│   ├── mock-signal.ts            # AbortSignal contrôlable
│   ├── fixture-loader.ts         # Chargement des fixtures JSON
│   ├── fetch-scenario.ts         # Scénarios multi-réponses (pour tester retries)
│   └── event-assertions.ts       # Assertions composites sur les séquences d'events
├── services/                     # Services transversaux (fonctions pures / quasi-pures)
│   ├── retry-resolver.test.ts
│   ├── parse-retry-after.test.ts
│   ├── throttle-resolver.test.ts
│   ├── token-estimator.test.ts
│   ├── error-kind.test.ts
│   ├── sanitizer.test.ts
│   ├── signal-composer.test.ts
│   └── error-classifier-base.test.ts
├── bindings/                     # Bindings providers (Layer 3)
│   ├── anthropic.test.ts
│   ├── openai.test.ts
│   ├── openai-compatible.test.ts
│   ├── google.test.ts
│   └── openai-embeddings.test.ts
├── engine/                       # Engine end-to-end via adapters publics
│   ├── execute-call-happy-path.test.ts
│   ├── execute-call-retry.test.ts
│   ├── execute-call-throttle.test.ts
│   ├── execute-call-abort-timeout.test.ts
│   ├── execute-call-integrity.test.ts
│   └── execute-embedding.test.ts
├── contracts/                    # Contract invariants transversaux
│   ├── errors.test.ts
│   ├── observability.test.ts
│   ├── temporal.test.ts
│   └── stats.test.ts
├── properties/                   # Property tests (anti-cheat)
│   └── properties.test.ts
└── global-contract.test.ts
```

### 1.2 Convention de nommage

- **Acceptance tests** : `T-{module}-{NN}` où `{module}` est un trigramme (ex. `T-RR-01` pour retry-resolver 01, `T-AN-05` pour Anthropic binding 05, `T-EC-12` pour execute-call 12).
- **Property tests** : deux conventions coexistent.
  - **Globaux** (préfixe `P-{NN}` numéroté séquentiellement, P-01 à P-NN) : property tests transversaux qui mobilisent plusieurs modules à la fois ou qui testent des invariants du runtime complet. Regroupés en §25.
  - **Locaux** (préfixe `P-{trigramme}-{lettre}`, ex. `P-RR-a`, `P-SN-b`) : property tests spécifiques à un module, hébergés à la fin de la section du module concerné. Utilisés quand la propriété ne fait sens que dans le contexte immédiat du module (ex. idempotence d'une fonction pure exportée).
- **Contract invariants** : `C-{NN}` numérotés globalement (C-01 à C-NN, regroupés par domaine dans §21-§24).
- **Sauts de numérotation volontaires** : pour les trigrammes qui couvrent plusieurs sous-sections (notamment `EC` qui est réparti sur §15 à §19), la numérotation est avancée à la dizaine ou à la centaine suivante à chaque transition de sous-section (ex. §15 finit à T-EC-24, §16 reprend à T-EC-30 ; §18 finit à T-EC-115, §19 reprend à T-EC-120). Ces trous sont **intentionnels** et servent à l'aération / à laisser de la place pour ajouts futurs dans chaque sous-section sans décaler le reste. Ils ne signalent pas un test manquant.

### 1.3 Trigrammes par module

| Trigramme | Module |
| --- | --- |
| `RR` | retry-resolver |
| `PA` | parse-retry-after |
| `TR` | throttle-resolver |
| `TE` | token-estimator |
| `EK` | error-kind / isRetriableKind |
| `SN` | sanitizer |
| `SC` | signal-composer |
| `CL` | error-classifier-base |
| `AN` | anthropic binding |
| `OA` | openai binding |
| `OC` | openai-compatible binding |
| `GG` | google binding |
| `OE` | openai-embeddings binding |
| `EC` | execute-call (engine) |
| `EE` | execute-embedding (engine) |
| `ER` | errors taxonomy |
| `OB` | observability |
| `TM` | temporal |
| `ST` | stats |
| `GL` | global contract (surface publique, factories, fail-closed) |

### 1.4 Principes de fixture

- **Pas de fixture vide** : chaque fichier JSON contient un body ou un payload réaliste, reproduction littérale de ce qu'un provider renvoie.
- **Fixtures sous contrôle de version** : sourcées de réponses réelles capturées ou construites explicitement d'après la doc officielle.
- **Normalisation** : les payloads HTTP (body) sont des JSON. Les headers sont en lowercase dans les fixtures (invariant normatif).
- **Indépendance au filesystem** : aucun test n'écrit sur disque hors répertoires temporaires via `withTempDir`. Les fixtures sont lues en read-only.

---

## 2. Tests du retry-resolver (`tests/services/retry-resolver.test.ts`)

Signature testée :
```ts
resolveRetryDecision(
  error: LLMRuntimeError | Error,
  attempt: number,           // 0-indexé
  headers: Record<string, string>,
  policy: RetryPolicy
): RetryDecision
```

### 2.1 Acceptance tests — erreurs fatales (tous `retry: false`)

Pour chaque ligne, `attempt` varie à 0, 2 et `policy.maxAttempts - 1` — la décision doit être constante (fatale peu importe l'attempt).

| ID | Type d'erreur en entrée | `attempt` | Décision attendue | Propriété vérifiée |
| --- | --- | --- | --- | --- |
| T-RR-01 | `AuthError` | 0, 2, 4 | `{ retry: false, reason: "fatal_auth" }` | AuthError jamais retried |
| T-RR-02 | `InvalidRequestError` | 0, 2, 4 | `{ retry: false, reason: "fatal_invalid_request" }` | InvalidRequestError jamais retried |
| T-RR-03 | `ResponseParseError` | 0, 2, 4 | `{ retry: false, reason: "fatal_parse_error" }` | ResponseParseError jamais retried |
| T-RR-04 | `ContentFilterError` | 0, 2, 4 | `{ retry: false, reason: "fatal_content_filter" }` | ContentFilterError jamais retried |
| T-RR-05 | `AbortedError` | 0, 2, 4 | `{ retry: false, reason: "fatal_aborted" }` | AbortedError jamais retried (voulu) |
| T-RR-06 | `ProviderProtocolError` | 0, 2, 4 | `{ retry: false, reason: "fatal_protocol" }` | ProviderProtocolError jamais retried |
| T-RR-07 | `SilentTruncationError` | 0, 2, 4 | `{ retry: false, reason: "fatal_truncation" }` | SilentTruncationError jamais retried |

**Policy fixture** : `{ maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60000 }`.

### 2.2 Acceptance tests — erreurs retriables avec budget disponible

Pour chaque ligne, `maxAttempts = 5` et `attempt ∈ {0, 1, 2, 3}` → `attempt + 1 < 5` → budget disponible.

| ID | Type d'erreur | `attempt` | `headers` | `delayMs` attendu | `reason` attendu |
| --- | --- | --- | --- | --- | --- |
| T-RR-08 | `RateLimitError` | 0 | `{}` | 2000 (backoff = 2000 × 2^0) | `transient_rate_limit` |
| T-RR-09 | `RateLimitError` | 1 | `{}` | 4000 (backoff = 2000 × 2^1) | `transient_rate_limit` |
| T-RR-10 | `RateLimitError` | 3 | `{}` | 16000 (backoff = 2000 × 2^3) | `transient_rate_limit` |
| T-RR-11 | `RateLimitError` | 0 | `{ "retry-after": "10" }` | 10000 (depuis header) | `transient_rate_limit` |
| T-RR-12 | `RateLimitError` | 2 | `{ "retry-after": "3" }` | 3000 (header prime) | `transient_rate_limit` |
| T-RR-13 | `OverloadedError` | 0 | `{}` | 2000 | `transient_overloaded` |
| T-RR-14 | `OverloadedError` | 1 | `{ "retry-after": "7" }` | 7000 | `transient_overloaded` |
| T-RR-15 | `TransientProviderError` | 0 | `{}` | 2000 | `transient_provider` |
| T-RR-16 | `TransientProviderError` | 3 | `{}` | 16000 | `transient_provider` |
| T-RR-17 | `TimeoutError` | 0 | `{}` | 2000 | `transient_timeout` |
| T-RR-18 | `TimeoutError` | 2 | `{ "retry-after": "999" }` | 8000 (**backoff, PAS retry-after**) | `transient_timeout` |

**T-RR-18 est critique** : `TimeoutError` n'utilise jamais `Retry-After`. Seuls `RateLimitError`, `OverloadedError`, `TransientProviderError` utilisent `parseRetryAfter`. 

### 2.3 Acceptance tests — budget épuisé

| ID | Type d'erreur | `attempt` | `maxAttempts` | Décision attendue |
| --- | --- | --- | --- | --- |
| T-RR-19 | `RateLimitError` | 4 | 5 | `{ retry: false, reason: "retry_exhausted" }` (`attempt + 1 === maxAttempts`) |
| T-RR-20 | `OverloadedError` | 4 | 5 | `{ retry: false, reason: "retry_exhausted" }` |
| T-RR-21 | `TransientProviderError` | 4 | 5 | `{ retry: false, reason: "retry_exhausted" }` |
| T-RR-22 | `TimeoutError` | 4 | 5 | `{ retry: false, reason: "retry_exhausted" }` |
| T-RR-23 | `RateLimitError` | 0 | 1 | `{ retry: false, reason: "retry_exhausted" }` (budget 1 = pas de retry) |
| T-RR-24 | `TransientProviderError` | 5 | 5 | `{ retry: false, reason: "retry_exhausted" }` (au-delà, défensif) |

### 2.4 Acceptance tests — erreurs non classifiées (`transient_unknown`)

| ID | Input | `attempt` | `maxAttempts` | Décision attendue |
| --- | --- | --- | --- | --- |
| T-RR-25 | `new Error("weird")` | 0 | 5 | `{ retry: true, delayMs: 2000, reason: "transient_unknown" }` |
| T-RR-26 | `new Error("weird")` | 2 | 5 | `{ retry: true, delayMs: 8000, reason: "transient_unknown" }` |
| T-RR-27 | `new Error("weird")` | 4 | 5 | `{ retry: false, reason: "retry_exhausted" }` (budget épuisé prime) |
| T-RR-28 | `new TypeError("fetch failed")` | 0 | 5 | `{ retry: true, delayMs: 2000, reason: "transient_unknown" }` |

### 2.5 Acceptance tests — backoff cap

| ID | Input | `attempt` | `policy` | `delayMs` attendu |
| --- | --- | --- | --- | --- |
| T-RR-29 | `TransientProviderError` | 5 | `{ maxAttempts: 10, backoffBaseMs: 2000, maxBackoffMs: 60000 }` | 60000 (capé, car 2000 × 2^5 = 64000) |
| T-RR-30 | `TransientProviderError` | 6 | `{ maxAttempts: 10, backoffBaseMs: 2000, maxBackoffMs: 60000 }` | 60000 |
| T-RR-31 | `TransientProviderError` | 0 | `{ maxAttempts: 3, backoffBaseMs: 500, maxBackoffMs: 3000 }` | 500 |
| T-RR-32 | `TransientProviderError` | 2 | `{ maxAttempts: 5, backoffBaseMs: 500, maxBackoffMs: 3000 }` | 2000 (500 × 2^2) |

### 2.6 Acceptance tests — `Retry-After` invalide ou absent

| ID | Input | `headers` | `delayMs` attendu | Propriété |
| --- | --- | --- | --- | --- |
| T-RR-33 | `RateLimitError` | `{ "retry-after": "not-a-number" }` | 2000 (fallback backoff) | header non parseable → fallback |
| T-RR-34 | `RateLimitError` | `{ "retry-after": "-5" }` | 2000 (fallback backoff) | valeurs négatives rejetées |
| T-RR-35 | `RateLimitError` | `{ "retry-after": "" }` | 2000 (fallback backoff) | string vide rejetée |
| T-RR-36 | `RateLimitError` | `{}` (pas de header) | 2000 (fallback backoff) | header absent → fallback |

### 2.7 Propriétés

- **P-RR-a** : `resolveRetryDecision` est une fonction pure — deux appels avec mêmes arguments produisent le même résultat. Testé sur 50 itérations aléatoires.
- **P-RR-b** : la décision pour une erreur fatale est indépendante de `policy` et `headers`. Testé avec 5 policies différentes et 5 headers différents pour chaque type fatal.

---

## 3. Tests de `parseRetryAfter` (`tests/services/parse-retry-after.test.ts`)

Signature : `parseRetryAfter(headers: Record<string, string>) => number | undefined`. Sortie en **millisecondes** ou `undefined`.

### 3.1 Acceptance tests — format "seconds"

| ID | `headers` | Sortie attendue | Propriété |
| --- | --- | --- | --- |
| T-PA-01 | `{ "retry-after": "0" }` | `0` | zéro secondes → 0 ms |
| T-PA-02 | `{ "retry-after": "1" }` | `1000` | 1 seconde → 1000 ms |
| T-PA-03 | `{ "retry-after": "10" }` | `10000` | 10 secondes |
| T-PA-04 | `{ "retry-after": "60" }` | `60000` | 60 secondes |
| T-PA-05 | `{ "retry-after": "3600" }` | `3600000` | 1 heure |
| T-PA-06 | `{ "retry-after": "120.5" }` | `undefined` | non-entier → rejet (seconds doit être entier selon RFC 7231) |

### 3.2 Acceptance tests — format HTTP-date (RFC 7231)

Ces tests nécessitent un `clock.nowWall()` mocké à un instant fixe pour déterminisme. Cf. helper `mock-clock`.

**Horloge mockée** : `2026-04-17T12:00:00.000Z` pour tous les tests T-PA-07 à T-PA-12.

| ID | `headers` | Sortie attendue | Propriété |
| --- | --- | --- | --- |
| T-PA-07 | `{ "retry-after": "Fri, 17 Apr 2026 12:00:30 GMT" }` | `30000` | date 30s dans le futur |
| T-PA-08 | `{ "retry-after": "Fri, 17 Apr 2026 12:01:00 GMT" }` | `60000` | 1 min dans le futur |
| T-PA-09 | `{ "retry-after": "Fri, 17 Apr 2026 11:59:30 GMT" }` | `0` | date passée (30s ago) → 0 |
| T-PA-10 | `{ "retry-after": "Fri, 17 Apr 2026 12:00:00 GMT" }` | `0` | date égale à now → 0 (deltaMs ≤ 0) |
| T-PA-11 | `{ "retry-after": "Sat, 18 Apr 2026 12:00:00 GMT" }` | `86400000` | 24h dans le futur |
| T-PA-12 | `{ "retry-after": "Wed, 01 Jan 1990 00:00:00 GMT" }` | `0` | très lointain passé → 0 |

### 3.3 Acceptance tests — cas dégénérés

| ID | `headers` | Sortie attendue | Propriété |
| --- | --- | --- | --- |
| T-PA-13 | `{}` | `undefined` | header absent |
| T-PA-14 | `{ "Retry-After": "10" }` (casse MAJUSCULE) | `undefined` | lookup lowercase strict |
| T-PA-15 | `{ "retry-after": "" }` | `undefined` | string vide |
| T-PA-16 | `{ "retry-after": "garbage-string" }` | `undefined` | non parseable |
| T-PA-17 | `{ "retry-after": "-5" }` | `undefined` | négatif rejeté |
| T-PA-18 | `{ "retry-after": "abc-def-ghi" }` | `undefined` | garbage mixte |
| T-PA-19 | `{ "retry-after": "  10  " }` | `10000` OU `undefined` | tolérance whitespace : **DÉCISION** — `undefined` (pas de trim normatif, parseInt refuse) |
| T-PA-20 | `{ "retry-after": "10.0" }` | `undefined` | float rejeté (même si "entier mathématique") |

**Note T-PA-19** : la spécification ne mentionne pas de trim explicite. Le choix normatif pour le NIB-T est le rejet (`undefined`) pour préserver la stricte équivalence au RFC 7231 (pas de LWS autorisé en début/fin du field-value). Si GREEN choisit d'être tolérant, ce vecteur se mettra à jour avec justification.

### 3.4 Acceptance tests — préséance des champs pour `Retry-After` non numérique

| ID | `headers` | Sortie attendue | Propriété |
| --- | --- | --- | --- |
| T-PA-21 | `{ "retry-after": "Fri, 17 Apr 2026 12:00:30 GMT", "x-custom": "ignored" }` | `30000` | autres headers ignorés |
| T-PA-22 | `{ "retry-after": "10", "retry-after-ms": "99999" }` | `10000` | seul `retry-after` est lu |

### 3.5 Propriétés

- **P-PA-a** : idempotence — `parseRetryAfter(h) === parseRetryAfter(h)` sur 100 headers aléatoires (fonction pure).
- **P-PA-b** : immutabilité — `parseRetryAfter` ne mute pas `headers`. Vérifié via `deepFreeze` avant l'appel.
- **P-PA-c** : le codomain est exactement `number | undefined`. Jamais `null`, `NaN`, string, objet.

---

## 4. Tests du throttle-resolver (`tests/services/throttle-resolver.test.ts`)

Signature :
```ts
resolveThrottleDecision(
  snapshot: RateLimitSnapshot | null,
  estimatedNextCallTokens: number,
  nowMs: number
): ThrottleDecision
```

### 4.1 Acceptance tests — snapshot null ou inutilisable

| ID | `snapshot` | `estimated` | `nowMs` | Décision attendue |
| --- | --- | --- | --- | --- |
| T-TR-01 | `null` | 500 | 1000 | `{ throttle: false, reason: "no_snapshot" }` |
| T-TR-02 | `null` | 0 | 1000 | `{ throttle: false, reason: "no_snapshot" }` |
| T-TR-03 | `{ remainingTokens: 10000, resetTokensAt: 2000, lastCallOutputTokens: 0, state: "unknown" }` | 500 | 1000 | `{ throttle: false, reason: "snapshot_unknown_quality" }` |

### 4.2 Acceptance tests — budget suffisant

| ID | `snapshot.remainingTokens` | `estimated` | Reste | Décision |
| --- | --- | --- | --- | --- |
| T-TR-04 | 1000 | 500 | 500 | `{ throttle: false, reason: "budget_sufficient" }` |
| T-TR-05 | 500 | 500 | 0 | `{ throttle: false, reason: "budget_sufficient" }` (strict `>=`) |
| T-TR-06 | 100000 | 1 | 99999 | `{ throttle: false, reason: "budget_sufficient" }` |

### 4.3 Acceptance tests — fenêtre déjà reset

| ID | `snapshot.resetTokensAt` | `nowMs` | Décision |
| --- | --- | --- | --- |
| T-TR-07 | 500 (ms monotone) | 1000 (`nowMs` > reset) | `{ throttle: false, reason: "window_already_reset" }` |
| T-TR-08 | 1000 | 1000 (`nowMs === reset`) | `{ throttle: false, reason: "window_already_reset" }` (strict `<=`) |
| T-TR-09 | 999 | 1000 | `{ throttle: false, reason: "window_already_reset" }` |

### 4.4 Acceptance tests — throttle actif

Snapshot : `state: "known"`, `remainingTokens < estimated`, `resetTokensAt > nowMs`.

| ID | `snapshot` | `estimated` | `nowMs` | Décision |
| --- | --- | --- | --- | --- |
| T-TR-10 | `{ remaining: 100, resetAt: 5000, lastOut: 200, state: "known" }` | 500 | 1000 | `{ throttle: true, waitMs: 4000, reason: "budget_insufficient" }` |
| T-TR-11 | `{ remaining: 0, resetAt: 60000, lastOut: 100, state: "known" }` | 10 | 30000 | `{ throttle: true, waitMs: 30000, reason: "budget_insufficient" }` |
| T-TR-12 | `{ remaining: 499, resetAt: 10500, lastOut: 0, state: "known" }` | 500 | 10000 | `{ throttle: true, waitMs: 500, reason: "budget_insufficient" }` |

### 4.5 Acceptance tests — ordre de priorité des conditions

Ces vecteurs vérifient que l'ordre d'inspection de la spec est strict (no_snapshot → snapshot_unknown_quality → budget_sufficient → window_already_reset → budget_insufficient).

| ID | Situation | Décision attendue | Justification |
| --- | --- | --- | --- |
| T-TR-13 | `null` + budget apparent suffisant (impossible, `null` est checké en premier) | `no_snapshot` | `null` prime sur toute évaluation numérique |
| T-TR-14 | `state: "unknown"` + `remainingTokens >= estimated` | `snapshot_unknown_quality` | unknown prime sur budget |
| T-TR-15 | `state: "known"` + `remaining >= estimated` + `resetAt <= nowMs` | `budget_sufficient` | budget suffisant prime sur reset |

### 4.6 Propriétés

- **P-TR-a** : fonction pure sur 50 inputs aléatoires.
- **P-TR-b** : `throttle === true` ⇒ `waitMs !== undefined && waitMs > 0`.
- **P-TR-c** : `throttle === false` ⇒ `waitMs === undefined`.

---

## 5. Tests du token-estimator (`tests/services/token-estimator.test.ts`)

Signature : `estimateCallTokens(messages: LLMMessage[], snapshot: RateLimitSnapshot | null, maxTokens: number | undefined) => number`.

### 5.1 Acceptance tests — input estimation (UTF-8 bytes / 3.5)

Pour ces vecteurs, `snapshot = null` et `maxTokens = undefined` pour isoler la composante input. La sortie attendue = `ceil(utf8Bytes / 3.5) + min(1024, 4096) = ceil(utf8Bytes / 3.5) + 1024` (fallback output par défaut).

| ID | `messages` | utf8Bytes | Input part | Sortie totale attendue |
| --- | --- | --- | --- | --- |
| T-TE-01 | `[{ role: "user", content: "hello" }]` | 5 | `ceil(5/3.5) = 2` | `2 + 1024 = 1026` |
| T-TE-02 | `[{ role: "user", content: "" }]` | 0 | 0 | `0 + 1024 = 1024` |
| T-TE-03 | `[{ role: "user", content: "a".repeat(350) }]` | 350 | `ceil(350/3.5) = 100` | `100 + 1024 = 1124` |
| T-TE-04 | `[{ role: "system", content: "sys" }, { role: "user", content: "user" }]` | 7 | 2 | `2 + 1024 = 1026` |
| T-TE-05 | `[{ role: "user", content: "café" }]` (é = 2 bytes) | 5 | 2 | `2 + 1024 = 1026` |
| T-TE-06 | `[{ role: "user", content: "日本語" }]` (3 chars × 3 bytes = 9) | 9 | `ceil(9/3.5) = 3` | `3 + 1024 = 1027` |

**Note** : le comptage de bytes est sur `message.content` uniquement. Les clés (`role`, `content`) ne comptent pas — c'est du overhead protocol, pas du token utile pour l'estimation. Si le GREEN choisit d'inclure du overhead, les vecteurs seront recalibrés.

### 5.2 Acceptance tests — output estimation (snapshot prioritaire)

Pour ces vecteurs, `messages` est fixé à `[{ role: "user", content: "hi" }]` (2 bytes, input ≈ 1) pour focaliser sur l'output.

| ID | `snapshot.lastCallOutputTokens` | `maxTokens` | Output attendu | Total attendu |
| --- | --- | --- | --- | --- |
| T-TE-07 | 500 | `undefined` | 500 (depuis snapshot) | ≈ 501 |
| T-TE-08 | 2000 | 100 | 2000 (snapshot prime sur maxTokens) | ≈ 2001 |
| T-TE-09 | 0 | 500 | 0 (snapshot effectif) | ≈ 1 |

**T-TE-09 est un cas limite** : `lastCallOutputTokens === 0` est une valeur valide du snapshot (premier call jamais terminé ? ou réponse vide ?). La règle normative est "si disponible", interprétée strictement ici comme `snapshot !== null && state !== "unknown"`. Si `lastCallOutputTokens === 0`, on utilise 0. À re-valider si surprenant en GREEN.

### 5.3 Acceptance tests — output fallback sur maxTokens

Quand `snapshot === null` ou `snapshot.state === "unknown"`, l'output utilise `min(maxTokens ?? 1024, 4096)`.

| ID | `snapshot` | `maxTokens` | Output attendu |
| --- | --- | --- | --- |
| T-TE-10 | `null` | `undefined` | 1024 (default) |
| T-TE-11 | `null` | 500 | 500 |
| T-TE-12 | `null` | 4096 | 4096 |
| T-TE-13 | `null` | 8000 | 4096 (capé) |
| T-TE-14 | `null` | 100000 | 4096 (capé) |
| T-TE-15 | `{ state: "unknown", ... }` | 2000 | 2000 |
| T-TE-16 | `{ state: "unknown", lastCallOutputTokens: 9999, ... }` | 500 | 500 (state unknown ignore `lastCallOutputTokens`) |

### 5.4 Acceptance tests — combinés

| ID | `messages` | `snapshot` | `maxTokens` | Attendu |
| --- | --- | --- | --- | --- |
| T-TE-17 | `[{ role: "user", content: "a".repeat(3500) }]` | `{ state: "known", lastCallOutputTokens: 200, resetAt: 0, remaining: 0 }` | 500 | `ceil(3500/3.5) + 200 = 1000 + 200 = 1200` |
| T-TE-18 | `[{ role: "user", content: "" }]` | `null` | 0 | `0 + 0 = 0` |

### 5.5 Propriétés

- **P-TE-a** : `estimateCallTokens(...) >= 0` toujours (le comptage retourne un entier non-négatif).
- **P-TE-b** : fonction pure. Mêmes entrées ⇒ même sortie.
- **P-TE-c** : sortie est un entier (`Number.isInteger(result) === true`).
- **P-TE-d** : monotonicité partielle — ajouter un caractère au `content` n'augmente pas la sortie d'input de plus de 1 (par contract de `ceil(bytes/3.5)`).

---

## 6. Tests de `isRetriableKind` (`tests/services/error-kind.test.ts`)

Signature : `isRetriableKind(kind: LLMErrorKind): boolean`.

### 6.1 Acceptance tests — kinds retriables

| ID | `kind` | Sortie attendue |
| --- | --- | --- |
| T-EK-01 | `"rate_limit"` | `true` |
| T-EK-02 | `"overloaded"` | `true` |
| T-EK-03 | `"transient_provider"` | `true` |
| T-EK-04 | `"timeout"` | `true` |

### 6.2 Acceptance tests — kinds non retriables

| ID | `kind` | Sortie attendue |
| --- | --- | --- |
| T-EK-05 | `"auth"` | `false` |
| T-EK-06 | `"invalid_request"` | `false` |
| T-EK-07 | `"provider_protocol"` | `false` |
| T-EK-08 | `"response_parse"` | `false` |
| T-EK-09 | `"aborted"` | `false` |
| T-EK-10 | `"silent_truncation"` | `false` |
| T-EK-11 | `"content_filter"` | `false` |

### 6.3 Contract invariant

- **C-EK-01** : l'union `LLMErrorKind` a **exactement 11 valeurs** (4 retriables + 7 non). Test : `Object.keys(ALL_LLM_ERROR_KINDS).length === 11`. (Ici `ALL_LLM_ERROR_KINDS` est un helper de test qui énumère les valeurs attendues.)
- **C-EK-02** : chaque `LLMRuntimeError` concrète a un `kind` qui appartient à `LLMErrorKind`. Testé en instanciant chaque sous-classe (§21) et vérifiant `typeof err.kind === "string"` + appartenance.

---

## 7. Tests du sanitizer (`tests/services/sanitizer.test.ts`)

Ces tests couvrent trois fonctions exportées du module :
- `stripThinkingTags(content: string): { content: string; removed: boolean }`
- `stripJsonFence(content: string): { content: string; removed: boolean }`
- `detectHeuristicTruncation(content: string, maxTokens: number | undefined): boolean`

### 7.1 Acceptance tests — `stripThinkingTags`

| ID | Input | Sortie `content` | `removed` |
| --- | --- | --- | --- |
| T-SN-01 | `"hello"` | `"hello"` | `false` |
| T-SN-02 | `"<think>reasoning</think>answer"` | `"answer"` | `true` |
| T-SN-03 | `"<think>a</think>b<think>c</think>d"` | `"bd"` | `true` |
| T-SN-04 | `"<think>only thinking</think>"` | `""` | `true` |
| T-SN-05 | `"prefix<think>mid</think>suffix"` | `"prefixsuffix"` | `true` |
| T-SN-06 | `"<think>\nmulti\nline\n</think>result"` | `"result"` | `true` |
| T-SN-07 | `"no tags here"` | `"no tags here"` | `false` |
| T-SN-08 | `"<think>unclosed"` | `"<think>unclosed"` OU `""` — **DÉCISION** : `"<think>unclosed"`, `removed: false` (regex ne matche pas sans fermeture) | `false` |
| T-SN-09 | `"</think>orphan close"` | `"</think>orphan close"` (pas d'ouverture) | `false` |
| T-SN-10 | `""` | `""` | `false` |

**Note T-SN-08** : un tag `<think>` non fermé n'est pas strippé (regex strict avec fermeture). Si un provider émet du thinking non fermé, c'est un signal à remonter via un autre canal (`ResponseParseError` ou truncation), pas via stripping opportuniste.

### 7.2 Acceptance tests — `stripJsonFence`

Délègue à `ai-json-safe-parse` en mode aggressive. Ici on teste le **comportement observable** côté wrapper runtime, pas le détail interne.

| ID | Input | Sortie `content` attendue | `removed` |
| --- | --- | --- | --- |
| T-SN-11 | `"{\"a\": 1}"` | `"{\"a\": 1}"` | `false` (pas de fence) |
| T-SN-12 | "```json\n{\"a\": 1}\n```" | `"{\"a\": 1}"` (avec ou sans newlines finaux — test tolérant) | `true` |
| T-SN-13 | "```\n{\"a\": 1}\n```" | `"{\"a\": 1}"` | `true` |
| T-SN-14 | `"hello"` (pas de JSON) | `"hello"` | `false` |
| T-SN-15 | "preamble\n```json\n{\"a\": 1}\n```\npostamble" | contenu extrait du fence | `true` |
| T-SN-16 | `""` | `""` | `false` |
| T-SN-17 | "```json\n{invalid}\n```" | **DÉCISION** : `"{invalid}"` (fence strippé même si JSON invalide — le rôle du sanitizer est de retirer le fence, pas de valider) OU délégation à `ai-json-safe-parse` qui peut tolérer | à calibrer en GREEN selon la lib |

### 7.3 Acceptance tests — `detectHeuristicTruncation`

L'heuristique opère sur `content` **post-sanitize**.

| ID | `content` | `maxTokens` | Sortie attendue | Propriété |
| --- | --- | --- | --- | --- |
| T-SN-18 | `""` | `undefined` | `false` | **règle normative** : `content === ""` ⇒ `false` strict |
| T-SN-19 | `""` | 500 | `false` | même règle |
| T-SN-20 | `"{\"a\": 1}"` | 500 | `false` | JSON bien fermé |
| T-SN-21 | `"{\"a\": 1"` (non fermé) | 500 | `true` | JSON ouvert non fermé |
| T-SN-22 | `"[1, 2, 3"` (array non fermé) | 500 | `true` | array non fermé |
| T-SN-23 | `"Hello, how are y"` (texte simple tronqué) | 500 | `false` | pas de JSON → pas de truncation heuristique |
| T-SN-24 | `"Some text { partial"` | 500 | `true` OU `false` (à calibrer selon sensibilité) | texte + JSON ambigu |

**T-SN-24 est en zone grise** : la règle exacte de l'heuristique JSON-unclosed n'est pas spécifiée au caractère près. Le NIB-T accepte les deux comportements à condition que la règle soit documentée en GREEN (ex. "trigger si `{` ou `[` sans matching close, ignorant les chaînes string").

### 7.4 Propriétés

- **P-SN-a** : idempotence de `stripThinkingTags` — `stripThinkingTags(stripThinkingTags(s).content).content === stripThinkingTags(s).content`. Testé sur 20 inputs aléatoires.
- **P-SN-b** : idempotence de `stripJsonFence` — même pattern.
- **P-SN-c** : `stripThinkingTags(s).content.length <= s.length` (jamais d'ajout de contenu).
- **P-SN-d** : `detectHeuristicTruncation("", any) === false` toujours (règle normative).

---

## 8. Tests du signal-composer (`tests/services/signal-composer.test.ts`)

Signatures :
- `composeSignal(external: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void }`
- `abortableSleep(ms: number, signal: AbortSignal): Promise<void>`

### 8.1 Acceptance tests — `composeSignal`

| ID | Scénario | Attendu |
| --- | --- | --- |
| T-SC-01 | `external = undefined`, `timeoutMs = 100` | après 100ms, `signal.aborted === true` ; `signal.reason` indique timeout |
| T-SC-02 | `external = undefined`, `timeoutMs = 50`, wait 30ms | `signal.aborted === false` |
| T-SC-03 | `external = controlledSignal`, externe abort immédiatement | `signal.aborted === true` dans la même microtâche ; `signal.reason === external.reason` |
| T-SC-04 | `external = controlledSignal`, `timeoutMs = 10000`, external abort à 50ms | `signal.aborted === true` à ~50ms (externe prime, pas le timeout) |
| T-SC-05 | `external = controlledSignal` déjà aborted AVANT `composeSignal` | `signal.aborted === true` immédiatement |
| T-SC-06 | Après `cleanup()`, timer libéré (test indirect : node.js n'a plus de handle timer actif après 150ms avec timeoutMs: 10000) | pas de leak |

### 8.2 Acceptance tests — priorité externe vs timeout

| ID | Scénario | Attendu |
| --- | --- | --- |
| T-SC-07 | external et timeout abort dans la même microtâche | `signal.reason` provient de `external`, pas du timeout |
| T-SC-08 | external abort 1ms avant expiration timeout | `signal.reason` provient de `external` |
| T-SC-09 | timeout expire 1ms avant external abort | `signal.reason` provient du timeout (externe n'a pas encore abort) |

**T-SC-07 est le cœur de la règle de priorité**. Testé via coordination explicite avec `mock-clock`.

### 8.3 Acceptance tests — `abortableSleep`

| ID | Scénario | Attendu |
| --- | --- | --- |
| T-SC-10 | `abortableSleep(100, signal)`, signal pas aborted, attendre 100ms | la promise resolve après ~100ms |
| T-SC-11 | `abortableSleep(100, signal)`, signal déjà aborted au moment de l'appel | rejette immédiatement avec `signal.reason` (pas d'attente) |
| T-SC-12 | `abortableSleep(1000, signal)`, abort après 50ms | rejette à ~50ms avec `signal.reason`, `clearTimeout` appelé (pas de timer orphelin) |
| T-SC-13 | `abortableSleep(0, signal)` | resolve immédiatement |
| T-SC-14 | abort après résolution normale | la promise reste resolve (pas de transition vers rejected post-resolve) |

### 8.4 Contract invariant

- **C-SC-01** : tout `setTimeout` ouvert par le signal-composer ou `abortableSleep` est clearé en cas d'abort. Vérifié via `process._getActiveHandles()` (ou mock) à la fin de chaque test — zéro handle pendant.
- **C-SC-02** : aucun `DOMException` brut n'est levé par `abortableSleep` → l'engine reclasse en `AbortedError`. Dans les tests unitaires du composer, on accepte que la `Promise` reject contienne le `reason` natif ; le reclassement en `AbortedError` est testé au niveau engine (§18).

### 8.5 Propriétés

- **P-SC-a** : si `signal.aborted === true` avant `abortableSleep(ms, signal)`, la promise rejette **toujours synchronement** (pas d'attente, même partielle).
- **P-SC-b** : `composeSignal(undefined, ms)` ne throw jamais pour `ms > 0`.

---

## 9. Tests de l'error-classifier-base (`tests/services/error-classifier-base.test.ts`)

Signature : `classifyErrorBase(signal: ProviderErrorSignal): LLMRuntimeError`.

### 9.1 Acceptance tests — priorité (1) aborted

| ID | `signal` | Classe attendue |
| --- | --- | --- |
| T-CL-01 | `{ aborted: true, timeout: false, headers: {} }` | `AbortedError` |
| T-CL-02 | `{ aborted: true, timeout: true, headers: {} }` (les deux) | `AbortedError` (aborted prime) |
| T-CL-03 | `{ aborted: true, timeout: false, status: 500, headers: {} }` | `AbortedError` (aborted prime sur HTTP) |

### 9.2 Acceptance tests — priorité (2) timeout

| ID | `signal` | Classe attendue |
| --- | --- | --- |
| T-CL-04 | `{ aborted: false, timeout: true, headers: {} }` | `TimeoutError` |
| T-CL-05 | `{ aborted: false, timeout: true, status: 500, headers: {} }` | `TimeoutError` (timeout prime sur HTTP) |

### 9.3 Acceptance tests — priorité (3) network error

| ID | `signal` | Classe attendue |
| --- | --- | --- |
| T-CL-06 | `{ aborted: false, timeout: false, networkErrorKind: "dns", headers: {} }` | `TransientProviderError` |
| T-CL-07 | `{ aborted: false, timeout: false, networkErrorKind: "connection", headers: {} }` | `TransientProviderError` |
| T-CL-08 | `{ aborted: false, timeout: false, networkErrorKind: "reset", headers: {} }` | `TransientProviderError` |
| T-CL-09 | `{ aborted: false, timeout: false, networkErrorKind: "unknown", headers: {} }` | `TransientProviderError` |

### 9.4 Acceptance tests — priorité (4) mapping HTTP status

| ID | `signal.status` | Classe attendue |
| --- | --- | --- |
| T-CL-10 | 400 | `InvalidRequestError` |
| T-CL-11 | 401 | `AuthError` |
| T-CL-12 | 403 | `AuthError` |
| T-CL-13 | 404 | `InvalidRequestError` |
| T-CL-14 | 429 | `RateLimitError` |
| T-CL-15 | 500 | `TransientProviderError` |
| T-CL-16 | 502 | `TransientProviderError` |
| T-CL-17 | 503 | `TransientProviderError` |
| T-CL-18 | 529 | `OverloadedError` |
| T-CL-19 | 418 (teapot, non listé) | `TransientProviderError` (conservateur par défaut) |
| T-CL-20 | 504 (non listé) | `TransientProviderError` |

### 9.5 Acceptance tests — priorité (5) fallback défensif

| ID | `signal` | Classe attendue |
| --- | --- | --- |
| T-CL-21 | `{ aborted: false, timeout: false, headers: {} }` (aucun champ discriminant) | `ProviderProtocolError` |

### 9.6 Acceptance tests — enrichissement via `cause` / message

| ID | `signal` | Propriété vérifiée |
| --- | --- | --- |
| T-CL-22 | `{ status: 429, headers: { "retry-after": "10" }, bodyText: "rate limited" }` | `RateLimitError.retryAfterMs === 10000` (lu depuis headers dans le classifier) |
| T-CL-23 | `{ status: 429, headers: {}, bodyText: "rate limited" }` | `RateLimitError.retryAfterMs === undefined` |
| T-CL-24 | `{ status: 400, bodyText: "malformed payload" }` | `InvalidRequestError.message` contient "malformed payload" ou équivalent traçable |
| T-CL-25 | `{ timeout: true, aborted: false, headers: {} }` avec `timeoutMs: 120000` en contexte | `TimeoutError.timeoutMs === 120000` (si le classifier reçoit le contexte ; sinon test reporté à l'engine) |

**Note T-CL-22, T-CL-25** : le mapping de `retryAfterMs` et `timeoutMs` sur les sous-classes d'erreur peut être de la responsabilité du classifier ou de l'engine. Le NIB-T teste l'**observable final** (`error.retryAfterMs === 10000`) — où que ce champ soit rempli. Les tests engine (§16) vérifient l'intégration complète.

### 9.7 Propriétés

- **P-CL-a** : fonction pure sur 50 signaux aléatoires.
- **P-CL-b** : le résultat est toujours une instance de `LLMRuntimeError` (jamais `Error` brut, jamais `null`).
- **P-CL-c** : aucun signal n'entraîne de throw — `classifyErrorBase` retourne toujours une erreur, elle n'en levée pas elle-même.

---

## 10. Tests du binding Anthropic (`tests/bindings/anthropic.test.ts`)

Le binding est testé à travers ses 5 fonctions + ses quirks. Pour `buildRequest`, on vérifie le `CanonicalHttpRequest` produit. Pour `parseResponse`, on vérifie le `ParsedProviderResponse` sur fixtures. Pour `classifyError`, on vérifie les overrides provider-spécifiques. Pour `readRateLimitHeaders`, on vérifie l'extraction du `RateLimitSnapshot`.

### 10.1 Acceptance tests — `buildRequest`

Input : un `LLMRequest` et un `BindingConfig`. Output : un `CanonicalHttpRequest`.

| ID | `LLMRequest` | `BindingConfig` | Assertions sur output |
| --- | --- | --- | --- |
| T-AN-01 | `{ messages: [{ role: "user", content: "hi" }] }` | `{ model: "claude-opus-4-6", apiKey: "sk-x", endpoint: undefined }` | `method === "POST"`, `url === "https://api.anthropic.com/v1/messages"`, `headers["x-api-key"] === "sk-x"`, `headers["anthropic-version"] === "2023-06-01"`, `bodyKind === "json"`, `bodyJson.model === "claude-opus-4-6"`, `bodyJson.messages[0] === { role: "user", content: "hi" }` |
| T-AN-02 | `{ messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }] }` | `{ model: "claude-opus-4-6", apiKey: "sk-x" }` | `bodyJson.system === "sys"` (string, pas dans `messages`), `bodyJson.messages` = `[{ role: "user", content: "hi" }]` (system extrait) |
| T-AN-03 | `{ messages: [...], temperature: 0.7, maxTokens: 500 }` | ... | `bodyJson.temperature === 0.7`, `bodyJson.max_tokens === 500` |
| T-AN-04 | `{ messages: [...], stopSequences: ["END", "STOP"] }` | ... | `bodyJson.stop_sequences === ["END", "STOP"]` |
| T-AN-05 | `{ messages: [...] }` | `{ ..., providerOptions: { extendedThinking: { enabled: true, budgetTokens: 4000 } } }` | `bodyJson.thinking === { type: "enabled", budget_tokens: 4000 }` |
| T-AN-06 | `{ messages: [...] }` | `{ ..., endpoint: "https://custom.proxy/v1/messages" }` | `url === "https://custom.proxy/v1/messages"` (endpoint override) |
| T-AN-07 | `{ messages: [{ role: "user", content: "u1" }, { role: "assistant", content: "a1" }, { role: "user", content: "u2" }] }` | ... | `bodyJson.messages.length === 3`, préserve l'alternance user/assistant |

### 10.2 Acceptance tests — `parseResponse` (fixtures)

Fixture : charge `provider-responses/anthropic/{fixture}.json`. Headers fixe : `{ "content-type": "application/json" }` sauf indication contraire.

| ID | Fixture | Assertions sur `ParsedProviderResponse` |
| --- | --- | --- |
| T-AN-08 | `ok-simple.json` (body `{"content":[{"type":"text","text":"Hello"}],"stop_reason":"end_turn","model":"claude-opus-4-6-20260301","usage":{"input_tokens":10,"output_tokens":5}}`) | `rawContent === "Hello"`, `terminationSignal === "end_turn"`, `usage.inputTokens === 10`, `usage.outputTokens === 5`, `usage.totalTokens === 15`, `providerModel === "claude-opus-4-6-20260301"` |
| T-AN-09 | `ok-with-thinking.json` (body contient `[{"type":"thinking","thinking":"..."},{"type":"text","text":"Answer"}]`) | `rawContent === "Answer"` (text-only extrait, thinking ignoré au niveau binding — le strip est fait par engine) |
| T-AN-10 | `ok-max-tokens.json` (`stop_reason: "max_tokens"`) | `terminationSignal === "max_tokens"` |
| T-AN-11 | `ok-stop-sequence.json` | `terminationSignal === "stop_sequence"` |
| T-AN-12 | `ok-tool-use.json` (`stop_reason: "tool_use"`) | `terminationSignal === "tool_use"` ; `rawContent` = texte des blocks `"text"` uniquement |
| T-AN-13 | body `{"content": [{"type":"text","text":"A"},{"type":"text","text":"B"}], ...}` | `rawContent === "AB"` (concaténation des blocks text dans l'ordre) |

**Cas d'erreur de parsing** :

| ID | Fixture / body | Assertion |
| --- | --- | --- |
| T-AN-14 | body non JSON (`"<html>..."`) | throw `ResponseParseError` |
| T-AN-15 | body `{}` (champ `content` absent) | throw `ResponseParseError` |
| T-AN-16 | body `{"content":[]}` (array vide) | `rawContent === ""` (pas d'erreur — réponse vide valide) |
| T-AN-17 | body `{"content":[{"type":"text"}]}` (`text` manquant) | throw `ResponseParseError` |

### 10.3 Acceptance tests — `classifyError`

Le binding Anthropic override certains cas. Tests qui vérifient le comportement final.

| ID | `ProviderErrorSignal` | Classe attendue |
| --- | --- | --- |
| T-AN-18 | `{ status: 529, headers: {}, bodyText: "Overloaded" }` | `OverloadedError` (override Anthropic-specific) |
| T-AN-19 | `{ status: 400, headers: {}, bodyText: "..." }` | `InvalidRequestError` (base) |
| T-AN-20 | `{ status: 401, headers: {}, bodyText: "invalid x-api-key" }` | `AuthError` |
| T-AN-21 | `{ status: 429, headers: { "retry-after": "30" } }` | `RateLimitError` avec `retryAfterMs === 30000` |
| T-AN-22 | refus de politique (body `{"type":"error","error":{"type":"refusal"}}` avec status 200) | **Cas avancé** : si le binding renvoie ça via `parseResponse` → `ContentFilterError` ; sinon exposition à travers `terminationMap` (à calibrer en GREEN selon la forme réelle de l'API Anthropic). Pour v1 : spec non prescriptive — test reporté. |

### 10.4 Acceptance tests — `readRateLimitHeaders`

Fixture : `rate-limit-headers/anthropic-ok.json` contenant :
```json
{
  "anthropic-ratelimit-input-tokens-limit": "50000",
  "anthropic-ratelimit-input-tokens-remaining": "42500",
  "anthropic-ratelimit-input-tokens-reset": "2026-04-17T12:05:00Z",
  "anthropic-ratelimit-output-tokens-limit": "8000",
  "anthropic-ratelimit-output-tokens-remaining": "7500",
  "anthropic-ratelimit-output-tokens-reset": "2026-04-17T12:05:00Z"
}
```

| ID | Headers | Sortie attendue |
| --- | --- | --- |
| T-AN-23 | fixture `anthropic-ok.json` | `RateLimitSnapshot` avec `remainingTokens === 42500`, `state === "known"`, `resetTokensAt` = delta monotone cohérent |
| T-AN-24 | headers vides `{}` | `null` |
| T-AN-25 | headers partiels (seulement `remaining`) | `null` OU `{ state: "partial", ... }` — **DÉCISION** : `null` si on ne peut pas reconstruire un snapshot exploitable |
| T-AN-26 | reset absent mais remaining présent | `null` |

**Note T-AN-23** : la conversion du reset wall-clock vers monotone nécessite de capturer `nowWall` et `nowMono` ensemble (via `clock`). Le test utilise un mock-clock avec wall `2026-04-17T12:00:00Z` et `nowMono === 1000`. Expected `resetTokensAt === 1000 + 300000 === 301000` (delta 5 min = 300s).

### 10.5 Acceptance tests — `terminationMap`

Le champ est un `Readonly<Record<string, TerminationReason>>` exposé par le binding. Test direct du contenu.

| ID | Assertion |
| --- | --- |
| T-AN-27 | `binding.terminationMap["end_turn"] === "completed"` |
| T-AN-28 | `binding.terminationMap["max_tokens"] === "max_tokens"` |
| T-AN-29 | `binding.terminationMap["stop_sequence"] === "stop_sequence"` |
| T-AN-30 | `binding.terminationMap["tool_use"] === "completed"` |
| T-AN-31 | `binding.terminationMap["refusal"]` — **NON défini** (géré via `ContentFilterError`). Assertion : `undefined` |

### 10.6 Acceptance tests — quirks

| ID | Assertion |
| --- | --- |
| T-AN-32 | `binding.quirks.hasRateLimitHeaders === true` |
| T-AN-33 | `binding.quirks.mayRouteModel === true` |
| T-AN-34 | `binding.quirks.defaultSanitization === { stripThinkingTags: true, stripJsonFence: true }` |

### 10.7 Propriétés

- **P-AN-a** : `buildRequest` est idempotent — deux appels avec mêmes inputs produisent un `CanonicalHttpRequest` structurellement égal (comparé via `JSON.stringify`).
- **P-AN-b** : `buildRequest` ne mute pas son `request` ni son `config`. `deepFreeze` avant l'appel, pas de throw.
- **P-AN-c** : `parseResponse` est idempotent — déterministe sur le même body.
- **P-AN-d** : `terminationMap` est frozen (`Object.isFrozen(binding.terminationMap) === true`).

---

## 11. Tests du binding OpenAI (`tests/bindings/openai.test.ts`)

### 11.1 Acceptance tests — `buildRequest`

| ID | Input | Assertions |
| --- | --- | --- |
| T-OA-01 | `messages: [{ role: "user", content: "hi" }]`, config `{ model: "gpt-4o", apiKey: "sk-x" }` | `url === "https://api.openai.com/v1/chat/completions"`, `headers["authorization"] === "Bearer sk-x"`, `bodyJson.model === "gpt-4o"`, `bodyJson.messages === [{ role: "user", content: "hi" }]` |
| T-OA-02 | `messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }]` | `bodyJson.messages === [{ role: "system", content: "s" }, { role: "user", content: "u" }]` (system **inclus** dans messages, pas séparé comme Anthropic) |
| T-OA-03 | `temperature: 0.5`, `maxTokens: 1000` | `bodyJson.temperature === 0.5`, `bodyJson.max_tokens === 1000` (naming `max_tokens` selon OpenAI) |
| T-OA-04 | `stopSequences: ["END"]` | `bodyJson.stop === ["END"]` |
| T-OA-05 | endpoint override | URL remplacée |

### 11.2 Acceptance tests — `parseResponse`

Body OpenAI canonique :
```json
{
  "id": "chatcmpl-xxx",
  "model": "gpt-4o-2024-08-06",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "Hello" }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 8, "completion_tokens": 2, "total_tokens": 10 }
}
```

| ID | Fixture | Assertions |
| --- | --- | --- |
| T-OA-06 | `ok-simple.json` | `rawContent === "Hello"`, `terminationSignal === "stop"`, `usage.inputTokens === 8` (normalisation prompt_tokens → inputTokens), `usage.outputTokens === 2`, `usage.totalTokens === 10`, `providerResponseId === "chatcmpl-xxx"`, `providerModel === "gpt-4o-2024-08-06"` |
| T-OA-07 | `ok-length.json` (`finish_reason: "length"`) | `terminationSignal === "length"` |
| T-OA-08 | `ok-content-filter.json` (`finish_reason: "content_filter"`) | `terminationSignal === "content_filter"` |
| T-OA-09 | `ok-deepseek-r1-think.json` (body inclut `<think>...</think>answer` dans `choices[0].message.content`) | `rawContent === "<think>reasoning</think>answer"` (le strip est fait par engine, pas par binding) |
| T-OA-10 | body `choices: []` | throw `ResponseParseError` |
| T-OA-11 | `choices[0].message.content === null` (cas rare OpenAI avec tool_calls) | `rawContent === ""` (pas d'erreur) ; `terminationSignal === "tool_calls"` si présent |
| T-OA-12 | body sans `usage` | `usage === { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined, ... }` — **jamais 0 par invention** |

### 11.3 Acceptance tests — `classifyError`

| ID | Signal | Classe |
| --- | --- | --- |
| T-OA-13 | status 400 | `InvalidRequestError` |
| T-OA-14 | status 401 | `AuthError` |
| T-OA-15 | status 429 | `RateLimitError` |
| T-OA-16 | status 500 | `TransientProviderError` |
| T-OA-17 | status 503 | `TransientProviderError` |

### 11.4 Acceptance tests — `readRateLimitHeaders`

Fixture : `rate-limit-headers/openai-ok.json` :
```json
{
  "x-ratelimit-limit-tokens": "150000",
  "x-ratelimit-remaining-tokens": "142000",
  "x-ratelimit-reset-tokens": "10s"
}
```

| ID | Assertion |
| --- | --- |
| T-OA-18 | `remainingTokens === 142000`, `state === "known"`, `resetTokensAt` = delta monotone (10s après `nowMono`) |
| T-OA-19 | headers vides → `null` |
| T-OA-20 | reset en format `"1m30s"` — **format spécifique OpenAI** : `resetTokensAt` = `nowMono + 90000` |

### 11.5 Acceptance tests — `terminationMap` et quirks

| ID | Assertion |
| --- | --- |
| T-OA-21 | `terminationMap["stop"] === "completed"` |
| T-OA-22 | `terminationMap["length"] === "max_tokens"` |
| T-OA-23 | `terminationMap["content_filter"] === "content_filter"` |
| T-OA-24 | `terminationMap["tool_calls"] === "completed"` |
| T-OA-25 | `quirks.hasRateLimitHeaders === true`, `quirks.mayRouteModel === false`, `quirks.defaultSanitization === { stripThinkingTags: true, stripJsonFence: false }` |

---

## 12. Tests du binding OpenAI-compatible (`tests/bindings/openai-compatible.test.ts`)

Le binding est **structurellement identique** à OpenAI, mais chaque factory passe un provider distinct et un endpoint distinct. Les tests se concentrent sur les variations.

### 12.1 Acceptance tests — identification de provider

Chaque factory produit un adapter avec le bon `provider` :

| ID | Factory | `adapter.provider` |
| --- | --- | --- |
| T-OC-01 | `createOpenAICompatibleAdapter({ provider: "deepseek", model: "deepseek-chat", apiKey: "x", endpoint: "https://api.deepseek.com/v1" })` | `"deepseek"` |
| T-OC-02 | `... provider: "mistral", endpoint: "https://api.mistral.ai/v1"` | `"mistral"` |
| T-OC-03 | `... provider: "groq", endpoint: "https://api.groq.com/openai/v1"` | `"groq"` |
| T-OC-04 | `... provider: "together", endpoint: "https://api.together.xyz/v1"` | `"together"` |
| T-OC-05 | `... provider: "ollama", endpoint: "http://localhost:11434/v1"` | `"ollama"` |

### 12.2 Acceptance tests — DeepSeek R1 (thinking tags visibles dans content)

| ID | Input | Assertion |
| --- | --- | --- |
| T-OC-06 | body avec `content: "<think>long reasoning</think>final answer"` | `rawContent === "<think>long reasoning</think>final answer"` (binding n'extrait pas — c'est l'engine qui strip selon la policy) |

### 12.3 Acceptance tests — Together (`x-tokenlimit-remaining` header custom)

| ID | Headers | Sortie `readRateLimitHeaders` |
| --- | --- | --- |
| T-OC-07 | `{ "x-tokenlimit-remaining": "5000", "x-tokenlimit-reset": "30" }` (avec provider: "together") | `RateLimitSnapshot` avec `remainingTokens === 5000`, `state === "known"` |
| T-OC-08 | mêmes headers mais `provider: "groq"` | `null` (groq utilise `x-ratelimit-*` standard, pas `x-tokenlimit-*`) |

### 12.4 Acceptance tests — Ollama (pas de rate limit)

| ID | Headers | Sortie `readRateLimitHeaders` |
| --- | --- | --- |
| T-OC-09 | `{}` avec provider: "ollama" | `null` (pas de headers) |
| T-OC-10 | `quirks.hasRateLimitHeaders === false` (Ollama) | assertion directe |

### 12.5 Acceptance tests — Mistral (pas de reset header)

| ID | Headers | Sortie `readRateLimitHeaders` |
| --- | --- | --- |
| T-OC-11 | `{ "x-ratelimit-remaining-tokens": "1000" }` (pas de reset) | **DÉCISION** : `null` OU `{ state: "partial", ... }` — la spec mentionne "pas de reset header → fallback 60s". Interprétation NIB-T : le binding construit un snapshot avec `resetTokensAt = nowMono + 60000` et `state: "partial"` (warning implicite sur la qualité). **Test** : `state === "partial"` et `resetTokensAt` cohérent. |

### 12.6 Quirks par provider

| ID | Provider | `hasRateLimitHeaders` | `defaultSanitization.stripThinkingTags` | `defaultSanitization.stripJsonFence` |
| --- | --- | --- | --- | --- |
| T-OC-12 | deepseek | true | true (R1) | false |
| T-OC-13 | mistral | true (partial) | true | false |
| T-OC-14 | groq | true | true | false |
| T-OC-15 | together | true | true | false |
| T-OC-16 | ollama | false | true | false |

---

## 13. Tests du binding Google Gemini (`tests/bindings/google.test.ts`)

### 13.1 Acceptance tests — `buildRequest`

| ID | Input | Assertions |
| --- | --- | --- |
| T-GG-01 | `messages: [{ role: "user", content: "hi" }]`, config `{ model: "gemini-2.0-flash", apiKey: "AIza..." }` | `url` contient `"gemini-2.0-flash:generateContent"`, `headers["x-goog-api-key"] === "AIza..."` (pas `Authorization`), `bodyJson.contents === [{ role: "user", parts: [{ text: "hi" }] }]` |
| T-GG-02 | `messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }]` | `bodyJson.systemInstruction === { parts: [{ text: "s" }] }`, `bodyJson.contents` n'a **pas** de system (extrait) |
| T-GG-03 | `temperature: 0.3`, `maxTokens: 500` | `bodyJson.generationConfig === { temperature: 0.3, maxOutputTokens: 500 }` (naming Gemini) |
| T-GG-04 | `stopSequences: ["END"]` | `bodyJson.generationConfig.stopSequences === ["END"]` |
| T-GG-05 | assistant dans messages | mappé vers `role: "model"` (convention Gemini) |

### 13.2 Acceptance tests — `parseResponse`

Body Gemini :
```json
{
  "candidates": [{
    "content": { "parts": [{ "text": "Hello" }], "role": "model" },
    "finishReason": "STOP"
  }],
  "usageMetadata": { "promptTokenCount": 8, "candidatesTokenCount": 2, "totalTokenCount": 10 },
  "modelVersion": "gemini-2.0-flash-001"
}
```

| ID | Fixture | Assertions |
| --- | --- | --- |
| T-GG-06 | `ok-simple.json` | `rawContent === "Hello"`, `terminationSignal === "STOP"`, `usage.inputTokens === 8`, `usage.outputTokens === 2`, `providerModel === "gemini-2.0-flash-001"` |
| T-GG-07 | `ok-max-tokens.json` (`finishReason: "MAX_TOKENS"`) | `terminationSignal === "MAX_TOKENS"` |
| T-GG-08 | `ok-safety-block.json` (candidates[0] sans parts, finishReason: "SAFETY") | `ContentFilterError` levée directement |
| T-GG-09 | `ok-unknown-finish.json` (`finishReason: "FOO_UNKNOWN"`) | `terminationSignal === "FOO_UNKNOWN"` (passé brut, mapping fait par engine via `terminationMap`) |
| T-GG-10 | body `candidates: []` | throw `ResponseParseError` |

### 13.3 Acceptance tests — `terminationMap` (complet)

| ID | signal | mapped |
| --- | --- | --- |
| T-GG-11 | `"STOP"` | `"completed"` |
| T-GG-12 | `"MAX_TOKENS"` | `"max_tokens"` |
| T-GG-13 | `"SAFETY"` | `"content_filter"` |
| T-GG-14 | `"RECITATION"` | `"content_filter"` |
| T-GG-15 | `"BLOCKLIST"` | `"content_filter"` |
| T-GG-16 | `"PROHIBITED_CONTENT"` | `"content_filter"` |
| T-GG-17 | `"SPII"` | `"content_filter"` |
| T-GG-18 | `"LANGUAGE"` | `"content_filter"` |
| T-GG-19 | `"MALFORMED_FUNCTION_CALL"` | `"unknown"` |
| T-GG-20 | `"FINISH_REASON_UNSPECIFIED"` | `"unknown"` |
| T-GG-21 | `"OTHER"` | `"unknown"` |

### 13.4 Acceptance tests — quirks

| ID | Assertion |
| --- | --- |
| T-GG-22 | `quirks.hasRateLimitHeaders === false` |
| T-GG-23 | `quirks.mayRouteModel === false` |
| T-GG-24 | `quirks.defaultSanitization === { stripThinkingTags: true, stripJsonFence: true }` |

### 13.5 Acceptance tests — `readRateLimitHeaders`

| ID | Headers | Sortie |
| --- | --- | --- |
| T-GG-25 | n'importe quels headers | `null` (Gemini n'expose pas de rate-limit headers) |

---

## 14. Tests du binding OpenAI Embeddings (`tests/bindings/openai-embeddings.test.ts`)

### 14.1 Acceptance tests — `buildRequest`

| ID | `texts` | `BindingConfig` | Assertions |
| --- | --- | --- | --- |
| T-OE-01 | `["a", "b", "c"]` | `{ model: "text-embedding-3-small", apiKey: "sk-x" }` | `url === "https://api.openai.com/v1/embeddings"`, `headers["authorization"] === "Bearer sk-x"`, `bodyJson === { model: "text-embedding-3-small", input: ["a", "b", "c"], encoding_format: "float" }` |
| T-OE-02 | `[]` | `{ model: "text-embedding-3-small", apiKey: "sk-x" }` | test non atteint par le binding normalement (adapter skip si `texts.length === 0`) — mais si appelé : comportement défini, pas de throw |
| T-OE-03 | `["hello"]` | endpoint override | URL remplacée |

### 14.2 Acceptance tests — `parseEmbeddings`

Body OpenAI embeddings :
```json
{
  "object": "list",
  "data": [
    { "object": "embedding", "index": 0, "embedding": [0.1, 0.2] },
    { "object": "embedding", "index": 1, "embedding": [0.3, 0.4] }
  ],
  "model": "text-embedding-3-small",
  "usage": { "prompt_tokens": 4, "total_tokens": 4 }
}
```

| ID | Fixture | Assertions |
| --- | --- | --- |
| T-OE-04 | `ok-3-texts.json` | sortie est `number[][]` de longueur 3, ordre préservé selon `index` |
| T-OE-05 | body avec `data` **non trié** (index 2, 0, 1) | sortie réordonnée par index croissant |
| T-OE-06 | `ok-empty.json` (data array vide) | sortie = `[]` |
| T-OE-07 | body sans `data` | throw `ResponseParseError` |
| T-OE-08 | un element sans `embedding` | throw `ResponseParseError` |
| T-OE-09 | embedding de dimension inconsistante (`[0.1, 0.2]` puis `[0.3]`) | **DÉCISION** : le binding ne valide pas la cohérence dimensionnelle. Test : pas de throw, retourne tel quel |

### 14.3 Acceptance tests — `classifyError`

Hérite du classifier base OpenAI (même mapping).

| ID | Signal | Classe |
| --- | --- | --- |
| T-OE-10 | status 400 | `InvalidRequestError` |
| T-OE-11 | status 429 | `RateLimitError` |
| T-OE-12 | status 500 | `TransientProviderError` |

### 14.4 Acceptance tests — `readRateLimitHeaders` et quirks

| ID | Assertion |
| --- | --- |
| T-OE-13 | `quirks` a seulement `hasRateLimitHeaders` (pas de `defaultSanitization`, pas de `mayRouteModel`) — interface `Pick<ProviderQuirks, "hasRateLimitHeaders">` |
| T-OE-14 | `quirks.hasRateLimitHeaders === true` |
| T-OE-15 | binding n'expose pas `terminationMap` (interface `EmbeddingBinding` sans ce champ) — vérifié par assertion TypeScript + `(binding as any).terminationMap === undefined` |

---

## 15. Tests de `executeCall` — happy path (`tests/engine/execute-call-happy-path.test.ts`)

Ces tests utilisent un adapter public (`createAnthropicAdapter`) avec `fetch` mocké pour isoler l'engine. Chaque test vérifie :
- La `LLMResponse` retournée.
- La séquence d'events émis via un `mockLogger`.
- L'absence d'effet de bord indésirable (pas de retry, timer propre).

### 15.1 Acceptance tests — Anthropic succès simple

**Setup** : `mockFetch` retourne une réponse 200 avec body `ok-simple.json` (Anthropic). `mockClock` : wall `2026-04-17T12:00:00Z`, mono step `+5`.

| ID | Request | Assertions principales |
| --- | --- | --- |
| T-EC-01 | `{ messages: [{ role: "user", content: "Hello" }] }` | `response.content === "Hello"`, `response.termination === "completed"`, `response.attemptCount === 1`, `response.durationMs >= 0`, `response.callId` est un ULID (26 chars, Crockford Base32), `response.provider === "anthropic"`, `response.model === "claude-opus-4-6"` |
| T-EC-02 | même que T-EC-01 | Events émis dans l'ordre : `llm_call_start`, `llm_call_attempt_start`, `llm_call_end` (success: true) — 3 events exactement |
| T-EC-03 | même | Tous les events ont le même `callId` (corrélation) |
| T-EC-04 | même | `llm_call_end.success === true`, `llm_call_end.attemptCount === 1`, `llm_call_end.termination === "completed"`, `llm_call_end.errorKind` absent |
| T-EC-05 | même | `response.startedAt` et `response.endedAt` au format ISO 8601, `endedAt >= startedAt` |

### 15.2 Acceptance tests — OpenAI succès avec sanitization

Setup : OpenAI adapter avec `stripJsonFence: true` (override policy), fetch retourne body avec content = "```json\n{\"a\":1}\n```".

| ID | Assertion |
| --- | --- |
| T-EC-06 | `response.rawContent === "\`\`\`json\n{\"a\":1}\n\`\`\`"` (brut préservé) |
| T-EC-07 | `response.content === "{\"a\":1}"` (fence strippé) |
| T-EC-08 | `response.sanitization === { thinkingTagsRemoved: false, jsonFenceRemoved: true }` |
| T-EC-09 | event `llm_call_sanitized` émis avec `jsonFenceRemoved: true`, `thinkingTagsRemoved: false` |

### 15.3 Acceptance tests — DeepSeek R1 avec thinking tags

Setup : OpenAI-compatible adapter pour deepseek, content = `"<think>reasoning</think>final"`.

| ID | Assertion |
| --- | --- |
| T-EC-10 | `response.rawContent === "<think>reasoning</think>final"` |
| T-EC-11 | `response.content === "final"` (strippé car `stripThinkingTags: true` par default DeepSeek) |
| T-EC-12 | `response.sanitization === { thinkingTagsRemoved: true, jsonFenceRemoved: false }` |

### 15.4 Acceptance tests — content vide après sanitization

Setup : Anthropic adapter, body avec content = `"<think>only thinking</think>"`.

| ID | Assertion |
| --- | --- |
| T-EC-13 | `response.rawContent === "<think>only thinking</think>"` (non vide) |
| T-EC-14 | `response.content === ""` (vide après strip) |
| T-EC-15 | `response.integrity.truncationDetected === false` (**** : vide ≠ truncation) |
| T-EC-16 | event `llm_call_sanitized` émis avec `rawContentPreview` présent (exception contrôlée) |
| T-EC-17 | `response.termination === "completed"` (mapping normal) |

### 15.5 Acceptance tests — override temperature et maxTokens

| ID | Request | Assertion |
| --- | --- | --- |
| T-EC-18 | `{ messages: [...], temperature: 0.2, maxTokens: 500 }` | Le fetch a reçu un body avec `temperature: 0.2`, `max_tokens: 500` (Anthropic) ou `max_tokens: 500` (OpenAI). Vérifié via `mockFetch.calls[0].body` |

### 15.6 Acceptance tests — usage capturé et stats incrémentées

| ID | Request | Assertion |
| --- | --- | --- |
| T-EC-19 | call unique, body avec `usage: { input_tokens: 10, output_tokens: 5 }` (Anthropic) | `response.usage.inputTokens === 10`, `response.usage.outputTokens === 5`, `response.usage.totalTokens === 15` |
| T-EC-20 | 3 calls consécutifs réussis | `adapter.stats.totalCalls === 3`, `adapter.stats.totalInputTokens === sum(input)`, `adapter.stats.totalOutputTokens === sum(output)` |

### 15.7 Acceptance tests — `LLMRequest` immutable

| ID | Setup | Assertion |
| --- | --- | --- |
| T-EC-21 | `deepFreeze(request)` avant `adapter.call(request)` | pas de throw (runtime ne mute pas) |
| T-EC-22 | comparaison profonde avant/après call | `request` structurellement identique |

### 15.8 Acceptance tests — `providerResponseId` et `providerModel`

| ID | Assertion |
| --- | --- |
| T-EC-23 | OpenAI body avec `id: "chatcmpl-abc123"` | `response.providerModel === "gpt-4o-2024-08-06"` (depuis `model` du body) |
| T-EC-24 | Gemini body sans `modelVersion` | `response.providerModel === undefined` (pas inventé) |

### 15.9 Propriétés

- **P-EC-a** : le même request produit le même `response.content` quand le binding est déterministe (mock fetch fixe). `callId`, `startedAt`, `endedAt`, `durationMs` excluded de la comparaison.
- **P-EC-b** : `response.callId` est unique à travers 100 appels consécutifs (propriété ULID + mock clock qui avance).

---

## 16. Tests de `executeCall` — retry (`tests/engine/execute-call-retry.test.ts`)

Ces tests utilisent `FetchScenario` — un helper qui permet de programmer une suite de réponses HTTP (ex. 429, 429, 200) pour un même mock fetch.

### 16.1 Acceptance tests — retry sur 429 puis succès

Setup : scenario `[429 (retry-after: 1), 200 OK]`. `mockClock` monotone avance.

| ID | Assertion |
| --- | --- |
| T-EC-30 | `response` retourné avec `content` extrait de la 2e réponse |
| T-EC-31 | `response.attemptCount === 2` |
| T-EC-32 | `mockFetch.calls.length === 2` |
| T-EC-33 | Events en séquence : `start`, `attempt_start` (attempt: 0), `provider_error` (status: 429, retryable: true), `retry_scheduled` (attempt: 1, delayMs: 1000, reason: "transient_rate_limit"), `attempt_start` (attempt: 1), `end` (success: true, attemptCount: 2) |
| T-EC-34 | Le sleep de retry a duré ~1000ms selon `mockClock` (lu dans header `retry-after: 1`) |

### 16.2 Acceptance tests — retry sur 500 puis 200

Setup : scenario `[500, 200]`, `policy.backoffBaseMs = 2000`.

| ID | Assertion |
| --- | --- |
| T-EC-35 | `response.attemptCount === 2`, success |
| T-EC-36 | Delay entre les deux fetches = 2000ms (backoff `2000 * 2^0`) |
| T-EC-37 | Event `retry_scheduled.reason === "transient_provider"`, `delayMs === 2000` |

### 16.3 Acceptance tests — retries multiples épuisés puis throw

Setup : scenario `[500, 500, 500, 500, 500]`, `maxAttempts: 5`.

| ID | Assertion |
| --- | --- |
| T-EC-38 | `adapter.call(request)` throw `TransientProviderError` |
| T-EC-39 | `error.attempts === 5` |
| T-EC-40 | `error.callId` défini et cohérent avec les events |
| T-EC-41 | `error.provider === "anthropic"`, `error.model === "claude-opus-4-6"` |
| T-EC-42 | `mockFetch.calls.length === 5` |
| T-EC-43 | 4 events `retry_scheduled` émis (entre attempt 0→1, 1→2, 2→3, 3→4) |
| T-EC-44 | Event `llm_call_end.success === false`, `errorKind === "transient_provider"`, `attemptCount === 5` |
| T-EC-45 | `adapter.stats.totalCalls === 0` |

### 16.4 Acceptance tests — erreur fatale, pas de retry

Setup : scenario `[401]`.

| ID | Assertion |
| --- | --- |
| T-EC-46 | Throw `AuthError`, `error.attempts === 1` |
| T-EC-47 | `mockFetch.calls.length === 1` (pas de retry) |
| T-EC-48 | Event `retry_scheduled` **jamais** émis |
| T-EC-49 | Event `llm_call_end.success === false`, `errorKind === "auth"` |

### 16.5 Acceptance tests — 429 avec `Retry-After` HTTP-date

Setup : scenario `[{ status: 429, headers: { "retry-after": "Fri, 17 Apr 2026 12:00:05 GMT" } }, 200]`. `mockClock.nowWall` fixé à `12:00:00Z` au moment du premier fetch.

| ID | Assertion |
| --- | --- |
| T-EC-50 | Delay calculé ≈ 5000ms (diff wall-clock) |
| T-EC-51 | success au 2e call |

### 16.6 Acceptance tests — `ResponseParseError` fatale

Setup : scenario `[{ status: 200, body: "<html>500 error</html>" }]` (HTML au lieu de JSON).

| ID | Assertion |
| --- | --- |
| T-EC-52 | Throw `ResponseParseError`, `error.attempts === 1` |
| T-EC-53 | Event `llm_call_parse_error` émis |
| T-EC-54 | Pas de retry |

### 16.7 Acceptance tests — erreur inconnue classifiée `transient_unknown`

Setup : mock fetch throw une erreur non standard (`new Error("weird thing")`), puis succès.

| ID | Assertion |
| --- | --- |
| T-EC-55 | Le call réussit au 2e attempt |
| T-EC-56 | Event `llm_call_unknown_error_classified` émis (warn) avec `rawMessage: "weird thing"` |
| T-EC-57 | Event `retry_scheduled.reason === "transient_unknown"` |

### 16.8 Acceptance tests — 429 invalide le snapshot throttle

Setup : adapter avec `hasRateLimitHeaders: true` (Anthropic). Snapshot initial `state: "known"`. Scenario `[{ status: 429, headers: {} (pas de rate-limit headers exploitables) }, 200 OK]`.

| ID | Assertion |
| --- | --- |
| T-EC-58 | Après le 429, le snapshot interne est invalidé (`state: "unknown"`) |
| T-EC-59 | Au call suivant (sur une nouvelle requête avec même adapter), l'event `llm_call_throttled` n'est pas émis même si remainingTokens était bas (car state est "unknown") |
| T-EC-60 | Si le 429 comprend des headers exploitables, le snapshot est **mis à jour** (pas invalidé) |

### 16.9 Acceptance tests — enrichissement des erreurs

Comportement conforme à l'enrichissement obligatoire (écrase les champs provider/model/callId/attempts) et au bouclage d'épuisement de retry.

| ID | Setup | Assertion |
| --- | --- | --- |
| T-EC-61 | Binding qui throw `new AuthError({ provider: "wrong-provider", model: "wrong-model" })` | L'engine **écrase** ces valeurs avec le vrai `provider`, `model`, `callId`, `attempts` avant propagation au consommateur |

### 16.10 Propriétés

- **P-EC-c** : sur un scenario `[200]`, aucun event `retry_scheduled` n'est émis. Vérifié sur 10 variations de request.

---

## 17. Tests de `executeCall` — throttle (`tests/engine/execute-call-throttle.test.ts`)

### 17.1 Acceptance tests — throttle proactif déclenche

Setup : adapter Anthropic. **Premier call** dépose un snapshot `state: "known", remainingTokens: 100, resetTokensAt: nowMono + 30000`. **Deuxième call** a un `estimatedTokens > 100` (ex. message long).

| ID | Assertion |
| --- | --- |
| T-EC-70 | Avant le 2e fetch, event `llm_call_throttled` émis avec `waitMs` ≈ 30000, `reason: "budget_insufficient"`, `estimatedTokens` (valeur estimée), `snapshotState: "known"` |
| T-EC-71 | `adapter.call(request2)` attend effectivement ~30000ms avant le fetch (mock clock avance) |
| T-EC-72 | Le fetch a bien lieu après l'attente |

### 17.2 Acceptance tests — pas de throttle si snapshot null

Setup : premier call (pas de snapshot préexistant).

| ID | Assertion |
| --- | --- |
| T-EC-73 | Pas d'event `llm_call_throttled` |
| T-EC-74 | Fetch direct |

### 17.3 Acceptance tests — pas de throttle si `hasRateLimitHeaders: false`

Setup : adapter Google Gemini (`hasRateLimitHeaders: false`), même si un snapshot était présent (par erreur), le throttle ne devrait pas être actif — en pratique, le binding retourne `null` à `readRateLimitHeaders` donc le snapshot ne se remplit jamais.

| ID | Assertion |
| --- | --- |
| T-EC-75 | 5 calls consécutifs Gemini : aucun event `llm_call_throttled` émis jamais |

### 17.4 Acceptance tests — throttle annulé par abort externe

Setup : snapshot fait attendre 30s, mais signal externe abort à 100ms.

| ID | Assertion |
| --- | --- |
| T-EC-76 | Throw `AbortedError` après ~100ms (pas 30s) |
| T-EC-77 | Event `llm_call_throttled` émis mais suivi de `llm_call_end.success: false, errorKind: "aborted"` |
| T-EC-78 | `mockFetch.calls.length === 0` (jamais atteint) |

### 17.5 Acceptance tests — snapshot mis à jour après succès

Setup : call réussi. Le binding `readRateLimitHeaders` retourne un `RateLimitSnapshot` valide.

| ID | Assertion |
| --- | --- |
| T-EC-79 | Après le call, un nouveau call (2e) voit le snapshot mis à jour (comportement throttle cohérent avec les nouveaux `remainingTokens`) |

---

## 18. Tests de `executeCall` — abort, timeout, signal (`tests/engine/execute-call-abort-timeout.test.ts`)

### 18.1 Acceptance tests — signal déjà aborted avant `call()`

Setup : `signal.aborted === true` avant appel.

| ID | Assertion |
| --- | --- |
| T-EC-90 | Throw `AbortedError` **immédiatement** (sync-ish) |
| T-EC-91 | `error.attempts === 0` |
| T-EC-92 | `mockFetch.calls.length === 0` (aucun fetch) |
| T-EC-93 | Events : `llm_call_start`, `llm_call_end.success: false, errorKind: "aborted"` — c'est tout |

### 18.2 Acceptance tests — abort externe pendant fetch

Setup : mock fetch bloque indéfiniment, signal abort à 100ms.

| ID | Assertion |
| --- | --- |
| T-EC-94 | Throw `AbortedError` après ~100ms |
| T-EC-95 | `error.callId`, `error.provider`, `error.model`, `error.attempts === 1` enrichis |
| T-EC-96 | Event `llm_call_fetch_error` (ou équivalent, avec `networkErrorKind` absent pour abort — le classifier met `aborted: true`) |
| T-EC-97 | Pas de `DOMException` brut propagé au consommateur |
| T-EC-98 | `error.cause` préserve le reason du signal externe |

### 18.3 Acceptance tests — abort externe pendant retry sleep

Setup : scenario `[500, slow-block]`. Après le 500, retry sleep 2000ms. Signal abort à 500ms.

| ID | Assertion |
| --- | --- |
| T-EC-99 | Throw `AbortedError` à ~500ms (durant le sleep) |
| T-EC-100 | `mockFetch.calls.length === 1` (le 2e fetch n'a jamais eu lieu) |
| T-EC-101 | Event `retry_scheduled` émis avant l'abort |
| T-EC-102 | `error.attempts === 1` (attempt qui a throw le 500) |

### 18.4 Acceptance tests — abort externe pendant throttle sleep

Setup : throttle declenche, `waitMs = 10000`. Abort à 500ms.

| ID | Assertion |
| --- | --- |
| T-EC-103 | Throw `AbortedError` à ~500ms |
| T-EC-104 | `mockFetch.calls.length === 0` |

### 18.5 Acceptance tests — timeout interne

Setup : `timeout.perAttemptMs = 100`, mock fetch bloque indéfiniment, pas de signal externe.

| ID | Assertion |
| --- | --- |
| T-EC-105 | Après 100ms, l'attempt est interrompu |
| T-EC-106 | Le classifier produit `TimeoutError` (si pas de retry) ou retry (si budget restant) |
| T-EC-107 | Avec `maxAttempts: 1` → throw `TimeoutError` avec `error.timeoutMs === 100` |
| T-EC-108 | Avec `maxAttempts: 5` et fetch qui continue de bloquer → retry jusqu'à épuisement, throw `TimeoutError` |

### 18.6 Acceptance tests — priorité abort externe sur timeout interne

Setup : `timeout.perAttemptMs = 200`, signal abort à 100ms, fetch bloque.

| ID | Assertion |
| --- | --- |
| T-EC-109 | Throw `AbortedError` (pas `TimeoutError`) |
| T-EC-110 | Throw à ~100ms, pas ~200 |

### 18.7 Acceptance tests — timer cleanup (pas de leak)

Setup : 10 calls consécutifs, certains réussis, certains aborted.

| ID | Assertion |
| --- | --- |
| T-EC-111 | Après tous les calls, `process._getActiveHandles().filter(h => h.constructor.name === "Timer")` est vide (ou taille 0 à l'exception de timers étrangers) |
| T-EC-112 | Durant un call, au plus un timer interne actif à tout moment |

### 18.8 Acceptance tests — erreur réseau non-abort

Setup : mock fetch throw `new TypeError("fetch failed: ECONNRESET")`.

| ID | Assertion |
| --- | --- |
| T-EC-113 | Le classifier produit `TransientProviderError` (via `networkErrorKind: "reset"` ou similar) |
| T-EC-114 | Avec `maxAttempts: 5` et toutes les attempts échouant de la même façon : throw `TransientProviderError` après 5 attempts |
| T-EC-115 | Event `llm_call_fetch_error` émis à chaque attempt avec `networkErrorKind` et `message` |

---

## 19. Tests de `executeCall` — integrity (`tests/engine/execute-call-integrity.test.ts`)

### 19.1 Acceptance tests — truncation détectée mais not-fail

Setup : `IntegrityPolicy.detectHeuristicTruncation: true, failOnSilentTruncation: false`. Body avec `content: "{ \"a\": 1, \"b\": 2"` (JSON non fermé), terminationSignal: "end_turn".

| ID | Assertion |
| --- | --- |
| T-EC-120 | `response.integrity.truncationDetected === true` |
| T-EC-121 | `response.integrity.truncationMode === "heuristic_json_unclosed"` |
| T-EC-122 | Pas de throw (diagnostic seulement) |

### 19.2 Acceptance tests — truncation détectée + fail strict

Setup : `failOnSilentTruncation: true`, même body que ci-dessus.

| ID | Assertion |
| --- | --- |
| T-EC-123 | Throw `SilentTruncationError`, `error.attempts === 1` |
| T-EC-124 | Pas de retry (fatale) |

### 19.3 Acceptance tests — truncation explicite `max_tokens`

Setup : body avec `finish_reason: "length"` ou `stop_reason: "max_tokens"`.

| ID | Assertion |
| --- | --- |
| T-EC-125 | `response.integrity.truncationDetected === true` |
| T-EC-126 | `response.integrity.truncationMode === "explicit_max_tokens"` |
| T-EC-127 | `response.termination === "max_tokens"` |
| T-EC-128 | Pas de throw même si `failOnSilentTruncation: true` (explicite, pas silent) |

### 19.4 Acceptance tests — terminationSignal inconnu (soft)

Setup : body avec finish_reason non mappé (`"foo_unknown"`). `failOnUnknownTermination: false` (default).

| ID | Assertion |
| --- | --- |
| T-EC-129 | `response.termination === "unknown"` |
| T-EC-130 | Event `llm_call_unknown_termination` émis avec `rawSignal: "foo_unknown"` |
| T-EC-131 | Pas de throw |

### 19.5 Acceptance tests — terminationSignal inconnu (strict)

Setup : `failOnUnknownTermination: true`, même body.

| ID | Assertion |
| --- | --- |
| T-EC-132 | Throw `ProviderProtocolError`, `error.attempts === 1` |
| T-EC-133 | Event `llm_call_unknown_termination` émis avant throw |

### 19.6 Acceptance tests — `modelMismatch` avec `mayRouteModel: true` (default skip)

Setup : adapter Anthropic (`mayRouteModel: true`), `failOnModelMismatch: false`. Request `model: "claude-opus-4"`, response `model: "claude-opus-4-6-20260301"`.

| ID | Assertion |
| --- | --- |
| T-EC-134 | `response.providerModel === "claude-opus-4-6-20260301"` |
| T-EC-135 | Pas de throw (aliasing autorisé) |

### 19.7 Acceptance tests — `modelMismatch` avec `failOnModelMismatch: true`

Setup : `failOnModelMismatch: true`, pas de predicate custom. Même request/response.

| ID | Adapter | Assertion |
| --- | --- | --- |
| T-EC-136 | Anthropic (`mayRouteModel: true`) | **Pas de throw** — `mayRouteModel: true` désactive le check strict d'égalité. Seul un predicate custom pourrait trigger un mismatch. |
| T-EC-137 | OpenAI (`mayRouteModel: false`) | Throw `ProviderProtocolError` (si `request.model !== response.providerModel`) |

### 19.8 Acceptance tests — `modelMismatch` avec predicate custom

Setup : `failOnModelMismatch: true`, `modelMismatchPredicate: (req, res) => req !== res` (strict).

| ID | Adapter | Assertion |
| --- | --- | --- |
| T-EC-138 | Anthropic | Throw `ProviderProtocolError` (predicate prime sur `mayRouteModel`) |
| T-EC-139 | Request "claude-opus-4", response "claude-opus-4-6-xyz", predicate qui accepte aliasing → `(a, b) => !b.startsWith(a)` | Pas de throw (predicate retourne `false`) |

### 19.9 Acceptance tests — `providerModel` absent

Setup : body sans `model` retourné.

| ID | Assertion |
| --- | --- |
| T-EC-140 | `response.providerModel === undefined` |
| T-EC-141 | Mismatch check skip silencieusement (pas de throw même avec `failOnModelMismatch: true`) |

---

## 20. Tests de `executeEmbedding` (`tests/engine/execute-embedding.test.ts`)

### 20.1 Acceptance tests — succès simple

Setup : OpenAI embeddings adapter, `batchSize: 100` default, `texts` de longueur 3.

| ID | Assertion |
| --- | --- |
| T-EE-01 | `result.length === 3` |
| T-EE-02 | Chaque vecteur a la bonne dimension (ex. 1536) |
| T-EE-03 | `mockFetch.calls.length === 1` (un seul batch) |
| T-EE-04 | Events : `llm_embedding_start`, `llm_embedding_batch` (batchIndex: 0), `llm_embedding_end` (success: true) |
| T-EE-05 | Tous les events ont le même `callId` (ULID) |

### 20.2 Acceptance tests — texts vide skip appel

Setup : `texts: []`.

| ID | Assertion |
| --- | --- |
| T-EE-06 | `result === []` |
| T-EE-07 | `mockFetch.calls.length === 0` (**pas d'appel**) |
| T-EE-08 | Events : `llm_embedding_start` et `llm_embedding_end`, pas de `llm_embedding_batch` |

### 20.3 Acceptance tests — batching

Setup : `texts` de longueur 250, `batchSize: 100`.

| ID | Assertion |
| --- | --- |
| T-EE-09 | `mockFetch.calls.length === 3` (100 + 100 + 50) |
| T-EE-10 | Batch 0 reçoit `input: texts.slice(0, 100)` |
| T-EE-11 | Batch 1 reçoit `input: texts.slice(100, 200)` |
| T-EE-12 | Batch 2 reçoit `input: texts.slice(200, 250)` (50 elements) |
| T-EE-13 | `result.length === 250` |
| T-EE-14 | `result[i]` correspond au vecteur retourné pour `texts[i]` (ordre préservé à travers les batches) |
| T-EE-15 | 3 events `llm_embedding_batch` émis (batchIndex 0, 1, 2) |

### 20.4 Acceptance tests — ordre préservé avec batching

Setup : `texts = ["a","b","c","d","e"]`, `batchSize: 2`. Mock retourne dans chaque batch les vecteurs avec `index` dans l'ordre reçu.

| ID | Assertion |
| --- | --- |
| T-EE-16 | `result[0]` correspond à "a", `result[1]` à "b", ..., `result[4]` à "e" |

### 20.5 Acceptance tests — erreur dans un batch n'affecte pas les autres… **NON**, échec global

Setup : 3 batches, le 2e retourne 500.

| ID | Assertion |
| --- | --- |
| T-EE-17 | Throw `TransientProviderError` (après retries épuisés sur le 2e batch) |
| T-EE-18 | Le 3e batch n'est **jamais** appelé |
| T-EE-19 | Event `llm_embedding_end.success === false, errorKind: "transient_provider"` |
| T-EE-20 | `error.attempts === 5` (épuisement du budget retry sur le batch 1) |
| T-EE-21 | Les batches 0 et 1 ont leur `llm_embedding_batch` émis. Batch 2 : pas d'event batch. |

**Note** : l'échec d'un batch est **fatal** pour tout l'embedding call. Pas de résultats partiels.

### 20.6 Acceptance tests — abort pendant embedding

Setup : signal abort pendant le 2e batch.

| ID | Assertion |
| --- | --- |
| T-EE-22 | Throw `AbortedError` |
| T-EE-23 | Les batches déjà terminés ont leurs events `batch` émis |

### 20.7 Acceptance tests — retry par batch

Setup : 1 batch qui échoue 500 puis réussit.

| ID | Assertion |
| --- | --- |
| T-EE-24 | Le batch est retried, succès au 2e attempt |
| T-EE-25 | `result` correct |
| T-EE-26 | Event `retry_scheduled` **à confirmer en GREEN** — la spec mentionne une structure similaire aux retries complétion mais ne précise pas si `retry_scheduled` est émis tel quel pour embeddings ou sous un event distinct. **DÉCISION NIB-T** : `retry_scheduled` est réutilisé (corrélation par callId possible). Si GREEN choisit un autre pattern (ex. `llm_embedding_retry_scheduled`), ce test se met à jour. |

### 20.8 Acceptance tests — stats embedding

Setup : adapter embedding, 3 calls réussis.

| ID | Assertion |
| --- | --- |
| T-EE-27 | `adapter.stats.totalCalls === 3` |
| T-EE-28 | `adapter.stats.totalDurationMs > 0` |
| T-EE-29 | `adapter.stats.totalInputTokens === 0` (convention v1) |
| T-EE-30 | `adapter.stats.totalOutputTokens === 0` (convention v1) |

### 20.9 Propriétés

- **P-EE-a** : `embed(texts)` retourne un array de même longueur que `texts` quand le call réussit.
- **P-EE-b** : l'ordre des vecteurs est déterministe et correspond à l'ordre d'entrée (anti-shuffle).
- **P-EE-c** : `embed([])` retourne toujours `[]` sans appel réseau, peu importe la config.

---

## 21. Contract invariants — taxonomie d'erreurs (`tests/contracts/errors.test.ts`)

### 21.1 Structure de la taxonomie

| ID | Assertion |
| --- | --- |
| C-ER-01 | Chacune des 11 sous-classes (`AuthError`, `InvalidRequestError`, `RateLimitError`, `OverloadedError`, `TransientProviderError`, `ProviderProtocolError`, `ResponseParseError`, `TimeoutError`, `AbortedError`, `SilentTruncationError`, `ContentFilterError`) étend `LLMRuntimeError` |
| C-ER-02 | `LLMRuntimeError` étend `Error` |
| C-ER-03 | Chaque instance concrète a un `kind` (string) qui appartient à l'union `LLMErrorKind` |
| C-ER-04 | `kind` est `readonly` (assertion TS + tentative de mutation runtime throw ou no-op) |
| C-ER-05 | `isRetriableKind(kind) === true` pour {rate_limit, overloaded, transient_provider, timeout} |
| C-ER-06 | `isRetriableKind(kind) === false` pour les 7 autres |

### 21.2 Sérialisation

| ID | Assertion |
| --- | --- |
| C-ER-07 | `JSON.stringify(error)` ne throw pas (circular ref, BigInt, etc.) |
| C-ER-08 | `error.name` est le nom de la classe (ex. `"RateLimitError"`) |
| C-ER-09 | `error.message` est un string non vide |

### 21.3 Enrichissement au throw

Pour chaque cas ci-dessous, on vérifie qu'au moment où le consommateur reçoit l'erreur via `adapter.call()`, les 4 champs sont présents.

| ID | Scénario | Assertion |
| --- | --- | --- |
| C-ER-10 | Throw `InvalidRequestError` (messages vide) | `callId` string, `provider === adapter.provider`, `model === adapter.model`, `attempts === 0` |
| C-ER-11 | Throw `TransientProviderError` (5 × 500) | `callId` string, `attempts === 5` |
| C-ER-12 | Throw `AuthError` (401 au 1er attempt) | `attempts === 1` |
| C-ER-13 | Throw `AbortedError` (signal already aborted) | `attempts === 0` |
| C-ER-14 | Throw `AbortedError` (abort pendant retry sleep attempt 2) | `attempts === 2` |
| C-ER-15 | Throw `TimeoutError` (4 timeouts de 100ms chacun sur maxAttempts: 4) | `attempts === 4`, `timeoutMs === 100` |

### 21.4 Préservation du `cause`

| ID | Scénario | Assertion |
| --- | --- | --- |
| C-ER-16 | Erreur réseau fetch (TypeError) | `error.cause instanceof Error`, message contient la source |
| C-ER-17 | Abort avec reason custom (`new Error("user cancelled")`) | `error.cause?.message === "user cancelled"` |
| C-ER-18 | `ResponseParseError` sur JSON malformé | `error.cause` contient détails du parse |

### 21.5 Champs spécifiques des sous-classes

| ID | Erreur | Assertion |
| --- | --- | --- |
| C-ER-19 | `RateLimitError` avec 429 + retry-after | `error.retryAfterMs === parsed value` |
| C-ER-20 | `TimeoutError` | `error.timeoutMs` défini (ms) |

---

## 22. Contract invariants — observabilité (`tests/contracts/observability.test.ts`)

### 22.1 Shape des events (contre schema JSON)

Pour chacun des 14 eventType, un schema JSON décrit les champs requis et leur type. Les fixtures `events-schemas/{eventType}.schema.json` servent à la validation.

| ID | Event | Assertion |
| --- | --- | --- |
| C-OB-01 | `llm_call_start` | conforme au schema : eventType, callId (ULID), provider (LLMProviderLongId), model (string), timestamp (ISO), endpoint (string), messagesCount (number ≥ 0) |
| C-OB-02 | `llm_call_attempt_start` | eventType, callId, provider, model, timestamp, attempt (number ≥ 0) |
| C-OB-03 | `llm_call_throttled` | + waitMs, reason, snapshotState, estimatedTokens |
| C-OB-04 | `llm_call_retry_scheduled` | + attempt, delayMs, reason, errorKind |
| C-OB-05 | `llm_call_fetch_error` | + networkErrorKind, message |
| C-OB-06 | `llm_call_provider_error` | + status, semanticErrorKind, retryable |
| C-OB-07 | `llm_call_parse_error` | + message |
| C-OB-08 | `llm_call_sanitized` | + thinkingTagsRemoved, jsonFenceRemoved, rawContentPreview? |
| C-OB-09 | `llm_call_unknown_error_classified` | + status?, bodySnippet?, networkErrorKind?, rawMessage |
| C-OB-10 | `llm_call_unknown_termination` | + rawSignal |
| C-OB-11 | `llm_call_end` | + success, durationMs, attemptCount, termination?, usage?, providerModel?, errorKind? |
| C-OB-12 | `llm_embedding_start` | + endpoint, textsCount, batchSize |
| C-OB-13 | `llm_embedding_batch` | + batchIndex, batchTextsCount, durationMs |
| C-OB-14 | `llm_embedding_end` | + success, totalBatches, totalDurationMs, errorKind? |

### 22.2 Corrélation

| ID | Assertion |
| --- | --- |
| C-OB-15 | Pour un call completion réussi : tous les events collectés ont le même `callId` |
| C-OB-16 | Pour un call embedding réussi : tous les events collectés ont le même `callId` |
| C-OB-17 | Deux calls consécutifs ont des `callId` différents |
| C-OB-18 | `callId` ordre ULID → lexicographique croissant sur deux calls consécutifs (propriété ULID) |

### 22.3 Séquence d'events

| ID | Scénario | Assertion de séquence |
| --- | --- | --- |
| C-OB-19 | Call completion succès, attempt unique | Sequence : `llm_call_start`, `llm_call_attempt_start`, `llm_call_end` |
| C-OB-20 | Call completion avec retries | Sequence : `llm_call_start`, (`llm_call_attempt_start`, error events, `llm_call_retry_scheduled`) × (N-1), `llm_call_attempt_start`, `llm_call_end` |
| C-OB-21 | Call embedding, 3 batches | Sequence : `llm_embedding_start`, `llm_embedding_batch` × 3, `llm_embedding_end` |
| C-OB-22 | `llm_call_end` est **le dernier event** d'un call completion (succès ou échec) |
| C-OB-23 | `llm_embedding_end` est **le dernier event** d'un call embedding |

### 22.4 PII absence

Ce test scrute **tous** les events émis à travers des calls variés (avec différents types de prompts, réponses, erreurs).

| ID | Assertion |
| --- | --- |
| C-OB-24 | Aucun event (hors exception `llm_call_sanitized.rawContentPreview`) ne contient le texte exact du `request.messages[*].content` |
| C-OB-25 | Aucun event ne contient le texte exact du `response.content` (hors preview contrôlé) |
| C-OB-26 | `llm_call_sanitized.rawContentPreview` : quand présent, longueur ≤ 500 chars |
| C-OB-27 | `llm_call_sanitized.rawContentPreview` : présent **uniquement** si `thinkingTagsRemoved === true && content.length === 0` |

### 22.5 Discipline de `llm_call_end`

| ID | Assertion |
| --- | --- |
| C-OB-28 | `llm_call_end` a **exactement** le set de champs défini en C-OB-11 (eventType, callId, provider, model, timestamp hérités des champs communs + success, durationMs, attemptCount, termination?, usage?, providerModel?, errorKind?) — pas d'extension silencieuse |
| C-OB-29 | `llm_call_end.success === true` ⇒ `termination` et `usage` définis ; `errorKind` absent |
| C-OB-30 | `llm_call_end.success === false` ⇒ `errorKind` défini |

### 22.6 Logger injectable

| ID | Assertion |
| --- | --- |
| C-OB-31 | Avec `loggingPolicy.logger = customLogger`, les events arrivent à `customLogger.emit()` (pas à stderr) |
| C-OB-32 | Avec `loggingPolicy.enabled = false` + custom logger : `customLogger.emit()` n'est jamais appelé |
| C-OB-33 | Avec default logger (stderr) et `enabled: false` : aucune écriture stderr |

### 22.7 Default logger — format

| ID | Assertion |
| --- | --- |
| C-OB-34 | Chaque ligne de stderr est un JSON valide (parseable) |
| C-OB-35 | Séparateur `\n` (LF, pas CRLF) |
| C-OB-36 | Encoding UTF-8 |

---

## 23. Contract invariants — temporel (`tests/contracts/temporal.test.ts`)

### 23.1 Horloges distinctes

| ID | Assertion |
| --- | --- |
| C-TM-01 | `response.durationMs` est un entier (ou float, à calibrer) `>= 0` |
| C-TM-02 | `response.startedAt` et `response.endedAt` sont des strings ISO 8601 valides (parseables par `new Date()`) |
| C-TM-03 | Events utilisent `timestamp` wall ISO 8601 |

### 23.2 Résistance au clock jump

Setup critique : mock clock wall jumpe en arrière de 10 minutes pendant un call de 500ms.

| ID | Assertion |
| --- | --- |
| C-TM-04 | `response.durationMs > 0` et cohérent (≈ 500) — mesure monotone, pas wall |
| C-TM-05 | `startedAt` peut être après `endedAt` (wall jump en arrière) — c'est accepté, `durationMs` est la source de vérité |

### 23.3 Timeouts monotones

| ID | Assertion |
| --- | --- |
| C-TM-06 | Un timeout de 100ms se déclenche après ~100ms monotone même si wall jumpe de ±1h pendant le call |

---

## 24. Contract invariants — stats (`tests/contracts/stats.test.ts`)

### 24.1 Incréments sur succès uniquement

| ID | Scénario | Assertion |
| --- | --- | --- |
| C-ST-01 | 0 calls | `stats.totalCalls === 0`, tous à 0 |
| C-ST-02 | 1 call succès | `totalCalls === 1`, `totalInputTokens === usage.inputTokens` (si défini), etc. |
| C-ST-03 | 1 call échec fatal (401) | `totalCalls === 0` (pas d'incrément) |
| C-ST-04 | 1 call échec après épuisement retries | `totalCalls === 0` |
| C-ST-05 | 2 calls succès + 1 échec | `totalCalls === 2` |

### 24.2 Usage partiel

| ID | Scénario | Assertion |
| --- | --- | --- |
| C-ST-06 | Succès avec `usage.inputTokens === undefined` | `totalInputTokens` **non incrémenté** (reste à la valeur précédente, pas de `+= undefined`) |
| C-ST-07 | Succès avec `usage.inputTokens === 10`, mais `outputTokens === undefined` | `totalInputTokens += 10`, `totalOutputTokens` inchangé |

### 24.3 Pas de reset

| ID | Assertion |
| --- | --- |
| C-ST-08 | `stats` n'expose pas de méthode `reset()`. `typeof stats.reset === "undefined"` |
| C-ST-09 | Chaque instance d'adapter a son propre `stats` (deux adapters → deux états séparés) |

### 24.4 Immutabilité observable

| ID | Assertion |
| --- | --- |
| C-ST-10 | Les champs de `stats` sont `readonly` (assertion TS). Tentative de mutation au runtime : no-op ou throw (selon strict mode). |

### 24.5 Stats embedding

| ID | Scénario | Assertion |
| --- | --- | --- |
| C-ST-11 | EmbeddingAdapter après 3 calls succès | `totalCalls === 3`, `totalDurationMs > 0`, `totalInputTokens === 0`, `totalOutputTokens === 0` |
| C-ST-12 | EmbeddingAdapter, 1 échec terminal | `totalCalls === 0` |

---

## 25. Property tests (`tests/properties/properties.test.ts`)

### 25.1 Déterminisme des fonctions pures

| ID | Assertion |
| --- | --- |
| P-01 | `resolveRetryDecision(e, a, h, p)` appelé deux fois avec inputs identiques → retour deep-equal. Testé sur 100 inputs aléatoires. |
| P-02 | `resolveThrottleDecision(s, e, n)` idem. |
| P-03 | `parseRetryAfter(h)` idem. |
| P-04 | `estimateCallTokens(m, s, mt)` idem. |
| P-05 | `isRetriableKind(k)` idem. |
| P-06 | `classifyErrorBase(sig)` idem. |
| P-07 | `binding.buildRequest(req, cfg)` idem pour chaque binding, sur 20 requests aléatoires. |
| P-08 | `binding.parseResponse(body, headers)` idem pour chaque binding. |
| P-09 | `binding.terminationMap` est frozen (immutable). |

### 25.2 Immutabilité de `LLMRequest`

| ID | Assertion |
| --- | --- |
| P-10 | Pour 20 calls avec 20 requests différentes, après chaque `adapter.call(req)`, `req` est structurellement inchangé (deep-equal avec snapshot initial). |
| P-11 | `deepFreeze(req)` + `adapter.call(req)` → pas de throw (l'engine ne mute jamais). |
| P-12 | Pour 20 calls d'embedding avec `texts` different, `adapter.embed(texts)` ne mute pas `texts` (`deepFreeze` accepted). |

### 25.3 Unicité de callId

| ID | Assertion |
| --- | --- |
| P-13 | Sur 1000 calls consécutifs (avec mock clock qui avance), les `callId` sont tous distincts. |
| P-14 | Les `callId` sont en ordre lexicographique croissant (propriété ULID avec timestamp embedded). |

### 25.4 Shape du CanonicalHttpRequest

| ID | Assertion |
| --- | --- |
| P-15 | Pour chaque binding et 20 requests aléatoires : `canonicalRequest.method === "POST"`. |
| P-16 | `canonicalRequest.bodyKind === "json"` (pas de `"empty"` pour completions v1). |
| P-17 | `canonicalRequest.bodyJson` est toujours un **objet JS**, jamais une string pré-sérialisée. |
| P-18 | `canonicalRequest.headers` est `Record<string, string>`, tous les keys sont des strings non vides, toutes les values sont des strings. |

### 25.5 Shape du ParsedProviderResponse

| ID | Assertion |
| --- | --- |
| P-19 | `parsedResponse.rawContent` est toujours un string (jamais undefined/null). |
| P-20 | `parsedResponse.terminationSignal` est toujours un string non vide. |
| P-21 | `parsedResponse.usage` est un objet (champs individuels peuvent être undefined). |

### 25.6 Invariant du ProviderErrorSignal

| ID | Assertion |
| --- | --- |
| P-22 | Dans tous les signaux construits par l'engine : `headers` keys sont lowercase. Vérifié en introspectant les signaux via un classifier spy. |
| P-23 | `aborted === true` ⇒ `timeout === false` (priorité construit par l'engine). |
| P-24 | `networkErrorKind` ∈ `{"dns", "connection", "reset", "unknown"} ∪ {undefined}`. |

### 25.7 Ordre-indépendance du logger

| ID | Assertion |
| --- | --- |
| P-25 | La séquence d'events collectée ne dépend pas de l'implémentation du logger (default vs injecté). Sur 10 calls, les deux loggers reçoivent la même séquence. |

### 25.8 Robustesse au `LoggingPolicy.enabled: false`

| ID | Assertion |
| --- | --- |
| P-26 | Avec `enabled: false`, 100 calls variés ne produisent **zéro** event (ni stderr ni logger injecté). Le comportement fonctionnel (response, stats) reste identique. |

### 25.9 Isolation des adapters

| ID | Assertion |
| --- | --- |
| P-27 | Deux adapters Anthropic avec configurations différentes (modèle, apiKey) ont : `stats` séparés, snapshot throttle séparé, events correctement tagués avec leur propre `provider`/`model`. |

### 25.10 Headers post-fetch sont toujours en lowercase

| ID | Assertion |
| --- | --- |
| P-28 | Après `fetch`, les headers passés à `binding.parseResponse`, `binding.readRateLimitHeaders`, `binding.classifyError` sont en lowercase. Vérifié via spy sur le binding. |

### 25.11 Réponse vide ≠ truncation

| ID | Assertion |
| --- | --- |
| P-29 | Pour 10 cas où `rawContent` est non vide mais `content === ""` après sanitize : `integrity.truncationDetected === false` systématiquement. |

### 25.12 `detectHeuristicTruncation` stable

| ID | Assertion |
| --- | --- |
| P-30 | `detectHeuristicTruncation("", any)` retourne `false` pour 50 valeurs de `maxTokens`. |

---

## 26. Contract invariant global (`tests/global-contract.test.ts`)

Ces tests sont transversaux — ils traversent toute la surface publique pour vérifier des propriétés générales.

### 26.1 Surface publique exportée

| ID | Assertion |
| --- | --- |
| C-GL-01 | Le module `@vegacorp/llm-runtime` exporte : `LLMRequest`, `LLMResponse`, `LLMMessage`, `LLMRole`, `LLMUsage`, `LLMSanitizationInfo`, `LLMIntegrityInfo`, `TerminationReason`, `ProviderAdapter`, `EmbeddingAdapter`, `AdapterStats`, `AdapterConfig`, `EmbeddingAdapterConfig`, `ProviderLongId`, `LLMErrorKind`, `LLMRuntimeError` + 11 sous-classes, `RetryPolicy`, `TimeoutPolicy`, `SanitizationPolicy`, `IntegrityPolicy`, `LoggingPolicy`, `LLMLogger`, `isRetriableKind`, `buildSimplePrompt`, 5 factories |
| C-GL-02 | Le module n'exporte **pas** : `executeCall`, `executeEmbedding`, `CanonicalHttpRequest`, `ParsedProviderResponse`, `ProviderErrorSignal`, `RateLimitSnapshot`, `ProviderBinding`, `EmbeddingBinding`, `ProviderQuirks`, `clock`, `ulid` (internes) |
| C-GL-03 | Les sous-classes d'erreur sont toutes `instanceof LLMRuntimeError` (TS type + runtime check) |

### 26.2 Factories produisent des adapters valides

| ID | Assertion |
| --- | --- |
| C-GL-04 | `createAnthropicAdapter({...})` retourne un objet avec `provider === "anthropic"`, `model`, `stats`, `call` (function) |
| C-GL-05 | `createOpenAIAdapter` idem, `provider === "openai"` |
| C-GL-06 | `createOpenAICompatibleAdapter({ provider: "deepseek", ... })` → `provider === "deepseek"` |
| C-GL-07 | `createOpenAICompatibleAdapter({ provider: "mistral", ... })` → `provider === "mistral"` |
| C-GL-08 | `createOpenAICompatibleAdapter({ provider: "groq", ... })` → `provider === "groq"` |
| C-GL-09 | `createOpenAICompatibleAdapter({ provider: "together", ... })` → `provider === "together"` |
| C-GL-10 | `createOpenAICompatibleAdapter({ provider: "ollama", ... })` → `provider === "ollama"` |
| C-GL-11 | `createGoogleAdapter({...})` → `provider === "google"` |
| C-GL-12 | `createOpenAIEmbeddingAdapter({...})` retourne un `EmbeddingAdapter` avec `embed` (function), `provider === "openai"` |

### 26.3 `ProviderLongId` est fermé

| ID | Assertion |
| --- | --- |
| C-GL-13 | L'union `ProviderLongId` a exactement 8 valeurs : `"anthropic"`, `"openai"`, `"google"`, `"deepseek"`, `"mistral"`, `"groq"`, `"together"`, `"ollama"` |
| C-GL-14 | Un appel `createOpenAICompatibleAdapter({ provider: "unknown-xyz", ... })` : refusé (TS type error + runtime throw avec `InvalidRequestError` ou `TypeError`) |

### 26.4 Aucun SDK officiel en runtime dependency

| ID | Assertion |
| --- | --- |
| C-GL-15 | Le `package.json` `dependencies` contient exactement : `ulid`, `ai-json-safe-parse`. Aucune autre dépendance runtime. |
| C-GL-16 | `@anthropic-ai/sdk`, `openai`, `@google/generative-ai`, `axios`, `node-fetch`, `undici` ne sont **pas** dans `dependencies`. |

### 26.5 Fail-closed

Pour une liste de scénarios qui devraient throw, on vérifie que l'adapter throw bien (pas de réponse silencieusement dégradée).

| ID | Scénario | Attendu |
| --- | --- | --- |
| C-GL-17 | Request `messages: []` | throw `InvalidRequestError` |
| C-GL-18 | Request avec 2 system messages | throw `InvalidRequestError` |
| C-GL-19 | Request avec messages non alternés (2 user de suite) — v1 | throw `InvalidRequestError` OU accepté — **DÉCISION NIB-T** : accepté (passé au binding, qui peut échouer au fetch si le provider refuse). Le runtime ne valide pas l'alternance stricte. |
| C-GL-20 | Response 200 avec body `""` (vide) | throw `ResponseParseError` |
| C-GL-21 | Response 200 mais `Content-Type: text/html` (pas JSON) | throw `ResponseParseError` (JSON parse fail) |

### 26.6 Factories figent la config

| ID | Assertion |
| --- | --- |
| C-GL-22 | Modifier l'objet config après la création d'un adapter ne change pas le comportement de l'adapter (config snapshottée) |
| C-GL-23 | `adapter.model` est `readonly` (assertion TS) |
| C-GL-24 | `adapter.provider` est `readonly` |

### 26.7 Moteur unique

| ID | Assertion |
| --- | --- |
| C-GL-25 | Pour un même scénario d'erreur (ex. 500 × 5), 4 adapters différents (Anthropic, OpenAI, Google, DeepSeek) produisent une séquence d'events **structurellement identique** (mêmes eventType dans le même ordre) et throw **la même classe d'erreur** (`TransientProviderError`). Les seules différences sont `provider`, `model`, `callId`, `timestamps`. |

---

## 27. Helpers de test

Ce qui suit décrit les helpers à implémenter dans `tests/helpers/`. Ces helpers sont des **utilitaires de test**, pas du code de production — ils peuvent être écrits en parallèle des tests en RED.

### 27.1 `mock-fetch.ts`

```ts
// Fabrique une fonction fetch mockable qui retourne des réponses programmables.
export interface MockFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  calls: Array<{ url: string; init: RequestInit; body?: unknown }>;
  reset(): void;
}

// Simple : retourne une seule réponse toujours
export function createMockFetch(response: MockResponse | (() => MockResponse)): MockFetch;

// Avec scenario : réponses séquentielles (pour tester retries)
export function createScenarioFetch(responses: MockResponse[]): MockFetch;

export interface MockResponse {
  status: number;
  body: unknown;                  // Objet JS, sérialisé en JSON par le mock
  headers?: Record<string, string>;
  delayMs?: number;               // Latence simulée (utilise mockClock)
  throwError?: Error;             // Si défini, le mock throw au lieu de retourner
}
```

### 27.2 `mock-clock.ts`

```ts
// Horloge contrôlable pour tests déterministes.
export interface MockClock {
  setWall(isoOrDate: string | Date): void;
  setMono(ms: number): void;
  advanceMono(ms: number): void;
  advanceWall(ms: number): void;
  nowWall(): Date;
  nowWallIso(): string;
  nowMono(): number;
  // Install/uninstall : remplace le module clock du runtime par ce mock.
  install(): void;
  uninstall(): void;
}

export function createMockClock(initialWall?: string, initialMono?: number): MockClock;
```

### 27.3 `mock-logger.ts`

```ts
// Logger qui collecte les events en mémoire pour inspection en test.
export interface MockLogger {
  emit(event: LLMEvent): void;
  events: LLMEvent[];
  reset(): void;
  // Assertions composites
  find(eventType: string): LLMEvent | undefined;
  findAll(eventType: string): LLMEvent[];
  eventTypes(): string[];  // Séquence ordonnée des eventType
}

export function createMockLogger(): MockLogger;
```

### 27.4 `mock-signal.ts`

```ts
// AbortSignal contrôlable avec timing précis.
export interface ControlledSignal {
  signal: AbortSignal;
  abort(reason?: unknown): void;
  abortAfter(ms: number, reason?: unknown): void;  // Utilise mockClock
}

export function createControlledSignal(): ControlledSignal;
```

### 27.5 `fixture-loader.ts`

```ts
// Charge une fixture JSON depuis tests/fixtures/.
export function loadFixture(relativePath: string): string;
export function loadJsonFixture<T = unknown>(relativePath: string): T;

// Charge un scénario de réponses : tableau de MockResponse depuis un fichier.
export function loadScenario(name: string): MockResponse[];
```

### 27.6 `fetch-scenario.ts`

```ts
// Construit rapidement des scénarios multi-réponses lisibles.
export const scenario = {
  rateLimit: (retryAfterSec?: number) => MockResponse,  // 429
  overloaded: () => MockResponse,                       // 529
  serverError: () => MockResponse,                      // 500
  authError: () => MockResponse,                        // 401
  invalidRequest: () => MockResponse,                   // 400
  ok: (provider: ProviderLongId, content: string) => MockResponse,
  okFixture: (fixtureName: string) => MockResponse,
  timeout: (afterMs: number) => MockResponse,           // retarde puis throw
  networkError: (kind: string) => MockResponse,
};

// Exemple d'usage : scenarios([scenario.rateLimit(1), scenario.okFixture("anthropic/ok-simple")])
```

### 27.7 `event-assertions.ts`

```ts
// Assertions composites sur une séquence d'events.
export const eventAssertions = {
  sequenceMatches(events: LLMEvent[], expectedTypes: string[]): void;
  allSameCallId(events: LLMEvent[]): void;
  noRetryScheduled(events: LLMEvent[]): void;
  countOfType(events: LLMEvent[], eventType: string): number;
  endEventFinal(events: LLMEvent[]): void;  // Le dernier event est *_end
  noPIIIn(events: LLMEvent[], forbiddenTexts: string[]): void;
};
```

### 27.8 Pour les property tests

Pas d'outil tiers requis (pas de `fast-check`). Les property tests utilisent des boucles déterministes avec seeds fixes :

```ts
// Utilitaire simple pour générer des inputs pseudo-aléatoires reproductibles
export function seededRandom(seed: number): {
  randomString(maxLen: number): string;
  randomInt(min: number, max: number): number;
  randomBool(): boolean;
  randomMessages(count: number): LLMMessage[];
};
```

Les tests de propriété itèrent typiquement 20-100 fois avec seeds dérivés (1, 2, 3, ...) — reproductible en cas d'échec.

---

## 28. Principes transversaux et règles de rédaction

### 28.1 Quand un GREEN est ambigu — procédure

Plusieurs vecteurs sont marqués "DÉCISION" dans ce NIB-T : la spécification laisse une latitude réelle sur un point, et le NIB-T tranche. Si GREEN découvre qu'une autre interprétation est plus adéquate (performance, simplicité, alignement provider), le protocole est :

1. Documenter l'observation dans un commentaire au-dessus du vecteur de test.
2. Mettre à jour le vecteur (valeur attendue + justification).
3. Valider que le vecteur mis à jour reste cohérent avec la spec (sinon c'est un écart normatif à remonter au niveau spec).

Ceci matérialise la règle : "une fixture rate, on questionne la fixture avant de questionner le code" (appliquée au niveau normatif).

### 28.2 Couverture attendue

| Zone | Couverture branches cible | Couverture lines cible |
| --- | --- | --- |
| Services transversaux (Layer 4) | ≥ 95% | ≥ 98% |
| Bindings (Layer 3) | ≥ 90% | ≥ 95% |
| Engine (Layer 2) | ≥ 90% | ≥ 95% |
| Adapters (Layer 1) | ≥ 85% | ≥ 95% |
| **Global** | **≥ 90%** | **≥ 95%** |

Ces cibles alignent avec . Le taux de 90%/95% est un plancher — les décisions matérialisées (retry/throttle/termination) doivent être à 100% par testabilité exhaustive des fonctions pures.

### 28.3 Pas de test à internet

Sauf les tests d'intégration opt-in (non couverts par ce NIB-T), **aucun test de ce corpus ne doit faire d'appel réseau réel**. Tous les tests reposent sur `mock-fetch` + `mock-clock` + `mock-logger`. Critère de succès : `npm test` passe **offline**.

### 28.4 Granularité des fichiers de test

La découpe par module (un fichier `.test.ts` par section §N) est indicative. Le GREEN peut regrouper ou fractionner selon l'ergonomie, à condition de préserver :
- Les identifiants `T-XX-NN`, `P-NN`, `C-NN` (même si dispersés).
- La traçabilité par un `it.each` ou équivalent nommé (`it("T-RR-01 | AuthError jamais retried", ...)`).
- Le mapping inverse test → section NIB-T via un commentaire de header dans chaque fichier.

### 28.5 Vocabulaire de test

- **Acceptance test (vecteur)** : un cas concret avec entrée et sortie attendues. Porte un `T-XX-NN`.
- **Property test** : un invariant vérifié sur un échantillon d'inputs. Porte un `P-NN`.
- **Contract invariant** : une règle transversale appliquée à toutes les exécutions. Porte un `C-NN`.

Si un test ne rentre dans aucune des trois catégories, c'est probablement un test unitaire d'implémentation → il émerge en GREEN, pas ici.

### 28.6 Un échec = un diagnostic

Chaque vecteur doit être rédigé de sorte que son échec donne un diagnostic immédiat :
- Nom du test explicite (inclut l'ID et une description humaine).
- Assertion fine (une propriété par assertion, pas un gros `toEqual` qui masque l'écart).
- Fixture identifiable (nommée explicitement, pas lambda).

Cette discipline est ce qui permet à GREEN de converger vite.

---

## 29. Total testable — récapitulatif

| Catégorie | Compte |
| --- | --- |
| Acceptance tests (`T-`) | ~424 vecteurs définis en tableau |
| Property tests globaux (`P-NN`) | 30 (§25) |
| Property tests locaux (`P-{trigramme}-{lettre}`) | ~31 |
| Contract invariants (`C-`) | ~103 (99 en tableau + 4 en bullet) |
| **Total** | **~588 tests** |

Volume cohérent avec la surface du runtime (11 erreurs, 5 policies, 14 events, 5 bindings, 3 décisions matérialisées, propriétés temporelles et de signal). Chaque sous-système a son front de test adressable.

Les chiffres sont des comptes automatiques au moment de l'éclatement RED ; des ajustements pendant GREEN (ajouts ciblés, regroupements parameterized) peuvent faire bouger le total dans les deux sens, sans changer la couverture du contrat observable.

---

## 30. Ce que ce NIB-T ne teste pas

Par design, ces zones sont hors scope du NIB-T :

- **Tests de performance** : latence, débit, memoize. Peuvent être ajoutés en bench séparé, pas en NIB-T.
- **Tests d'intégration live** : contre vraies APIs. Opt-in, orchestrés par CI avec secrets.
- **Tests de fuite mémoire long-running** : heures de calls consécutifs. Mesure séparée.
- **Tests de chaos** : injection aléatoire de failures concurrentes. Hors scope v1.
- **Tests d'internationalisation des prompts** : v1 est agnostique au contenu.
- **Tests d'implémentation interne** : forme du retry-resolver code, structure du snapshot store, etc. — émergent en GREEN.

---

*@vegacorp/llm-runtime — Implicit-Free Execution — "La fiabilité précède l'intelligence."*
