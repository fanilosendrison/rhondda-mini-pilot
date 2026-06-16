---
id: NIB-M-TOKEN-ESTIMATOR
type: nib-module
version: "1.0.0"
scope: llm-runtime
module: token-estimator
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-M-TOKEN-ESTIMATOR — Module Brief — `estimateCallTokens`

**Package** : `@vegacorp/llm-runtime`
**Source NX** : §5.5 (token-estimator), §13.5 (estimation grossière)
**NIB-T associé** : §2.5 (T-TE-01..04) si présent dans le NIB-T

---

## 1. Purpose

Ce module fournit une **estimation grossière** du coût en tokens d'un call de completion, utilisée **exclusivement** par le throttle-resolver (NIB-M-THROTTLE) pour décider si le budget rate-limit courant suffit pour le call à venir.

**Précision requise** : faible. L'estimation ne doit **pas** être utilisée pour :
- Calculer le coût monétaire d'un call
- Décider de tronquer un prompt
- Alimenter des métriques de billing
- Remplir `LLMUsage` dans `LLMResponse`

Elle sert **uniquement** à **l'aide à la décision** pour le throttle proactif. Si l'estimation est fausse de ±30%, l'impact est au pire un throttle en excès (on attend un peu plus que nécessaire) ou un 429 laissé au retry réactif (qui rattrape). Aucune garantie de fiabilité downstream ne dépend de cette estimation.

La philosophie est alignée avec l'ensemble du runtime : **fail-closed sur les décisions critiques, tolérance sur les heuristiques non critiques**.

---

## 2. Inputs / Outputs

### 2.1 Consommé par ce module

- Type `LLMRequest` (NIB-S §5.1) — en particulier `request.messages[]` et `request.maxTokens?`.
- String `model` (nom du modèle pour éventuelle spécialisation future).

### 2.2 Produit par ce module

**Interne (non exporté publiquement)** :

```ts
function estimateCallTokens(
  request: LLMRequest,
  model: string
): number;
```

### 2.3 Consommateurs

- **NIB-M-THROTTLE** (step 6.b de `executeCall`) : `const estimated = estimateCallTokens(request, config.model);`
- Aucun autre consommateur.

---

## 3. Algorithme

### 3.1 Signature

```ts
function estimateCallTokens(
  request: LLMRequest,
  model: string
): number;
```

**Entrée** :
- `request.messages[]` : tableau de `LLMMessage`, chacun avec un `content: string`.
- `request.maxTokens?: number` : budget de tokens de sortie.
- `model: string` : nom du modèle (non utilisé en v1, réservé pour spécialisation future — voir §6).

**Sortie** : nombre entier positif. Estimation en tokens (input + output approximé).

### 3.2 Heuristique v1

```ts
function estimateCallTokens(request: LLMRequest, model: string): number {
  // 1. Somme des caractères des messages
  const totalChars = request.messages.reduce(
    (acc, msg) => acc + msg.content.length,
    0
  );

  // 2. Conversion grossière : 1 token ≈ 4 caractères (moyenne observée anglais + code)
  const inputTokensApprox = Math.ceil(totalChars / 4);

  // 3. Overhead constant pour les markers de rôle et structure de chat
  const overhead = request.messages.length * 10;

  // 4. Budget de sortie (output tokens)
  const outputBudget = request.maxTokens ?? 4000;  // default conservateur si non spécifié

  return inputTokensApprox + overhead + outputBudget;
}
```

### 3.3 Constantes de calcul

| Constante | Valeur v1 | Justification |
| --- | --- | --- |
| `charsPerToken` | 4 | Moyenne observée pour l'anglais + code. Sous-estime pour le français (plus proche de 3,5), surestime pour les langues asiatiques (plus proche de 1,5). Accepté en v1 — l'estimation n'a pas besoin d'être précise. |
| `overheadPerMessage` | 10 | Approximation des tokens consommés par les markers de rôle (`<|user|>`, `<|assistant|>`, etc.) et la structure de chat interne aux providers. |
| `defaultOutputBudget` | 4000 | Valeur conservatrice si `maxTokens` non spécifié. Correspond à un ordre de grandeur typique pour les tâches de complétion structurée. |

**Ces constantes sont codées en dur en v1**. Elles ne sont **pas** exposées en config. Rationale : le throttle ne dépend pas de leur précision. Le jour où l'heuristique doit être affinée (per-model par exemple), on sort ce module du NIB-M et on ouvre un NX dédié.

### 3.4 Pureté

Fonction **pure**. Aucun effet de bord, aucune lecture d'état externe. Deux appels avec mêmes arguments → même résultat.

Testable exhaustivement par vecteurs de test statiques.

### 3.5 Rationale pour ne pas utiliser une vraie tokenization

**Options non retenues en v1** :

