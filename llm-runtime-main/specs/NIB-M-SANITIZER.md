---
id: NIB-M-SANITIZER
type: nib-module
version: "1.0.0"
scope: llm-runtime
module: sanitizer
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-M-SANITIZER — Module Brief — `sanitizeContent` et détection heuristique

**Package** : `@vegacorp/llm-runtime`
**Source NX** : §5.5 (sanitizer), §7 (LLMResponse), §11.5 (event llm_call_sanitized)
**NIB-T associé** : §7 (sanitizer)
**DC associé** : **DC-AI-JSON-SAFE-PARSE** (dépendance `ai-json-safe-parse ^0.3.0`)

---

## 1. Purpose

Ce module encapsule les **transformations contrôlées** appliquées au contenu texte brut retourné par un provider, avant que l'engine ne construise `LLMResponse.content`. Trois responsabilités :

1. **Strip thinking tags** (`<thinking>...</thinking>`) — retire les blocs de raisonnement explicite insérés par certains modèles (ex. Anthropic extended thinking).
2. **Strip JSON fence** (`` ```json ... ``` ``) — retire les markdown code fences autour d'un JSON, produites par les modèles qui ajoutent ce formatting malgré des instructions explicites.
3. **Detect heuristic truncation** — évalue si le contenu texte semble incomplet (JSON non fermé) quand `IntegrityPolicy.detectHeuristicTruncation === true`.

La logique de sanitization est **purement textuelle** (pas de parsing JSON strict, pas de reformulation). Les transformations sont **additives et commutatives** : strip thinking, puis strip fence. L'ordre est fixé et normatif.

La détection heuristique de truncation utilise la bibliothèque `ai-json-safe-parse` (voir **DC-AI-JSON-SAFE-PARSE**) — elle est opt-in stricte via `IntegrityPolicy.detectHeuristicTruncation`.

---

## 2. Inputs / Outputs

### 2.1 Consommé par ce module

- **`ai-json-safe-parse`** (`^0.3.0`) — dépendance externe, voir DC-AI-JSON-SAFE-PARSE. Utilisé exclusivement pour l'analyse heuristique de JSON (détection d'accolades non fermées).
- Types `SanitizationPolicy`, `LLMSanitizationInfo`, `LLMIntegrityInfo` (NIB-S §5.1-§5.2).

### 2.2 Produit par ce module

**Interne (non exporté publiquement)** :

```ts
interface SanitizationResult {
  sanitizedContent: string;
  rawContent: string;
  sanitization: LLMSanitizationInfo;
  integrity: LLMIntegrityInfo;
}

function sanitizeContent(
  rawContent: string,
  effectiveSanitization: Required<SanitizationPolicy>,
  integrityPolicy: IntegrityPolicy,
  explicitTerminationIsMaxTokens: boolean
): SanitizationResult;
```

### 2.3 Consommateurs

- **NIB-M-EXECUTE-CALL** (step 7.m et 7.n) : appelle `sanitizeContent` avec le raw content de la réponse parsée, la policy de sanitization **résolue** (merge defaults binding + overrides config), et la policy d'intégrité.

---

## 3. Algorithme — `sanitizeContent`

### 3.1 Signature

```ts
function sanitizeContent(
  rawContent: string,
  effectiveSanitization: Required<SanitizationPolicy>,
  integrityPolicy: IntegrityPolicy,
  explicitTerminationIsMaxTokens: boolean
): SanitizationResult;
```

**Entrée** :
- `rawContent: string` — contenu brut extrait par le binding via `parseResponse`. Jamais `null`/`undefined`.
- `effectiveSanitization` — policy de sanitization **résolue** par l'engine : `{ stripThinkingTags: boolean, stripJsonFence: boolean }` (tous champs obligatoires après résolution).
- `integrityPolicy` — policy d'intégrité complète (`IntegrityPolicy`). Utilisée pour décider si la détection heuristique doit tourner.
- `explicitTerminationIsMaxTokens: boolean` — passé par l'engine après le mapping `terminationReason`. Permet de marquer `truncationDetected: true` avec `truncationMode: "explicit_max_tokens"` sans que cela constitue une erreur.

**Sortie** :
```ts
{
  sanitizedContent: string,    // contenu après strip(s)
  rawContent: string,          // rawContent inchangé (retourné pour simplicité d'API)
  sanitization: {
    thinkingTagsRemoved: boolean,
    jsonFenceRemoved: boolean
  },
  integrity: {
    truncationDetected: boolean,
    truncationMode?: "explicit_max_tokens" | "heuristic_json_unclosed" | "silent_prompt_truncation"
  }
}
```

