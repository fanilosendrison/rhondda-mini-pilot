---
id: DC-AI-JSON-SAFE-PARSE
type: dependency-contract
version: "1.0.0"
scope: llm-runtime
dependency: ai-json-safe-parse
dependency_version: "^0.3.0"
status: approved
consumers: [claude-code]
referenced_by: [NIB-M-SANITIZER]
superseded_by: []
---

# DC-AI-JSON-SAFE-PARSE — Dependency Contract — `ai-json-safe-parse`

**Package consommateur** : `@vegacorp/llm-runtime`
**Dépendance** : `ai-json-safe-parse@^0.3.0`
**Module consommateur unique** : `src/services/sanitizer.ts` (voir NIB-M-SANITIZER §3.5)

---

## 1. Purpose du contrat

Ce document formalise le **contrat attendu** entre `@vegacorp/llm-runtime` et la dépendance externe `ai-json-safe-parse`. Il vise à :

1. **Isoler** le runtime de la surface réelle de la lib (qui peut évoluer) en formalisant le sous-ensemble utilisé.
2. **Tester** le contrat via des tests dédiés qui fonctionnent comme un "capteur" : si une upgrade de `ai-json-safe-parse` casse notre usage, les tests DC lâchent avant ceux du sanitizer.
3. **Documenter** pourquoi cette dépendance a été choisie et ce qu'elle remplace (pas de reimplémentation maison).
4. **Figer** la version majeure et les contraintes de surface au moment de l'intégration.

Ce contrat ne **duplique pas** la documentation de la lib — il identifie uniquement le **sous-ensemble minimal** dont le runtime dépend, et formalise les invariants attendus sur ce sous-ensemble.

---

## 2. Justification du choix

### 2.1 Problème à résoudre

Détecter si le contenu texte retourné par un LLM (après sanitization des thinking tags et JSON fences) est un **JSON incomplet** — typiquement accolades/crochets non fermés, chaînes non fermées, dernière valeur tronquée.

### 2.2 Options évaluées

| Option | Rejet / Choix | Raison |
| --- | --- | --- |
| Reimplémentation maison (tokenizer JSON custom) | Rejet | Complexité non triviale pour gérer strings échappées, unicode, edge cases. Maintenance perpétuelle. |
| `JSON.parse` + catch | Rejet | Ne distingue pas "JSON complet invalide" (ex. virgule en trop) de "JSON tronqué" (ex. accolade manquante). Pas de diagnostic structuré. |
| Ajout d'une regex heuristique | Rejet | Trop fragile, faux positifs (commentaires, strings contenant `{` sans match). |
| `ai-json-safe-parse` | **Choisi** | Lib dédiée au parsing tolérant de JSON produit par des LLMs (corrige fences, trailing commas, smart quotes, fermetures automatiques). API fournit un diagnostic structuré "complete/incomplete/invalid". |

### 2.3 Alignement avec l'écosystème VegaCorp

`ai-json-safe-parse` est déjà utilisée dans `md-structural-normalizer` pour des cas similaires (parsing défensif de sorties LLM). Choix cohérent avec la stack existante.

---

## 3. Surface consommée

Le runtime consomme **uniquement la capacité d'analyse structurelle** — **PAS** la capacité de réparation automatique. Raison : le runtime ne doit **pas** modifier silencieusement le contenu LLM au-delà du strip thinking/fence (I-3 du NIB-S, "Zero decision latitude").

### 3.1 API dépendante (sous-ensemble utilisé)

Le runtime a besoin d'une capacité qui, donnée une string supposée JSON, retourne un **verdict structurel** avec au minimum ces cas discriminables :

- **`"complete"`** : le JSON est structurellement complet (toutes accolades/crochets fermés, toutes strings fermées).
- **`"incomplete"`** : le JSON est manifestement tronqué (accolades ouvertes non fermées, string ouverte sans fermeture).
- **`"invalid"`** : le JSON est structurellement complet mais grammaticalement invalide (ex. trailing comma ou deux virgules consécutives au milieu). **Non utilisé par le runtime en v1** — on le traite comme "complete" (l'erreur de grammaire n'indique pas une troncation).

Note : le runtime v1 n'utilise que la distinction **"incomplete" vs autre**. Le diagnostic `"invalid"` est traité comme non-incomplete.

### 3.2 API cible (forme contractuelle attendue)

Deux formes possibles selon ce que la lib expose à la version `^0.3.0` :

**Forme A (si la lib expose une fonction `analyze`)** :