| Option | Raison du rejet |
| --- | --- |
| `tiktoken` (OpenAI) | Dépendance wasm lourde (~2 MB). Overkill pour une aide à la décision. |
| `@anthropic-ai/tokenizer` | Lib officielle mais uniquement pour Anthropic. Pas multi-provider. |
| Appel au provider pour compter | Round-trip réseau inacceptable avant chaque call. |
| Tokenizer custom par modèle | Complexité énorme pour un gain marginal sur le throttle. |

Le runtime fait le pari qu'une **estimation grossière + retry réactif sur 429** est **plus robuste** qu'une tokenization précise qui ajouterait une dépendance et un risque de divergence entre l'estimation et le comptage réel du provider.

---

## 4. Exemples

### 4.1 Request simple

```ts
const request: LLMRequest = {
  messages: [
    { role: "user", content: "Bonjour, comment ça va ?" }  // 25 chars
  ],
  maxTokens: 500
};

estimateCallTokens(request, "claude-opus-4-7");
// totalChars = 25
// inputTokensApprox = ceil(25 / 4) = 7
// overhead = 1 * 10 = 10
// outputBudget = 500
// → 7 + 10 + 500 = 517 tokens
```

### 4.2 Request multi-turn

```ts
const request: LLMRequest = {
  messages: [
    { role: "system", content: "You are a helpful assistant." },    // 30 chars
    { role: "user", content: "What is the capital of France?" },    // 30 chars
    { role: "assistant", content: "The capital of France is Paris." }, // 32 chars
    { role: "user", content: "And Belgium?" }                       // 12 chars
  ],
  maxTokens: 300
};

estimateCallTokens(request, "claude-opus-4-7");
// totalChars = 30 + 30 + 32 + 12 = 104
// inputTokensApprox = ceil(104 / 4) = 26
// overhead = 4 * 10 = 40
// outputBudget = 300
// → 26 + 40 + 300 = 366 tokens
```

### 4.3 Request sans `maxTokens` (fallback conservateur)

```ts
const request: LLMRequest = {
  messages: [{ role: "user", content: "Write me a short story." }]  // 23 chars
  // maxTokens non spécifié
};

estimateCallTokens(request, "gpt-4o");
// totalChars = 23
// inputTokensApprox = ceil(23 / 4) = 6
// overhead = 1 * 10 = 10
// outputBudget = 4000 (default conservateur)
// → 6 + 10 + 4000 = 4016 tokens
```

### 4.4 Request avec prompt très long

```ts
const longContent = "x".repeat(20000);  // 20k chars
const request: LLMRequest = {
  messages: [{ role: "user", content: longContent }],
  maxTokens: 2000
};

estimateCallTokens(request, "claude-opus-4-7");
// totalChars = 20000
// inputTokensApprox = ceil(20000 / 4) = 5000
// overhead = 1 * 10 = 10
// outputBudget = 2000
// → 5000 + 10 + 2000 = 7010 tokens
```

---

## 5. Edge cases

| Cas | Comportement attendu | Test |
| --- | --- | --- |
| `messages: []` (invalide en amont mais défensif) | `totalChars = 0`, `overhead = 0`. Retourne `0 + 0 + 4000 (ou maxTokens) = 4000`. Pas de throw — la validation du request vit dans l'engine step 5, pas ici. | T-TE-XX |
| `messages[i].content === ""` | `length === 0`, comptabilisé comme 0 chars. Overhead toujours +10 par message. Valide. | — |
| `maxTokens === 0` | `outputBudget = 0`. Estimation = input + overhead. Valide (peut arriver si le consommateur veut juste valider sans sortie). | — |
| `maxTokens === -1` ou négatif | La fonction ne valide pas le signe. Retourne `input + overhead + (-1)`, probablement négatif. **Acceptable** v1 — `LLMRequest.maxTokens: number` n'a pas de contrainte de signe dans le contrat. Si la valeur est absurde, c'est au throttle d'être robuste (et il l'est : `estimatedTokens <= remainingTokens` fonctionne même avec un négatif, ça dit toujours "budget OK"). | — |
| Caractères multi-byte UTF-8 (emojis, idéogrammes) | `String.length` compte en **UTF-16 code units**, pas en caractères Unicode. Un emoji surrogate pair compte pour 2. L'heuristique reste correcte à ±20% — accepté v1. | — |
| `model` différent | Ignoré en v1. Le même estimateur s'applique à tous les modèles. | — |
| `request.temperature`, `stopSequences` | Ignorés — non pertinents pour l'estimation tokens. | — |

---

## 6. Constraints (invariants spécifiques)

### C-TE1 — Pureté

Fonction pure. Pas d'accès clock, pas de log, pas d'I/O.

### C-TE2 — Retourne toujours un nombre

Pas de `null`, `undefined`, `NaN`. Si les inputs sont cohérents avec le type `LLMRequest`, le résultat est un entier ≥ 0. Si les inputs sont pathologiques (ex. `maxTokens = -999999`), le résultat peut être négatif, mais c'est hors contrat.

### C-TE3 — Pas de spécialisation per-model en v1