### 3.2 Ordre normatif des opérations

**Ordre fixé** : (1) strip thinking → (2) strip JSON fence → (3) detect heuristic truncation.

Cet ordre est **normatif**. Justification :
- Strip thinking d'abord pour ne pas confondre un bloc `<thinking>...```json ...```...</thinking>` avec un fence réel autour du vrai contenu.
- Strip fence ensuite pour extraire le JSON brut.
- Detect truncation à la fin pour analyser le contenu final (post-strip).

### 3.3 Strip thinking tags

**Comportement** : retire tous les blocs `<thinking>...</thinking>` du contenu.

**Pseudocode** :
```ts
function stripThinkingTags(text: string): { cleaned: string, removed: boolean } {
  const THINKING_RE = /<thinking>[\s\S]*?<\/thinking>/gi;
  const cleaned = text.replace(THINKING_RE, "").trim();
  return { cleaned, removed: cleaned !== text };
}
```

**Règles normatives** :
- Regex **non-greedy** (`*?`) pour matcher le plus petit bloc possible — évite d'absorber du contenu entre deux blocs distincts.
- Flag `i` (insensible à la casse) : matche `<THINKING>` comme `<thinking>`.
- Flag `g` (global) : retire **tous** les blocs, pas seulement le premier.
- `[\s\S]` pour matcher newlines (équivalent de `/s` flag, utilisé pour compat large).
- **Trim final** : supprime les whitespaces de tête et de queue qui restent après le strip. Important pour comparaisons `content === ""`.
- **`removed = true` si le contenu a changé** (y compris si le strip n'a retiré que des whitespaces résiduels via le trim).

**Exemples** :

| Input | Output | `removed` |
| --- | --- | --- |
| `"<thinking>step 1</thinking>answer"` | `"answer"` | `true` |
| `"answer"` | `"answer"` | `false` |
| `"<thinking>only thinking</thinking>"` | `""` | `true` |
| `"<thinking>a</thinking><thinking>b</thinking>result"` | `"result"` | `true` |
| `"before<thinking>a</thinking>after"` | `"afterbefore"` (non — voir test ci-dessous) | `true` |
| `"  <thinking>x</thinking>  hello  "` | `"hello"` (trim appliqué) | `true` |

*Correction du cas "before...after"* : le strip retire `<thinking>a</thinking>` → `"beforeafter"` → trim → `"beforeafter"`. (Pas de `"afterbefore"` — c'était une faute dans mon tableau.)

**Edge case critique** :
- Tag ouvert sans fermeture : `"<thinking>unclosed"`. La regex ne match pas (pas de `</thinking>`). Aucun strip, `removed: false`. Le contenu est renvoyé intact. **Ne pas essayer d'être malin** (heuristique de fermeture = risque de détruire du contenu légitime).

### 3.4 Strip JSON fence

**Comportement** : retire un fence markdown `` ```json ... ``` `` (ou `` ``` ... ``` ``) qui encapsule la totalité du contenu.

**Pseudocode** :
```ts
function stripJsonFence(text: string): { cleaned: string, removed: boolean } {
  const trimmed = text.trim();

  // Pattern 1: ```json ... ```
  const JSON_FENCE_RE = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/;
  const match = trimmed.match(JSON_FENCE_RE);

  if (match) {
    return { cleaned: match[1].trim(), removed: true };
  }

  return { cleaned: text, removed: false };
}
```

**Règles normatives** :
- **Fence doit englober la totalité du contenu** (ancres `^...$`). Pas de strip partiel. Rationale : un fence en plein milieu du contenu peut être légitime (ex. explication avec exemple de code) — on ne le touche pas.
- La langue `json` est **optionnelle** : matche aussi bien `` ```json\n{}\n``` `` que `` ```\n{}\n``` ``. Autres langues (`` ```python ``) ne matchent **pas** — on ne strip que pour des fences qu'on considère JSON-targetés.
- Le contenu interne est **retrimé** après extraction.
- Si le fence n'englobe pas la totalité, retour à l'original sans strip.

**Exemples** :

| Input | Output | `removed` |
| --- | --- | --- |
| `` "```json\n{\"a\":1}\n```" `` | `"{\"a\":1}"` | `true` |
| `` "```\n{\"a\":1}\n```" `` | `"{\"a\":1}"` | `true` |
| `` "```json\n{\"a\":1}\n```trailing" `` | Inchangé | `false` |
| `` "text before ```json\n{}\n``` text after" `` | Inchangé | `false` |
| `` "```python\nprint('hi')\n```" `` | Inchangé | `false` |
| `"{\"a\":1}"` (pas de fence) | Inchangé | `false` |

### 3.5 Detect heuristic truncation

**Trigger** : uniquement si `integrityPolicy.detectHeuristicTruncation === true`.

**Algorithme** :
```ts
function detectHeuristicTruncation(
  sanitizedContent: string,
  integrityPolicy: IntegrityPolicy
): { detected: boolean, mode?: LLMIntegrityInfo["truncationMode"] } {
  if (!integrityPolicy.detectHeuristicTruncation) {
    return { detected: false };
  }

  // Ne pas exécuter sur du contenu vide ou des chaînes manifestement non-JSON
  if (sanitizedContent.length === 0) return { detected: false };

  const trimmed = sanitizedContent.trimStart();
  const firstChar = trimmed[0];
  const looksLikeJson = firstChar === "{" || firstChar === "[";
  if (!looksLikeJson) return { detected: false };

  // Analyse via ai-json-safe-parse (DC-AI-JSON-SAFE-PARSE)
  // On utilise l'information d'erreur structurée pour détecter
  // une incomplétude (accolades/crochets non fermés).
  const parseResult = aiJsonSafeParse.analyze(sanitizedContent);
  // Voir DC-AI-JSON-SAFE-PARSE pour l'API exacte.

  if (parseResult.status === "incomplete") {
    return { detected: true, mode: "heuristic_json_unclosed" };
  }

  return { detected: false };
}
```

**Règles normatives** :
- **Opt-in strict** : si `detectHeuristicTruncation: false`, la fonction retourne immédiatement `{ detected: false }` sans analyser.
- **Appliqué post-sanitization** : analyse `sanitizedContent` (après strip thinking + fence), pas `rawContent`.
- **Heuristique limitée à JSON** : la détection n'a de sens que sur du contenu JSON-like. Si le premier caractère non-whitespace n'est ni `{` ni `[`, on ne détecte pas.
- **Délégation à `ai-json-safe-parse`** : l'analyse structurelle est déléguée à la lib. **Voir DC-AI-JSON-SAFE-PARSE** pour le contrat exact de l'API (`analyze` ou équivalent).
- **Pas de mode `"silent_prompt_truncation"` v1** : ce mode existe dans `LLMIntegrityInfo.truncationMode` mais **n'est pas détecté par ce module** en v1. Il provient d'une heuristique externe (ratio `prompt_tokens < sentChars / 8`) qui sera potentiellement intégrée en v1.1. En v1, seul `heuristic_json_unclosed` peut être produit par ce sanitizer.

### 3.6 Combinaison et sortie finale

```ts
function sanitizeContent(
  rawContent: string,
  effectiveSanitization: Required<SanitizationPolicy>,
  integrityPolicy: IntegrityPolicy,
  explicitTerminationIsMaxTokens: boolean
): SanitizationResult {
  let current = rawContent;
  let thinkingTagsRemoved = false;
  let jsonFenceRemoved = false;

  // Ordre normatif : thinking puis fence
  if (effectiveSanitization.stripThinkingTags) {
    const r = stripThinkingTags(current);
    current = r.cleaned;
    thinkingTagsRemoved = r.removed;
  }

  if (effectiveSanitization.stripJsonFence) {
    const r = stripJsonFence(current);
    current = r.cleaned;
    jsonFenceRemoved = r.removed;
  }

  // Détection heuristique (opt-in)
  const heuristic = detectHeuristicTruncation(current, integrityPolicy);

  // Construction de integrity.truncationDetected et truncationMode
  let truncationDetected = false;
  let truncationMode: LLMIntegrityInfo["truncationMode"] | undefined;

  if (explicitTerminationIsMaxTokens) {
    truncationDetected = true;
    truncationMode = "explicit_max_tokens";
  } else if (heuristic.detected) {
    truncationDetected = true;
    truncationMode = heuristic.mode;
  }

  return {
    sanitizedContent: current,
    rawContent,
    sanitization: { thinkingTagsRemoved, jsonFenceRemoved },
    integrity: { truncationDetected, truncationMode }
  };
}
```

### 3.7 Précédence `explicit` > `heuristic`

Si le provider a explicitement signalé `finish_reason: "max_tokens"` (mappé en `"max_tokens"` via `terminationMap`), l'engine passe `explicitTerminationIsMaxTokens: true`. Dans ce cas, **le mode explicit prime** même si l'heuristique aurait détecté un JSON non fermé.

Rationale : l'info explicite du provider est plus fiable que l'heuristique. L'heuristique ne couvre que les cas où le provider **n'a pas** signalé la troncation mais qu'elle semble avoir eu lieu.

---

## 4. Exemples

### 4.1 Strip thinking simple

```ts
const result = sanitizeContent(
  "<thinking>Let me reason...</thinking>The answer is 42.",
  { stripThinkingTags: true, stripJsonFence: false },
  { detectHeuristicTruncation: false, failOnSilentTruncation: false, failOnUnknownTermination: false, failOnModelMismatch: false },
  false
);
// result.sanitizedContent === "The answer is 42."
// result.sanitization === { thinkingTagsRemoved: true, jsonFenceRemoved: false }
// result.integrity === { truncationDetected: false }
```

### 4.2 Strip fence JSON

```ts
const result = sanitizeContent(
  '```json\n{"status":"ok"}\n```',
  { stripThinkingTags: false, stripJsonFence: true },
  { detectHeuristicTruncation: false, ... },
  false
);
// result.sanitizedContent === '{"status":"ok"}'
// result.sanitization === { thinkingTagsRemoved: false, jsonFenceRemoved: true }
```

### 4.3 Combinaison thinking + fence

```ts
const result = sanitizeContent(
  '<thinking>Plan: return JSON</thinking>\n```json\n{"a":1}\n```',
  { stripThinkingTags: true, stripJsonFence: true },
  { detectHeuristicTruncation: false, ... },
  false
);
// Étape 1 : strip thinking → '\n```json\n{"a":1}\n```' → trim → '```json\n{"a":1}\n```'
// Étape 2 : strip fence → '{"a":1}'
// result.sanitizedContent === '{"a":1}'
// result.sanitization === { thinkingTagsRemoved: true, jsonFenceRemoved: true }
```

### 4.4 Détection truncation heuristique

```ts
const result = sanitizeContent(
  '{"items":[{"a":1},{"a":2',  // JSON tronqué, accolades non fermées
  { stripThinkingTags: false, stripJsonFence: false },
  { detectHeuristicTruncation: true, failOnSilentTruncation: false, ... },
  false
);
// result.integrity.truncationDetected === true
// result.integrity.truncationMode === "heuristic_json_unclosed"
// Note : failOnSilentTruncation est false → pas de throw ici, juste flag info.
//         C'est l'engine qui lit ces flags et décide de throw si failOnSilentTruncation est true.
```

### 4.5 Precedence explicit sur heuristic

```ts
const result = sanitizeContent(
  '{"items":[{"a":1}',  // JSON tronqué
  { stripThinkingTags: false, stripJsonFence: false },
  { detectHeuristicTruncation: true, ... },
  true  // ← explicitTerminationIsMaxTokens
);
// result.integrity.truncationDetected === true
// result.integrity.truncationMode === "explicit_max_tokens"  (prime sur heuristic_json_unclosed)
```

### 4.6 Contenu vide après strip

```ts
const result = sanitizeContent(
  '<thinking>only planning, no final answer</thinking>',
  { stripThinkingTags: true, stripJsonFence: false },
  { detectHeuristicTruncation: false, ... },
  false
);
// result.sanitizedContent === ""
// result.sanitization === { thinkingTagsRemoved: true, jsonFenceRemoved: false }
// Cas valide : l'engine construit LLMResponse avec content: "" et émet llm_call_sanitized
// avec rawContentPreview inclus (voir §11.5 NX).
```

### 4.7 Aucune sanitization demandée

```ts
const result = sanitizeContent(
  '<thinking>x</thinking>answer',
  { stripThinkingTags: false, stripJsonFence: false },
  { detectHeuristicTruncation: false, ... },
  false
);
// result.sanitizedContent === '<thinking>x</thinking>answer' (inchangé)
// result.sanitization === { thinkingTagsRemoved: false, jsonFenceRemoved: false }
```

---

## 5. Edge cases

| Cas | Comportement attendu | Test |
| --- | --- | --- |
| `rawContent === ""` | sanitizedContent: "", removed flags: false, integrity.detected: false | T-SA-XX |
| Multiple blocks `<thinking>` | Tous retirés (flag `g`). | T-SA-XX |
| Thinking tag en casse mixte `<Thinking>` | Matché (flag `i`). | T-SA-XX |
| Thinking tag ouvert sans fermeture | Non matché, pas de strip. | T-SA-XX |
| Fence `` ```python `` | Non matché (seul `json` ou absent de langue match). | T-SA-XX |
| Fence qui englobe tout avec whitespace externe `" ```json\n{}\n```  "` | Matché (trim initial) → `{}`. | T-SA-XX |
| Fence partiel (milieu de texte) | Non matché. | T-SA-XX |
| `detectHeuristicTruncation: true` sur contenu non-JSON (`"Hello world"`) | `{ detected: false }` (premier char n'est ni `{` ni `[`). | T-SA-XX |
| `detectHeuristicTruncation: true` sur JSON complet | `{ detected: false }` (ai-json-safe-parse retourne status "ok"). | T-SA-XX |
| `detectHeuristicTruncation: false` | Pas d'appel à ai-json-safe-parse. Pas de détection. | T-SA-XX |
| Thinking avec `<` ou `>` à l'intérieur | Matché correctement tant qu'il y a `</thinking>` qui ferme. | — |

---

## 6. Constraints (invariants spécifiques)

### C-SA1 — Ordre normatif fixe

Strip thinking **avant** strip fence. Ne pas inverser. Testable par vecteur combiné.

### C-SA2 — Strip fence englobant uniquement

Fence non englobant → pas de strip. Garantit qu'on ne touche pas au contenu légitime.

### C-SA3 — Pureté modulo `ai-json-safe-parse`

Les helpers `stripThinkingTags` et `stripJsonFence` sont **purs**. `detectHeuristicTruncation` est pure modulo l'appel à `aiJsonSafeParse.analyze` (ou équivalent — voir DC). Testable : pour un même input, même output.

### C-SA4 — Pas d'exceptions

Aucune branche ne throw. Inputs pathologiques (regex qui ne match rien, content vide) → résultats déterministes sans throw.

### C-SA5 — `ai-json-safe-parse` isolé

L'import de `ai-json-safe-parse` vit **exclusivement** dans ce module. Aucun autre fichier du runtime ne l'importe. Enforcement : revue + test d'architecture (grep sur imports).

### C-SA6 — Pas de modification de `rawContent` output

`SanitizationResult.rawContent` est retourné inchangé (égal à l'input). Permet à l'engine d'accéder à l'original pour `LLMResponse.rawContent` sans dupliquer la référence.

### C-SA7 — `truncationMode` strictement borné

Valeurs possibles : `"explicit_max_tokens"` | `"heuristic_json_unclosed"` | `"silent_prompt_truncation"` | `undefined`. **En v1**, seuls les deux premiers modes peuvent être produits par ce module. Le troisième sera potentiellement produit en v1.1 par ce même module ou un autre.

### C-SA8 — `explicit > heuristic`

Si `explicitTerminationIsMaxTokens: true`, `truncationMode` final = `"explicit_max_tokens"`, même si l'heuristique avait aussi détecté. Priorité normative.

---

## 7. Integration (consommation par l'engine)

### 7.1 Résolution de la policy effective (amont)

L'engine résout la policy de sanitization effective **avant** d'appeler `sanitizeContent` :

```ts
// Dans executeCall step 7.m (NIB-M-EXECUTE-CALL) :
const effectiveSanitization: Required<SanitizationPolicy> = {
  stripThinkingTags: config.sanitization?.stripThinkingTags
    ?? binding.quirks.defaultSanitization.stripThinkingTags,
  stripJsonFence: config.sanitization?.stripJsonFence
    ?? binding.quirks.defaultSanitization.stripJsonFence,
};
```

**Règle normative** : chaque binding expose `quirks.defaultSanitization: Required<SanitizationPolicy>`. L'engine merge : override consommateur > default binding.

### 7.2 Appel à `sanitizeContent` (step 7.n)

```ts
const mapped = binding.terminationMap[parsed.terminationSignal];
const isMaxTokens = mapped === "max_tokens";

const result = sanitizeContent(
  parsed.rawContent,
  effectiveSanitization,
  config.integrity,
  isMaxTokens
);
```

### 7.3 Logging `llm_call_sanitized` (step 7.p)

Si `result.sanitization.thinkingTagsRemoved || result.sanitization.jsonFenceRemoved` → l'engine émet :

```ts
const event: LLMCallSanitizedEvent = {
  eventType: "llm_call_sanitized",
  callId, provider, model, attempt, timestamp: clock.nowWallIso(),
  thinkingTagsRemoved: result.sanitization.thinkingTagsRemoved,
  jsonFenceRemoved: result.sanitization.jsonFenceRemoved
};

// Exception PII §11.5 NX : inclure preview si thinkingTagsRemoved && sanitizedContent === ""
if (result.sanitization.thinkingTagsRemoved && result.sanitizedContent.length === 0) {
  event.rawContentPreview = parsed.rawContent.slice(0, 500);
}

logger.emit(event);
```

### 7.4 Construction de `LLMResponse` (step 7.r)

```ts
const response: LLMResponse = {
  // ...
  rawContent: result.rawContent,
  content: result.sanitizedContent,
  sanitization: result.sanitization,
  integrity: result.integrity,
  // ...
};
```

### 7.5 Évaluation `failOnSilentTruncation` (step 7.o)

L'engine **après** sanitizeContent, vérifie `config.integrity.failOnSilentTruncation`. Si `true` ET `result.integrity.truncationMode === "heuristic_json_unclosed"` → throw `SilentTruncationError` avec `truncationMode: "heuristic_json_unclosed"`.

**Règle** : le sanitizer **ne throw pas**. Il remplit `integrity.truncationDetected/truncationMode`. L'engine décide du throw selon la policy.

---

## 8. Relationship avec les autres NIB-M

| NIB-M | Relation |
| --- | --- |
| **DC-AI-JSON-SAFE-PARSE** | Dépendance externe utilisée pour `detectHeuristicTruncation`. Voir DC pour API stable. |
| **NIB-M-EXECUTE-CALL** | Seul consommateur. Appelle `sanitizeContent`, résout la policy effective, gère l'émission de l'event `llm_call_sanitized`, gère le throw de `SilentTruncationError` selon `IntegrityPolicy`. |
| **NIB-M-BINDINGS-COMPLETION** | Chaque binding expose `quirks.defaultSanitization` (defaults par provider). Consommé par l'engine pour la résolution effective. |
| **NIB-M-ERRORS** | `SilentTruncationError` est construit par l'engine (pas par le sanitizer) en cas de `failOnSilentTruncation`. |

---

## 9. Tests de référence (NIB-T §7)

| Zone | ID tests NIB-T |
| --- | --- |
| Strip thinking simple | T-SA-01..04 |
| Strip thinking multi-blocs | T-SA-05 |
| Strip thinking casse mixte | T-SA-06 |
| Strip thinking non fermé (pas de strip) | T-SA-07 |
| Strip fence json | T-SA-08..10 |
| Strip fence sans langue | T-SA-11 |
| Strip fence non englobant (pas de strip) | T-SA-12..13 |
| Combinaison thinking + fence | T-SA-14..16 |
| Detect heuristic truncation (JSON unclosed) | T-SA-17..20 |
| Precedence explicit > heuristic | T-SA-21 |
| `detectHeuristicTruncation: false` → pas d'analyse | T-SA-22 |
| Contenu non-JSON → pas de détection | T-SA-23 |
| Contenu vide après strip | T-SA-24 |
| Pureté | P-SA-a |

---

## 10. Implémentation cible

**Fichier** : `src/services/sanitizer.ts` — **~120 LOC**

Contient 4 fonctions : `stripThinkingTags`, `stripJsonFence`, `detectHeuristicTruncation`, `sanitizeContent`. Import unique de `ai-json-safe-parse` en tête.

```ts
// src/services/sanitizer.ts
import { aiJsonSafeParse } from "ai-json-safe-parse";  // API exacte définie par DC
import type { SanitizationPolicy, IntegrityPolicy, LLMSanitizationInfo, LLMIntegrityInfo } from "../types/config";

export interface SanitizationResult {
  sanitizedContent: string;
  rawContent: string;
  sanitization: LLMSanitizationInfo;
  integrity: LLMIntegrityInfo;
}

function stripThinkingTags(text: string): { cleaned: string; removed: boolean } {
  // ... voir §3.3
}

function stripJsonFence(text: string): { cleaned: string; removed: boolean } {
  // ... voir §3.4
}

function detectHeuristicTruncation(
  content: string,
  policy: IntegrityPolicy
): { detected: boolean; mode?: LLMIntegrityInfo["truncationMode"] } {
  // ... voir §3.5
}

export function sanitizeContent(
  rawContent: string,
  effectiveSanitization: Required<SanitizationPolicy>,
  integrityPolicy: IntegrityPolicy,
  explicitTerminationIsMaxTokens: boolean
): SanitizationResult {
  // ... voir §3.6
}
```

---

*VegaCorp — Implicit-Free Execution (IFE) — "La fiabilité précède l'intelligence."*