```ts
import { analyze } from "ai-json-safe-parse";

type AnalyzeStatus = "complete" | "incomplete" | "invalid";

function analyze(input: string): { status: AnalyzeStatus; /* autres champs ignorés */ };
```

**Forme B (si la lib expose seulement `parse` qui throw avec une erreur structurée)** :

```ts
import { parse } from "ai-json-safe-parse";

// Retourne le JSON parsé en cas de succès.
// Throw une erreur avec `error.type: "incomplete" | "invalid" | ...` en cas d'échec.
function parse(input: string): unknown;
```

**Forme C (fallback si la lib ne fournit pas de diagnostic structuré)** :

Implémentation maison d'un simple bracket-counter dans le sanitizer, avec justification minimale : *"notre usage est "incomplete detection", pas "parsing complet" — si la lib ne fournit qu'un parse tout-ou-rien, on tombe sur un bracket-counter écrit à la main avec un petit test vecteur dédié."*

### 3.3 Forme retenue en v1

À l'écriture de ce DC, **la forme exacte exposée par `ai-json-safe-parse@^0.3.0` reste à vérifier lors de l'implémentation**. Le consommateur (`src/services/sanitizer.ts`) abstraira l'accès derrière un wrapper interne :

```ts
// src/services/sanitizer.ts (extrait) :
import { parse as aiJsonParse } from "ai-json-safe-parse";

/**
 * Wrapper interne qui fournit un verdict "isIncomplete"
 * indépendamment de la forme exacte exposée par la lib.
 * Adapté selon la version installée.
 */
function isIncompleteJson(input: string): boolean {
  try {
    aiJsonParse(input);
    return false;  // parse OK → pas incomplete
  } catch (err: any) {
    // Inspection des propriétés de l'erreur produite par la lib :
    if (err?.type === "incomplete" || err?.code === "INCOMPLETE") return true;
    if (typeof err?.message === "string" &&
        /unclosed|incomplete|unexpected end/i.test(err.message)) {
      return true;
    }
    return false;  // autre erreur (ex. "invalid") → traité comme non-incomplete
  }
}
```

**Cette implémentation** est documentée dans NIB-M-SANITIZER §3.5 et testée via les vecteurs du NIB-T §7.

### 3.4 Fonctions, classes, ou features NON utilisées

Les capacités suivantes de `ai-json-safe-parse` **ne doivent pas** être consommées par le runtime :

- Réparation automatique de JSON (ex. `aiJsonFix`, `repair`, etc.) — contraire à I-3.
- Streaming / parsing incrémental — hors scope v1.
- Conversion de types (ex. YAML → JSON) — hors scope v1.
- Tout hook de configuration qui modifie le comportement de parse (ex. `allowTrailingCommas: true`) — on accepte les defaults de la lib.

Le runtime consomme **uniquement la détection `incomplete`**. Rien d'autre.

---

## 4. Invariants contractuels

Ce que le runtime attend de la lib, et **qui doit être vérifié par un test DC** :

### I-DC1 — JSON complet ne déclenche jamais `incomplete`

Pour un JSON structurellement valide (ex. `{"a":1}`, `[1,2,3]`, `"string"`, `null`, `42`, `true`), `isIncompleteJson(input) === false`.

Testable sur un échantillon représentatif (voir §6).

### I-DC2 — JSON tronqué en milieu d'objet → `incomplete`

Pour un JSON manifestement tronqué (ex. `{"a":1`, `[{"a":1},{"b":`, `{"items":[1,2,3`), `isIncompleteJson(input) === true`.

### I-DC3 — JSON grammaticalement invalide mais structurellement fermé → `false`

Pour un JSON avec trailing commas, virgules doubles, ou valeurs non-JSON (ex. `{"a":1,}`, `{"a":NaN}`, `{'a':1}`), le runtime considère `isIncompleteJson === false`. Rationale : ces erreurs ne signalent **pas** une troncation, elles signalent un bug de génération LLM différent (pas du ressort du runtime en v1).

### I-DC4 — Pas de throw observable côté appelant