Le paramètre `model` est reçu mais **non utilisé**. Ne pas préparer l'infrastructure pour plusieurs tokenizers per-model en v1 (YAGNI). Si le besoin émerge : NX séparé pour un vrai module `tokenizer-registry`.

### C-TE4 — Constantes codées en dur

`charsPerToken = 4`, `overheadPerMessage = 10`, `defaultOutputBudget = 4000` sont codés en dur. Pas de config utilisateur pour les override en v1.

### C-TE5 — Ne jamais throw

La fonction ne throw **jamais**. Inputs pathologiques → résultat pathologique, pas d'exception. Rationale : le throttle est une heuristique best-effort, et une exception ici casserait le call pour une raison non critique.

### C-TE6 — Ne sert qu'au throttle-resolver

Usage unique, borné. Pas de généralisation vers d'autres consommateurs en v1.

---

## 7. Integration

### 7.1 Depuis `executeCall` (NIB-M-EXECUTE-CALL step 6.b)

```ts
import { estimateCallTokens } from "../services/token-estimator";
import { resolveThrottleDecision } from "../services/throttle-resolver";

// Avant chaque attempt, dans la boucle retry :
const estimated = estimateCallTokens(request, config.model);
const snapshot = snapshotService.get();
const decision = resolveThrottleDecision(snapshot, estimated, clock.nowMono());

if (decision.throttle) {
  logger.emit({
    eventType: "llm_call_throttled",
    callId, provider, model, attempt, timestamp: clock.nowWallIso(),
    waitMs: decision.waitMs!,
    reason: decision.reason,
    snapshotState: snapshot?.state ?? "none",
    estimatedTokens: estimated  // <-- loggé pour debug
  });
  // ... abortableSleep
}
```

L'estimation apparaît dans l'event `llm_call_throttled` (champ `estimatedTokens`) uniquement — nulle part ailleurs. Utile pour diagnostic post-mortem ("pourquoi tant de throttle ?").

### 7.2 Pas d'usage dans `executeEmbedding`

Les embeddings ne passent **pas** par ce module en v1. L'embedding a sa propre dynamique (batch de textes, pas de `maxTokens`) et le throttle embedding, s'il est implémenté, utilisera un estimateur ad-hoc (probablement : `texts.reduce((acc, t) => acc + ceil(t.length / 4), 0)`). Voir NIB-M-EXECUTE-EMBEDDING §... si applicable.

**Décision v1** : `executeEmbedding` n'applique **pas** de throttle proactif. Il repose sur le retry réactif sur 429. Justification : les embeddings providers exposent rarement des headers rate-limit granulaires comparables à ceux des completions, et les batchs sont de coût plus prévisible. Raffinement possible v1.1.

---

## 8. Relationship avec les autres NIB-M

| NIB-M | Relation |
| --- | --- |
| **NIB-M-THROTTLE** | Seul consommateur. Reçoit l'estimation pour `resolveThrottleDecision`. |
| **NIB-M-EXECUTE-CALL** | Appelle l'estimator au step 6.b. Log la valeur dans `llm_call_throttled`. |

Aucune relation avec les autres NIB-M. Module totalement isolé.

---

## 9. Tests de référence (NIB-T)

Tests recommandés (NIB-T §2.5 si présent, sinon à créer dans un futur update NIB-T) :

| Zone | Description |
| --- | --- |
| T-TE-01 | Request simple 1 message, `maxTokens` fourni → résultat attendu exact |
| T-TE-02 | Request multi-turn, 4 messages → vérification sum + overhead |
| T-TE-03 | `maxTokens` absent → default 4000 appliqué |
| T-TE-04 | `messages: []` → résultat = 0 + 0 + defaultOutput |
| T-TE-05 | `messages[i].content = ""` → overhead appliqué, pas de throw |
| P-TE-a | Pureté : 50 appels mêmes inputs → 50 mêmes outputs |

---

## 10. Implémentation cible

**Fichier** : `src/services/token-estimator.ts` — **~20 LOC**

```ts
import type { LLMRequest } from "../types/request-response";

const CHARS_PER_TOKEN = 4;
const OVERHEAD_PER_MESSAGE = 10;
const DEFAULT_OUTPUT_BUDGET = 4000;

export function estimateCallTokens(
  request: LLMRequest,
  _model: string
): number {
  const totalChars = request.messages.reduce(
    (acc, msg) => acc + msg.content.length,
    0
  );
  const inputTokensApprox = Math.ceil(totalChars / CHARS_PER_TOKEN);
  const overhead = request.messages.length * OVERHEAD_PER_MESSAGE;
  const outputBudget = request.maxTokens ?? DEFAULT_OUTPUT_BUDGET;

  return inputTokensApprox + overhead + outputBudget;
}
```

Le paramètre `_model` est préfixé d'un underscore pour marquer explicitement qu'il est accepté dans la signature (cohérence avec évolution future) mais non utilisé en v1.

---

*VegaCorp — Implicit-Free Execution (IFE) — "La fiabilité précède l'intelligence."*