Le wrapper `isIncompleteJson` **doit retourner un `boolean`**, jamais throw. Si `ai-json-safe-parse` throw (quel que soit le type d'erreur), le wrapper catch et retourne `false` ou `true` selon la classification (§3.3).

### I-DC5 — Robustesse aux entrées non-JSON

Pour une entrée qui n'est **pas du tout** du JSON (ex. `"hello world"`, `""`, `"   "`), `isIncompleteJson === false`. Rationale : le sanitizer appelle `isIncompleteJson` **uniquement** si le premier caractère non-whitespace est `{` ou `[` (voir NIB-M-SANITIZER §3.5). Donc ce cas ne devrait pas arriver en pratique, mais défensif.

### I-DC6 — Performance acceptable

Sur une string de 10 KB, `isIncompleteJson` s'exécute en < 5 ms. Contrainte informelle — non testée en v1 mais à surveiller.

### I-DC7 — Stabilité sur range `^0.3.0`

Le contrat doit tenir pour toute version `0.3.x` (patch bumps semver). Un bump mineur (`0.4.0`) **nécessite** :
- Relecture de ce DC.
- Re-exécution de la suite de tests DC.
- Mise à jour éventuelle du wrapper si l'API a changé.
- Confirmation que les invariants I-DC1 à I-DC5 tiennent.

---

## 5. Ce qui est interdit

### Interdit — Bypass du wrapper

Aucun fichier de `src/` autre que `src/services/sanitizer.ts` ne doit importer `ai-json-safe-parse`. Enforcement : revue + test d'architecture (grep sur imports).

### Interdit — Usage de réparation automatique

Ne pas utiliser les capacités `fix`, `repair`, `complete` (ou équivalentes) de la lib, même si elles sont exposées. Le runtime n'altère pas silencieusement le contenu LLM.

### Interdit — Dépendance transitive exposée

Si `ai-json-safe-parse` re-exporte d'autres modules (ex. un tokenizer interne), ne pas les consommer. Importer uniquement l'entry point officiel (`"ai-json-safe-parse"`).

### Interdit — Mutation de l'entrée

Le wrapper `isIncompleteJson(input)` ne doit jamais muter `input`. Pureté respectée.

---

## 6. Tests DC (capteur d'upgrade)

Ces tests vivent dans `tests/contracts/dc-ai-json-safe-parse.test.ts`. Ils **doivent passer** pour toute version compatible `^0.3.0`.

### 6.1 Vecteurs de test

```ts
describe("DC-AI-JSON-SAFE-PARSE contract", () => {
  // I-DC1 : JSON complet → false
  it("detects complete JSON as non-incomplete", () => {
    expect(isIncompleteJson('{"a":1}')).toBe(false);
    expect(isIncompleteJson('[1,2,3]')).toBe(false);
    expect(isIncompleteJson('{}')).toBe(false);
    expect(isIncompleteJson('[]')).toBe(false);
    expect(isIncompleteJson('null')).toBe(false);
    expect(isIncompleteJson('true')).toBe(false);
    expect(isIncompleteJson('42')).toBe(false);
    expect(isIncompleteJson('"hello"')).toBe(false);
    expect(isIncompleteJson('{"nested":{"a":[1,2]}}')).toBe(false);
  });

  // I-DC2 : JSON tronqué → true
  it("detects truncated JSON as incomplete", () => {
    expect(isIncompleteJson('{"a":1')).toBe(true);
    expect(isIncompleteJson('[1,2,3')).toBe(true);
    expect(isIncompleteJson('{"items":[1,2')).toBe(true);
    expect(isIncompleteJson('{"a":"')).toBe(true);      // string non fermée
    expect(isIncompleteJson('[{"a":1},{"b":')).toBe(true);
    expect(isIncompleteJson('{"a":{"nested":')).toBe(true);
  });

  // I-DC3 : JSON grammaticalement invalide mais structurellement fermé → false
  it("treats grammatically invalid but structurally closed as non-incomplete", () => {
    expect(isIncompleteJson('{"a":1,}')).toBe(false);        // trailing comma
    expect(isIncompleteJson('{"a":1,,"b":2}')).toBe(false);  // double comma
    // (Les cas avec JSON5 / smart quotes peuvent donner des résultats différents
    //  selon la tolérance exacte de la lib — à vérifier à l'intégration.)
  });

  // I-DC4 : Jamais de throw
  it("never throws, always returns boolean", () => {
    expect(() => isIncompleteJson("")).not.toThrow();
    expect(() => isIncompleteJson("not json at all")).not.toThrow();
    expect(() => isIncompleteJson("{{{{")).not.toThrow();
    expect(() => isIncompleteJson('{"a":\u0000}')).not.toThrow();  // char interdit JSON
  });

  // I-DC5 : Entrées non-JSON → false
  it("returns false for non-JSON inputs", () => {
    expect(isIncompleteJson("")).toBe(false);
    expect(isIncompleteJson("hello world")).toBe(false);
    expect(isIncompleteJson("   ")).toBe(false);
    // Note : "not json" pourrait être classé "invalid" par la lib → false selon I-DC3.
  });
});
```

### 6.2 Trigger de re-exécution

- À chaque `npm install` (CI).
- À chaque bump de version `ai-json-safe-parse` dans `package.json`.
- À chaque commit sur `src/services/sanitizer.ts` (par précaution).

### 6.3 Politique en cas d'échec DC

Si un test DC lâche après une upgrade de la lib :

1. **Ne pas "fixer" le wrapper pour faire passer le test** — un échec DC signifie que **le contrat attendu n'est plus rempli**.
2. Investiguer : la lib a-t-elle changé son diagnostic ? Sa sémantique d'erreurs ?
3. Mettre à jour ce DC (version, règles) puis le wrapper si nécessaire.
4. Si l'upgrade n'est pas compatible, pin la version précédente et ouvrir une issue pour évaluer alternatives.

---

## 7. Diagramme de dépendance

```
@vegacorp/llm-runtime
       │
       └── src/services/sanitizer.ts
                  │
                  │ import from "ai-json-safe-parse"
                  ▼
         ┌──────────────────────────┐
         │ ai-json-safe-parse@^0.3.0│
         │ (external NPM package)    │
         └──────────────────────────┘
```

**Propriété** : aucun autre fichier de `src/` n'importe `ai-json-safe-parse`. L'entrée unique est via `sanitizer.ts`.

---

## 8. Impact sur la structure du projet

### 8.1 `package.json`

```jsonc
{
  "dependencies": {
    "ai-json-safe-parse": "^0.3.0",
    "ulid": "^2.0.0"
  }
}
```

Range `^0.3.0` autorise les patch bumps automatiques (`0.3.1`, `0.3.2`, ...). Un bump mineur (`0.4.0`) nécessite mise à jour explicite du `package.json`.

### 8.2 `tests/contracts/`

Présence obligatoire de `tests/contracts/dc-ai-json-safe-parse.test.ts` avec les vecteurs de §6.1.

### 8.3 Documentation

Ce fichier DC (DC-AI-JSON-SAFE-PARSE.md) vit dans le corpus NIB sous `/docs/nibs/` (ou équivalent). Il **n'est pas** une spec d'implémentation — c'est un capteur de conformité.

---

## 9. Évolutions futures

### 9.1 Upgrade vers `0.4.x` ou plus

À chaque bump mineur ou majeur :
- Relire ce DC.
- Re-exécuter les tests DC.
- Éventuellement bumper la version de ce DC (v1.1.0 → v1.2.0).
- Documenter dans le corpus NIB si le contrat change (champ `dependency_version` dans le front-matter).

### 9.2 Changement de lib

Si `ai-json-safe-parse` devient non maintenue ou si une alternative émerge (ex. une lib officielle LLM parsing), le changement se fait :
1. Création d'un nouveau DC (ex. DC-NEW-LIB).
2. Mise à jour de `NIB-M-SANITIZER` pour référencer le nouveau DC.
3. Mise en `superseded_by` de ce DC avec lien vers le remplaçant.

### 9.3 Reimplémentation maison

Si, au contraire, on décide de retirer `ai-json-safe-parse` et d'implémenter un simple bracket-counter maison :
1. Marquer ce DC comme `status: deprecated`.
2. Mettre à jour `NIB-M-SANITIZER` pour ne plus référencer de DC externe.
3. Déprécier et retirer la dépendance du `package.json`.

---

## 10. Références croisées

| NIB-M | Relation |
| --- | --- |
| **NIB-M-SANITIZER** | Unique consommateur. Voir §3.5 (algorithme de détection heuristique) et §6 (constraints C-SA5). |
| **NIB-S-LLMRUNTIME** | §10.4 (Dépendances externes v1) mentionne `ai-json-safe-parse ^0.3.0` avec renvoi vers ce DC. |
| **NIB-T-LLMRUNTIME** | §7 (tests sanitizer) incluent des vecteurs qui exercent indirectement la lib via le sanitizer. Les tests DC dédiés (§6 ci-dessus) sont en sus, dans `tests/contracts/`. |

---

## 11. Changelog de ce DC

| Version | Date | Changement |
| --- | --- | --- |
| 1.0.0 | 2026-04 | Création initiale du DC pour `ai-json-safe-parse@^0.3.0`. Définit la surface consommée (analyse structurelle uniquement), les invariants I-DC1 à I-DC7, les interdictions, et les tests capteurs. |

---

*VegaCorp — Implicit-Free Execution (IFE) — "La fiabilité précède l'intelligence."*
