---
id: NIB-M-BINDINGS-COMPLETION
type: nib-module
version: "1.0.0"
scope: llm-runtime
module: bindings-completion
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-M-BINDINGS-COMPLETION — Module Brief — Bindings de completion (Anthropic, OpenAI, OpenAI-compatible, Google Gemini)

**Package** : `@vegacorp/llm-runtime`
**Source NX** : §5.4 (ProviderBinding), §15.1 (quirks génériques), §15.2 (Anthropic), §15.3 (OpenAI et compatibles), §15.4 (Google Gemini)
**NIB-T associé** : §10 (Anthropic), §11 (OpenAI), §12 (OpenAI-compatible), §13 (Google)

---

## 1. Purpose

Implémenter les **quatre bindings de completion** livrés en v1. Un binding completion est un artefact **mince** qui traduit, pour un provider donné :
- `LLMRequest` → forme HTTP canonique (`buildRequest`),
- réponse HTTP (body + headers) → `ParsedProviderResponse` (`parseResponse`),
- signal d'erreur provider → erreur sémantique (`classifyError`),
- headers de réponse → `RateLimitSnapshot | null` (`readRateLimitHeaders`),
- `finishReason` provider → `TerminationReason` canonique (`terminationMap`).

Chaque binding expose aussi un objet `quirks` (défauts sanitization, présence de rate-limit headers, routing de modèle).

**Principe normatif structurant** — un binding **ne décide pas** : il **traduit**. Aucune logique de retry, de throttle, de sanitization, de validation d'integrity, de timeout, ou de signal composite n'y réside. Ces responsabilités appartiennent strictement à l'engine (voir NIB-M-EXECUTE-CALL). Un binding qui exécute un `fetch`, appelle `sanitizeContent`, ou consulte le `clock` est **non conforme**.

Les quatre bindings partagent exactement la même interface `ProviderBinding` (§5.4 NX). Ils ne partagent **pas** de code : la duplication inter-binding est acceptée et recherchée — chaque binding est un artefact autonome et remplaçable unitairement. Seuls les utilitaires transverses (`sanitizer`, `error-classifier-base`, `retry-resolver`, etc.) sont partagés, et jamais appelés depuis les bindings eux-mêmes.

Taille cible par binding : **50-150 LOC**. Au-delà, c'est qu'une responsabilité engine a fuité — violation à corriger.

---

## 2. Inputs / Outputs — Interface partagée

Tous les bindings completion implémentent strictement :

```ts
interface ProviderBinding {
  readonly provider: ProviderLongId;
  buildRequest(request: LLMRequest, config: BindingConfig): CanonicalHttpRequest;
  parseResponse(body: unknown, headers: Record<string, string>): ParsedProviderResponse;
  classifyError(signal: ProviderErrorSignal): LLMRuntimeError;
  readRateLimitHeaders(headers: Record<string, string>, nowMono: number, nowWall: Date): RateLimitSnapshot | null;
  readonly terminationMap: Readonly<Record<string, TerminationReason>>;
  readonly quirks: ProviderQuirks;
}

interface BindingConfig {
  model: string;
  apiKey: string;
  endpoint?: string;
  providerOptions?: unknown;
}

interface ProviderQuirks {
  defaultSanitization: Required<SanitizationPolicy>;
  hasRateLimitHeaders: boolean;
  mayRouteModel: boolean;
}
```

**Contrats partagés** :
- `buildRequest` : **pur**, déterministe pour une entrée donnée. Aucun I/O. Produit un objet `CanonicalHttpRequest` (voir NIB-S §6.1) sérialisable et loggable (sans secrets : les `apiKey` sont incorporées dans `headers` selon le provider mais ne sont **pas** masquées par le binding — le masquage des logs est responsabilité du logger si nécessaire).
- `parseResponse` : **pur**, reçoit `(body, headers)` où `body` est le JSON pré-parsé par l'engine (`unknown` — le parsing JSON est centralisé dans l'engine, pas dans le binding) et `headers` est déjà normalisé en `Record<string, string>` avec clés lowercase (voir §14.1 step 7.i NX). Throw uniquement `ResponseParseError` en cas de structure inattendue (pas de `new Error(...)` générique).
- `classifyError` : **pur**, input `ProviderErrorSignal` (§7.3 NX), output une instance d'une des 11 sous-classes de `LLMRuntimeError` (voir NIB-M-ERRORS). Aucun appel à `error-classifier-base` depuis le binding : le binding peut dupliquer la logique HTTP générique si elle suffit, ou l'appeler explicitement via import — jamais de mécanisme d'héritage ou de délégation implicite.
- `readRateLimitHeaders` : **pur** (modulo clock args), reçoit `(headers, nowMono, nowWall)` pour permettre la conversion wall-clock→monotone des timestamps de reset. Retourne un `RateLimitSnapshot` (NIB-S §10.2) ou `null`. Ne throw **jamais** — tout header absent, malformé, ou provider sans rate-limit → `null`.
- `terminationMap` : objet figé (`Readonly<...>`). Les clés sont les `finishReason` bruts du provider, les valeurs sont des `TerminationReason` canoniques. Toute clé absente de la map est résolue par l'engine via mapping à `"unknown"` et déclenche éventuellement `SilentTruncationError` selon la policy integrity.
- `quirks` : objet figé. Les 3 champs sont tous obligatoires et de type non optionnel.

**Les 4 bindings ci-dessous sont les uniques implémentations v1.** Aucun autre binding completion n'est permis sans évolution explicite du NX.

---

## 3. Binding Anthropic

**Source NX** : §15.2. **NIB-T associé** : §10.

**Fichier cible** : `src/bindings/anthropic.ts`. **LOC cible** : ~120-150.

### 3.1 `provider`

```ts
provider: "anthropic"  // ProviderLongId — identifie l'écosystème protocolaire exposé au consommateur
```

**Règle normative** : `ProviderBinding.provider` est un `ProviderLongId` (§5.4 NX, NIB-T C-GL-04/11). Il est **identique** à la valeur exposée par `adapter.provider` après câblage par la factory. Il ne contient aucun suffixe de version de protocole — le versioning du protocole HTTP upstream est implicite à la version v1 du binding et évoluera par breaking change du binding lui-même.

### 3.2 `buildRequest(request, config)`

Construit une requête `POST` vers `${config.endpoint ?? "https://api.anthropic.com"}/v1/messages`.

**Headers obligatoires** :
```
content-type: application/json
x-api-key: ${config.apiKey}
anthropic-version: 2023-06-01
```

**Body** : sérialisation JSON de
```ts
{
  model: config.model,
  max_tokens: request.maxTokens ?? 1024,
  system: <concaténation string des messages role: "system">,
  messages: <messages role: "user" | "assistant" — pas de "system">,
  temperature?: request.temperature,
  ...(request.responseFormat?.type === "json_object" ? { /* note ci-dessous */ } : {}),
  ...(providerOptions.extendedThinking?.enabled
        ? { thinking: { type: "enabled", budget_tokens: providerOptions.extendedThinking.budgetTokens } }
        : {}),
}
```

**Règles normatives** :
- `system` : les messages `role: "system"` sont concaténés en une **unique string** (séparateur `"\n\n"`). S'il n'y en a aucun, le champ `system` est **omis** (pas `""` ni `null`).
- `messages` : seulement les rôles `user` et `assistant`, dans l'ordre d'origine. Chaque message est `{ role, content: <string du LLMMessage.content> }`. Pas de conversion en blocks.
- `responseFormat` : Anthropic ne supporte pas un switch JSON natif en v1 du binding. Le champ `request.responseFormat` est **ignoré** côté build (la contrainte JSON est du ressort du prompt côté consommateur). Cette limitation est documentée, non corrigée en v1.
- `providerOptions` : typé en interne comme `{ extendedThinking?: { enabled: boolean; budgetTokens: number } }`. Tout autre champ est ignoré silencieusement.
- Immutabilité : la requête construite ne doit **jamais** référencer un objet de `LLMRequest` par référence partageable mutable. Les `messages` sont clonés superficiellement (nouveau tableau, nouveaux objets `{ role, content }`).

### 3.3 `parseResponse(body, headers)`

Parse le body JSON d'une réponse Anthropic Messages API.

**Algorithme** :
1. `const parsed = JSON.parse(bodyText)` — si échec, throw `new ResponseParseError("anthropic: body is not valid JSON", { cause })`.
2. Valider la structure minimale :
   - `parsed.content` doit être un array, sinon throw `ResponseParseError("anthropic: missing content[]")`.
   - `parsed.stop_reason` doit être une string (peut être manquant sur streaming partiel, mais v1 est non-streaming → obligatoire). Sinon throw `ResponseParseError("anthropic: missing stop_reason")`.
3. Extraction du content textuel :
   - Filter `parsed.content.filter(b => b.type === "text").map(b => b.text).join("")`.
   - Les blocks de type `"thinking"` et `"tool_use"` sont **ignorés** dans `rawContent`.
4. Construire `ParsedProviderResponse` :

```ts
return {
  rawContent: <string concaténé des blocks text>,
  terminationSignal: parsed.stop_reason,  // ex: "end_turn", "max_tokens", "stop_sequence", "tool_use"
  usage: parsed.usage ? {
    inputTokens: parsed.usage.input_tokens,
    outputTokens: parsed.usage.output_tokens,
    totalTokens: (parsed.usage.input_tokens ?? 0) + (parsed.usage.output_tokens ?? 0),
  } : undefined,
  providerResponseId: parsed.id,
  providerModel: parsed.model,
};
```

**Règles normatives** :
- Un body avec `content: []` (array vide) donne `rawContent: ""`. Ce n'est **pas** un throw — c'est l'engine qui décidera (via integrity) si ce vide est problématique.
- `usage` est `undefined` si le provider n'a pas envoyé le champ. Pas de `{ inputTokens: 0, ... }` par défaut.
- `providerResponseId` et `providerModel` sont copiés tels quels si présents, `undefined` sinon.
- Aucun accès à `console`, `clock`, `Date`. La fonction est pure.

### 3.4 `classifyError(signal)`

Classifie un `ProviderErrorSignal` Anthropic. Appelle `classifyFromHttpStatus` du module `error-classifier-base` (voir NIB-M-ERROR-CLASSIFIER-BASE) pour le mapping HTTP standard, puis override pour les cas Anthropic-spécifiques.

**Algorithme** :
1. Déléguer à `classifyFromHttpStatus(signal)` pour obtenir une erreur candidate.
2. **Override Anthropic** — si `signal.status === 529` : retourner `new OverloadedError(...)` (le classifier base mappe 529 → `OverloadedError` aussi ; la cohérence est vérifiée, pas de re-mapping ici).
3. Anthropic peut retourner du texte d'erreur en `bodyText` au format `{ "type": "error", "error": { "type": "...", "message": "..." } }`. Extraire le `error.message` pour enrichir le `message` de l'erreur retournée :
   ```ts
   const providerMessage = tryExtractAnthropicErrorMessage(signal.bodyText);
   if (providerMessage) error.message = `${error.message}: ${providerMessage}`;
   ```
4. Retourner l'erreur. Les champs `callId`, `provider`, `model`, `attempts` sont **laissés à `undefined`** — c'est l'engine qui les surcharge systématiquement au throw (§14.1 step 7.b NX).

**Règles** : aucun throw depuis `classifyError`. Toujours retourner une instance. En cas de signal totalement inattendu, `classifyFromHttpStatus` retourne `TransientProviderError` par défaut (voir NIB-M-ERROR-CLASSIFIER-BASE §5).

### 3.5 `readRateLimitHeaders(headers)`

Lit les headers `anthropic-ratelimit-*`. Retourne un `RateLimitSnapshot` avec les champs `requests` et `tokens` si disponibles, ou `null` si aucun header exploitable.

**Headers lus** (tous préfixés `anthropic-ratelimit-`) :
- `requests-limit` → `requests.limit`
- `requests-remaining` → `requests.remaining`
- `requests-reset` → `requests.resetAtWall` (format ISO 8601)
- `tokens-limit` → `tokens.limit`
- `tokens-remaining` → `tokens.remaining`
- `tokens-reset` → `tokens.resetAtWall`

**Algorithme** :
```ts
function readRateLimitHeaders(headers: Record<string, string>): RateLimitSnapshot | null {
  const requests = readBucket(headers, "anthropic-ratelimit-requests");
  const tokens = readBucket(headers, "anthropic-ratelimit-tokens");
  if (!requests && !tokens) return null;
  return {
    state: "known",
    requests,
    tokens,
    capturedAtMono: clock.nowMono(),  // ⚠️ exception : lecture horloge autorisée ici
  };
}
```

**Exception normative** : `readRateLimitHeaders` est la **seule** fonction de binding qui a le droit de lire `clock.nowMono()`. Elle est nécessaire pour timestamper le snapshot au moment où il est lu. Alternative envisagée (retourner le snapshot sans `capturedAtMono` et laisser l'engine le compléter) : rejetée car elle forcerait l'engine à post-traiter chaque retour. Le cas est isolé et documenté.

- Si `requests-remaining` est présent mais `requests-limit` manquant → lire quand même ce qui est disponible (snapshot partiel OK).
- Si un bucket complet est absent, le champ vaut `undefined`.
- Si les deux buckets sont absents → `null`.
- Tout header non parseable en nombre (pour `limit`/`remaining`) ou en date ISO (pour `reset`) → le champ vaut `undefined` silencieusement. Jamais de throw.

### 3.6 `terminationMap`

```ts
terminationMap: {
  "end_turn": "completed",
  "max_tokens": "max_tokens",
  "stop_sequence": "stop_sequence",
  "tool_use": "completed",
} as const;
```

Toute valeur reçue en dehors de ces clés → l'engine la mappera à `"unknown"` (voir NIB-M-EXECUTE-CALL §3.q).

### 3.7 `quirks`

```ts
quirks: {
  defaultSanitization: { stripThinkingTags: true, stripJsonFence: true },
  hasRateLimitHeaders: true,
  mayRouteModel: true,  // aliasing claude-opus-4 → claude-opus-4-6-20260301
};
```

---

## 4. Binding OpenAI

**Source NX** : §15.3 (version native, sans les compatibles). **NIB-T associé** : §11.

**Fichier cible** : `src/bindings/openai.ts`. **LOC cible** : ~90-120.

### 4.1 `provider`

```ts
provider: "openai"  // ProviderLongId
```

### 4.2 `buildRequest(request, config)`

Requête `POST` vers `${config.endpoint ?? "https://api.openai.com"}/v1/chat/completions`.

**Headers** :
```
content-type: application/json
authorization: Bearer ${config.apiKey}
```

**Body** :
```ts
{
  model: config.model,
  messages: request.messages.map(m => ({ role: m.role, content: m.content })),
  max_tokens: request.maxTokens,
  temperature: request.temperature,
  ...(request.responseFormat?.type === "json_object" ? { response_format: { type: "json_object" } } : {}),
}
```

**Règles** :
- Les messages système sont inclus **dans** `messages` (contrairement à Anthropic). Ordre préservé.
- `max_tokens` et `temperature` sont **omis** du body si `undefined` (pas envoyés comme `null` — le body reste minimal).
- `response_format` n'est envoyé que pour `json_object` (v1). Autres valeurs → `response_format` omis.
- `providerOptions` : ignoré en v1 pour OpenAI natif (pas de champ défini). Réservé pour extensions futures.

### 4.3 `parseResponse(body, headers)`

**Algorithme** :
1. `const parsed = JSON.parse(bodyText)` — si échec, throw `ResponseParseError`.
2. Valider : `parsed.choices` doit être un array non-vide, sinon throw.
3. `const choice = parsed.choices[0]` (le binding v1 ne gère que `n: 1`, convention implicite).
4. Extraire :

```ts
return {
  rawContent: choice.message?.content ?? "",
  terminationSignal: choice.finish_reason,  // "stop", "length", "content_filter", "tool_calls"
  usage: parsed.usage ? {
    inputTokens: parsed.usage.prompt_tokens,
    outputTokens: parsed.usage.completion_tokens,
    totalTokens: parsed.usage.total_tokens,
  } : undefined,
  providerResponseId: parsed.id,
  providerModel: parsed.model,
};
```

**Règles** :
- Normalisation des champs `usage` : OpenAI utilise `prompt_tokens`/`completion_tokens`, le binding convertit vers la nomenclature canonique `inputTokens`/`outputTokens`. C'est une responsabilité du binding (§6.2 NX).
- `choice.message?.content` peut être `null` (cas `tool_calls` pur) → retourner `""`, pas throw. L'engine traitera le `""` selon la policy integrity.
- `providerModel` : OpenAI retourne le modèle effectivement utilisé (peut différer de `request.model` si OpenAI a résolu un alias) — mais `mayRouteModel: false` pour OpenAI (voir 4.7), donc l'engine signalera le mismatch si `failOnModelMismatch: true`.

### 4.4 `classifyError(signal)`

**Algorithme** :
1. Déléguer à `classifyFromHttpStatus(signal)`.
2. **Override** — status 400 avec body contenant `"content_policy_violation"` ou `"content_filter"` → `ContentFilterError`. OpenAI renvoie parfois 400 pour content policy, mais `error-classifier-base` map 400 → `InvalidRequestError` par défaut. Cette override est matérialisée :
   ```ts
   if (signal.status === 400 && /content[_-]policy[_-]violation|content[_-]filter/i.test(signal.bodyText ?? "")) {
     return new ContentFilterError("openai: content policy violation");
   }
   ```
3. Extraction du message d'erreur OpenAI : body au format `{ "error": { "message": "...", "type": "...", "code": "..." } }`. Extraire `error.message` et enrichir le `message` de l'erreur retournée.
4. Retourner l'erreur.

### 4.5 `readRateLimitHeaders(headers)`

Lit les headers `x-ratelimit-*` d'OpenAI :
- `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests` (format : `"6m7s"` ou `"1h"` — durée relative **depuis le now serveur**).
- `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-tokens`.

**Algorithme** :
1. Pour chaque bucket (`requests`, `tokens`), lire les trois headers.
2. Le `reset` est une durée relative → parser via helper interne `parseOpenAIResetDuration(value: string) => number | undefined` (retourne des ms). Format attendu : `\d+(ms|s|m|h)`, possiblement concaténé (`"6m0s"` = 6 minutes et 0 secondes).
3. Convertir la durée relative en `resetAtWall` : `new Date(clock.nowWall().getTime() + parsedMs).toISOString()`.
4. Si ni `requests` ni `tokens` n'ont au moins un champ exploitable → `null`.

**Règles** :
- `parseOpenAIResetDuration` non exportée, interne au binding. Tolère les formats mal connus → retourne `undefined`, pas throw.
- L'usage de `clock.nowWall()` dans ce helper est l'**exception normative** décrite en 3.5 — requis pour convertir une durée relative en timestamp absolu.

### 4.6 `terminationMap`

```ts
terminationMap: {
  "stop": "completed",
  "length": "max_tokens",
  "content_filter": "content_filter",
  "tool_calls": "completed",
  "function_call": "completed",  // legacy pre-tool_calls
} as const;
```

### 4.7 `quirks`

```ts
quirks: {
  defaultSanitization: { stripThinkingTags: true, stripJsonFence: false },
  hasRateLimitHeaders: true,
  mayRouteModel: false,  // OpenAI renvoie le model demandé tel quel
};
```

---

## 5. Binding OpenAI-Compatible

**Source NX** : §15.3 (section compatibles). **NIB-T associé** : §12.

**Fichier cible** : `src/bindings/openai-compatible.ts`. **LOC cible** : ~120-150.

Ce binding sert les providers utilisant le protocole OpenAI Chat Completions avec des particularités mineures : **DeepSeek, Mistral, Groq, Together, Ollama**.

### 5.1 Signature de création

Le binding lui-même n'est **pas** une constante mais une **factory de binding** paramétrée par le provider cible :

```ts
function createOpenAICompatibleBinding(params: {
  provider: Extract<ProviderLongId, "deepseek" | "mistral" | "groq" | "together" | "ollama">;
  defaultEndpoint: string;   // ex: "https://api.deepseek.com"
}): ProviderBinding;
```

Le `ProviderBinding.provider` produit est **exactement** `params.provider` (un `ProviderLongId`). Cette factory est consommée par `createOpenAICompatibleAdapter` (voir NIB-M-FACTORIES), qui expose une API unifiée pour les 5 providers.

### 5.2 `buildRequest` — différences vs OpenAI natif

Identique à §4.2 sauf :
- `endpoint` : **obligatoire** (via `config.endpoint ?? params.defaultEndpoint`). Pas de fallback vers OpenAI.
- `providerOptions` : ignoré en v1 (pas de surface définie).

### 5.3 `parseResponse` — identique à OpenAI

Le contrat de réponse est supposé identique à OpenAI (c'est la définition d'un provider "OpenAI-compatible"). Tout écart structurel (ex. DeepSeek R1 qui émet `<think>` tags **à l'intérieur** de `content`) est **traité par le sanitizer**, pas par le binding. Le binding n'a donc pas de logique spécifique.

### 5.4 `classifyError` — identique à OpenAI pour la base

Appelle `classifyFromHttpStatus`. **Pas d'override content_policy** en v1 pour les compatibles (les signaux varient par provider, non documentés de manière fiable). Extraction du message d'erreur via le même format `{ "error": { "message": "..." } }` si présent.

### 5.5 `readRateLimitHeaders` — table par provider

Les headers rate-limit varient :

| Provider | Headers | Parse |
|---|---|---|
| DeepSeek | aucun fiable | `null` |
| Mistral | `x-ratelimit-limit-*`, `x-ratelimit-remaining-*`, **pas de reset** → fallback 60s | partiel |
| Groq | `x-ratelimit-*` OpenAI-like + durée relative | parse OpenAI-like |
| Together | `x-tokenlimit-remaining` (custom, tokens uniquement) | partiel tokens-only |
| Ollama | jamais de rate limit | `null` |

**Algorithme** :
```ts
function readRateLimitHeaders(headers) {
  switch (params.provider) {
    case "deepseek": return null;
    case "mistral":  return readMistral(headers);
    case "groq":     return readGroqLike(headers);  // format OpenAI
    case "together": return readTogether(headers);
    case "ollama":   return null;
    default: return null;
  }
}
```

**Règles** :
- `readMistral` : lit `x-ratelimit-remaining-requests/tokens` + `x-ratelimit-limit-requests/tokens`, fallback `resetAtWall = new Date(clock.nowWall().getTime() + 60_000).toISOString()`.
- `readTogether` : lit uniquement `x-tokenlimit-remaining` → retourne `{ state: "known", tokens: { remaining: <parsed> }, requests: undefined, capturedAtMono: clock.nowMono() }`. Pas de reset → `undefined`.
- Tout provider non reconnu → `null`.

### 5.6 `terminationMap` — identique à OpenAI

Tous les providers OpenAI-compatibles exposent `stop`, `length`, `content_filter`, `tool_calls`. La map est identique à 4.6.

### 5.7 `quirks` — paramétré par provider

Les quirks varient :

```ts
function quirksFor(provider: Extract<ProviderLongId, "deepseek" | "mistral" | "groq" | "together" | "ollama">): ProviderQuirks {
  switch (provider) {
    case "deepseek":
      return { defaultSanitization: { stripThinkingTags: true, stripJsonFence: false }, hasRateLimitHeaders: false, mayRouteModel: false };
    case "mistral":
      return { defaultSanitization: { stripThinkingTags: false, stripJsonFence: false }, hasRateLimitHeaders: true, mayRouteModel: false };
    case "groq":
      return { defaultSanitization: { stripThinkingTags: true, stripJsonFence: false }, hasRateLimitHeaders: true, mayRouteModel: false };
    case "together":
      return { defaultSanitization: { stripThinkingTags: false, stripJsonFence: false }, hasRateLimitHeaders: true, mayRouteModel: false };
    case "ollama":
      return { defaultSanitization: { stripThinkingTags: false, stripJsonFence: false }, hasRateLimitHeaders: false, mayRouteModel: false };
  }
}
```

**Justification `stripThinkingTags: true` pour DeepSeek et Groq** : DeepSeek R1 et certains modèles Groq émettent des `<think>...</think>` dans `content`. Le binding n'agit pas — mais le quirk déclare le défaut, et l'engine déclenchera le sanitizer.

### 5.8 Liste figée des providers OpenAI-compatibles v1

La factory `createOpenAICompatibleBinding` n'accepte que les 5 valeurs de `ProviderLongId` suivantes :

```ts
type OpenAICompatibleProviderId = Extract<
  ProviderLongId,
  "deepseek" | "mistral" | "groq" | "together" | "ollama"
>;
```

Tout autre provider passé à `createOpenAICompatibleBinding` est rejeté par TypeScript (type error à la compilation) et, défensivement, à l'exécution : runtime throw `InvalidRequestError("unsupported openai-compatible provider")`. Voir NIB-M-FACTORIES §4.

---

## 6. Binding Google Gemini

**Source NX** : §15.4. **NIB-T associé** : §13.

**Fichier cible** : `src/bindings/google.ts`. **LOC cible** : ~110-140.

### 6.1 `provider`

```ts
provider: "google"  // ProviderLongId
```

### 6.2 `buildRequest(request, config)`

Requête `POST` vers `${config.endpoint ?? "https://generativelanguage.googleapis.com"}/v1beta/models/${config.model}:generateContent`.

**Headers** :
```
content-type: application/json
x-goog-api-key: ${config.apiKey}
```

**Justification header vs query param** : le NX (§15.4) précise que `x-goog-api-key` est plus sécurisé que `?key=`. Le binding v1 utilise **systématiquement** le header. Le `BindingConfig.endpoint` ne doit pas contenir de `?key=...` — si c'est le cas, le binding ne le détecte pas et ne l'efface pas : responsabilité du consommateur.

**Body** :
```ts
{
  systemInstruction: <si messages system présents> ? { parts: [{ text: <concat> }] } : undefined,
  contents: <messages user/assistant convertis en { role: "user" | "model", parts: [{ text: content }] }>,
  generationConfig: {
    maxOutputTokens: request.maxTokens,
    temperature: request.temperature,
    ...(request.responseFormat?.type === "json_object"
          ? { responseMimeType: "application/json" }
          : {}),
  },
}
```

**Règles normatives structurelles** :
- Gemini n'a pas de rôle `assistant` — c'est `model`. Mapping : `"user"` → `"user"`, `"assistant"` → `"model"`. Les rôles `"system"` sont **extraits** de `messages` et passent dans `systemInstruction.parts[0].text` (concaténés s'il y en a plusieurs, séparateur `"\n\n"`).
- Si aucun message système → `systemInstruction` **omis**.
- Chaque message est converti en `{ role, parts: [{ text: content }] }`. Un message avec `content: ""` est conservé (le binding ne filtre pas).
- `generationConfig.maxOutputTokens` et `temperature` : omis si `undefined` (idem OpenAI).
- `responseMimeType: "application/json"` est l'équivalent Gemini de `response_format.type = "json_object"`.

### 6.3 `parseResponse(body, headers)`

**Algorithme** :
1. `const parsed = JSON.parse(bodyText)` — throw `ResponseParseError` si échec.
2. Cas safety-block : si `parsed.promptFeedback?.blockReason` est défini ET `parsed.candidates` est absent ou vide → throw `ContentFilterError("google: prompt blocked: ${blockReason}")`.
3. Sinon, valider : `parsed.candidates` non vide, sinon throw `ResponseParseError("google: missing candidates")`.
4. `const candidate = parsed.candidates[0]`.
5. Extraction :

```ts
return {
  rawContent: (candidate.content?.parts ?? [])
                .filter(p => typeof p.text === "string")
                .map(p => p.text)
                .join(""),
  terminationSignal: candidate.finishReason,  // "STOP", "MAX_TOKENS", "SAFETY", ...
  usage: parsed.usageMetadata ? {
    inputTokens: parsed.usageMetadata.promptTokenCount,
    outputTokens: parsed.usageMetadata.candidatesTokenCount,
    totalTokens: parsed.usageMetadata.totalTokenCount,
  } : undefined,
  providerResponseId: parsed.responseId,  // peut être undefined
  providerModel: parsed.modelVersion,     // peut être undefined
};
```

**Règles** :
- `ContentFilterError` throwée directement en §6.3 step 2 est une **exception** à la règle "`classifyError` est le seul point de classification d'erreur" : un safety-block n'est pas un signal HTTP d'erreur — c'est une réponse 200 valide avec un payload particulier. Le parse est donc l'endroit naturel pour le détecter. Cette exception est explicite (§15.4 NX).
- Normalisation `usage` : Gemini utilise `promptTokenCount`/`candidatesTokenCount`/`totalTokenCount` → conversion vers `inputTokens`/`outputTokens`/`totalTokens`.
- Si `candidate.content` est absent (cas très dégradé), `rawContent = ""`. L'engine traitera via integrity.

### 6.4 `classifyError(signal)`

**Algorithme** :
1. Déléguer à `classifyFromHttpStatus(signal)`.
2. **Pas d'override v1** : Gemini expose des erreurs HTTP standard (400, 401, 403, 429, 500, 503). Le mapping base suffit.
3. Extraction du message d'erreur : body au format Google `{ "error": { "code": 400, "message": "...", "status": "INVALID_ARGUMENT" } }`. Extraire `error.message`.
4. Retourner.

### 6.5 `readRateLimitHeaders(headers)`

**Retourne toujours `null` en v1.** Rationale NX §15.4 : Gemini n'expose pas de rate-limit headers fiables dans cette version. Le `hasRateLimitHeaders: false` l'indique. Le retry delay éventuellement présent dans le **body** d'erreur (`retryInfo.retryDelay`) n'est **pas** parsé en v1 — fallback backoff exponentiel standard.

### 6.6 `terminationMap`

```ts
terminationMap: {
  "STOP": "completed",
  "MAX_TOKENS": "max_tokens",
  "SAFETY": "content_filter",
  "RECITATION": "content_filter",
  "BLOCKLIST": "content_filter",
  "PROHIBITED_CONTENT": "content_filter",
  "SPII": "content_filter",
  "LANGUAGE": "content_filter",
  "MALFORMED_FUNCTION_CALL": "unknown",
  "FINISH_REASON_UNSPECIFIED": "unknown",
  "OTHER": "unknown",
} as const;
```

### 6.7 `quirks`

```ts
quirks: {
  defaultSanitization: { stripThinkingTags: true, stripJsonFence: true },
  hasRateLimitHeaders: false,
  mayRouteModel: false,  // Gemini retourne modelVersion stable
};
```

---

## 7. Algorithmes partagés / Helpers internes

Chaque binding peut implémenter des helpers internes **non-exportés** :
- Extraction de message d'erreur depuis body provider.
- Parsing de durée relative (OpenAI-like) vers ms.
- Lecture d'un bucket rate-limit complet à partir d'un préfixe.

Ces helpers restent **privés au fichier du binding**. La duplication légère entre bindings est préférée à une abstraction prématurée qui créerait un couplage trans-binding.

**Exception unique** : `classifyFromHttpStatus` est importé depuis `NIB-M-ERROR-CLASSIFIER-BASE`. C'est le **seul** import transverse autorisé depuis un binding.

---

## 8. Examples

### 8.1 Anthropic — buildRequest

```ts
const req: LLMRequest = {
  messages: [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hello." },
  ],
  temperature: 0.7,
  maxTokens: 500,
};
const config: BindingConfig = { model: "claude-opus-4", apiKey: "sk-ant-...", providerOptions: { extendedThinking: { enabled: true, budgetTokens: 10000 } } };

const canonical = anthropicBinding.buildRequest(req, config);
// => {
//   method: "POST",
//   url: "https://api.anthropic.com/v1/messages",
//   headers: { "content-type": "application/json", "x-api-key": "sk-ant-...", "anthropic-version": "2023-06-01" },
//   body: JSON.stringify({
//     model: "claude-opus-4",
//     max_tokens: 500,
//     system: "You are helpful.",
//     messages: [{ role: "user", content: "Hello." }],
//     temperature: 0.7,
//     thinking: { type: "enabled", budget_tokens: 10000 },
//   }),
// }
```

### 8.2 OpenAI — parseResponse

```ts
const body = JSON.stringify({
  id: "chatcmpl-abc",
  model: "gpt-4o-2024-08-06",
  choices: [{
    index: 0,
    message: { role: "assistant", content: "Hello!" },
    finish_reason: "stop",
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const parsed = openaiBinding.parseResponse(body, { "content-type": "application/json" });
// => {
//   rawContent: "Hello!",
//   terminationSignal: "stop",
//   usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
//   providerResponseId: "chatcmpl-abc",
//   providerModel: "gpt-4o-2024-08-06",
// }
```

### 8.3 Google Gemini — safety-block

```ts
const body = JSON.stringify({
  promptFeedback: { blockReason: "SAFETY" },
  candidates: [],  // ou absent
});

// parseResponse(body, headers) throw:
//   ContentFilterError("google: prompt blocked: SAFETY")
```

### 8.4 OpenAI-compatible DeepSeek — quirks

```ts
const deepseekBinding = createOpenAICompatibleBinding({
  provider: "deepseek",
  defaultEndpoint: "https://api.deepseek.com",
});

deepseekBinding.quirks;
// => {
//   defaultSanitization: { stripThinkingTags: true, stripJsonFence: false },
//   hasRateLimitHeaders: false,
//   mayRouteModel: false,
// }
// → l'engine appliquera stripThinkingTags sur le content (thinking tags DeepSeek R1).
```

---

## 9. Edge cases

### 9.1 `buildRequest` avec `messages` vide
- Contrat `LLMRequest` exige `messages.length > 0`, validé par l'engine avant appel au binding. Le binding **n'effectue pas** cette validation — il peut assumer `messages.length >= 1`.

### 9.2 `parseResponse` avec body non-JSON
- Throw `ResponseParseError` avec message explicite et `cause` = erreur `JSON.parse` originale.

### 9.3 `readRateLimitHeaders` avec headers vides
- Retourne `null`. Pas de throw, pas de snapshot `{ state: "unknown" }` — c'est la responsabilité de l'engine (voir NIB-M-EXECUTE-CALL §3.k).

### 9.4 `classifyError` avec signal `aborted: true` ou `timeout: true`
- **Ne classifie PAS** : l'engine n'appelle pas `classifyError` dans ces cas — il throw directement `AbortedError` ou `TimeoutError` depuis le point de détection (§14.1 step 7.h NX). Si `classifyError` reçoit néanmoins un tel signal (erreur amont), il délègue à `classifyFromHttpStatus` qui retourne `TransientProviderError` par défaut (fallback défensif).

### 9.5 `content` vide après `parseResponse` (tous bindings)
- `rawContent === ""` n'est **jamais** un throw du binding. C'est un état valide. L'engine applique ensuite le sanitizer, puis `detectHeuristicTruncation` (qui retourne `false` sur `""`, voir NIB-M-SANITIZER §3.3).

### 9.6 `providerOptions` avec champ inconnu
- Ignoré silencieusement. Pas de warning, pas de throw. Un champ inconnu peut être ajouté par le consommateur pour une version future — compatibilité ascendante.

### 9.7 Gemini avec `candidates[0].content.parts` contenant un mix texte/tool-call
- Filter strict sur `typeof p.text === "string"`. Les parts `functionCall` sont ignorées en v1 (pas de tool support côté runtime).

---

## 10. Constraints

### 10.1 Aucun I/O direct depuis un binding
- `fetch`, `setTimeout`, `performance.now`, `Date.now`, `console` : **interdits** dans le corps d'un binding. Exceptions strictement documentées : `clock.nowMono()` et `clock.nowWall()` depuis `readRateLimitHeaders` uniquement (§3.5, §4.5, §5.5).
- L'engine seul fait `fetch`. Les bindings construisent les requêtes et parsent les réponses ; ils ne les exécutent jamais.

### 10.2 Pas de dépendance SDK provider
- Aucun import de `@anthropic-ai/sdk`, `openai`, `@google/generative-ai`. Tous les bindings utilisent `fetch` natif (exécuté par l'engine) + `JSON.parse`/`JSON.stringify`. Rationale NX §5.6 : empreinte de dépendances minimale, éviter les transitive deps incontrôlées.

### 10.3 Pas de state mutable dans un binding
- Les bindings sont des objets **figés** (`as const` ou équivalent structurel). Aucun `let`, aucune closure mutative. Les fonctions sont pures (modulo les exceptions `clock` documentées).

### 10.4 Pas de retry, pas de throttle, pas de timeout
- Toute mention de retry/throttle/timeout dans un fichier binding = violation. Ces logiques appartiennent à l'engine. Le binding peut **décrire** via `quirks` (ex. `hasRateLimitHeaders`) mais n'agit pas.

### 10.5 Imports autorisés depuis un binding (liste close)

```ts
// Types du package
import type { LLMRequest, CanonicalHttpRequest, ParsedProviderResponse, ProviderErrorSignal, RateLimitSnapshot, TerminationReason, ProviderBinding, BindingConfig, ProviderQuirks, SanitizationPolicy } from "../types";
// Erreurs sémantiques
import { ResponseParseError, ContentFilterError, /* ...les 9 autres si besoin */ } from "../errors";
// Classifier HTTP générique (unique utilitaire transverse autorisé)
import { classifyFromHttpStatus } from "../services/error-classifier-base";
// Horloge (pour readRateLimitHeaders uniquement)
import { nowMono, nowWall } from "../services/clock";
```

Tout autre import est **interdit**.

### 10.6 Structure de fichier

Chaque binding exporte **un seul** symbole public par fichier :

```ts
// src/bindings/anthropic.ts
export const anthropicBinding: ProviderBinding = { /* ... */ };

// src/bindings/openai.ts
export const openaiBinding: ProviderBinding = { /* ... */ };

// src/bindings/google.ts
export const googleBinding: ProviderBinding = { /* ... */ };

// src/bindings/openai-compatible.ts
export function createOpenAICompatibleBinding(params: {...}): ProviderBinding { /* ... */ }
```

Le fichier `openai-compatible.ts` est le **seul** à exporter une factory (car paramétré par provider) ; les trois autres exportent une constante.

---

## 11. Integration snippets

### 11.1 Comment un binding est utilisé par l'engine

```ts
// Dans src/engine/execute-call.ts (voir NIB-M-EXECUTE-CALL)
export async function executeCall(
  request: LLMRequest,
  binding: ProviderBinding,
  config: AdapterConfig,
): Promise<LLMResponse> {
  // ...validation, throttle, signal composition...
  const canonicalRequest = binding.buildRequest(request, bindingConfig);
  const response = await fetch(canonicalRequest.url, { ... });
  const bodyText = await response.text();
  const headers = Object.fromEntries(response.headers.entries());
  // ...status check via binding.classifyError si non-2xx...
  const parsedResponse = binding.parseResponse(bodyText, headers);
  const snapshot = binding.readRateLimitHeaders(headers);
  // ...sanitization, integrity, build LLMResponse...
}
```

### 11.2 Comment un binding est consommé par une factory

```ts
// Dans src/factories/anthropic.ts (voir NIB-M-FACTORIES)
import { anthropicBinding } from "../bindings/anthropic";
import { executeCall } from "../engine/execute-call";

export function createAnthropicAdapter(config: AdapterConfig): ProviderAdapter {
  return {
    provider: anthropicBinding.provider,
    call: (request) => executeCall(request, anthropicBinding, config),
    stats: { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalDurationMs: 0 },
  };
}
```

### 11.3 Test d'acceptance typique (référence NIB-T §10.1)

```ts
// tests/bindings/anthropic.test.ts
import { describe, test, expect } from "vitest";
import { anthropicBinding } from "../../src/bindings/anthropic";

describe("anthropic binding — buildRequest", () => {
  test("T-BA-01: concatène les messages system en une seule string", () => {
    const req = { messages: [
      { role: "system", content: "A." },
      { role: "system", content: "B." },
      { role: "user", content: "Hi" },
    ] };
    const canonical = anthropicBinding.buildRequest(req, { model: "m", apiKey: "k" });
    const body = JSON.parse(canonical.body);
    expect(body.system).toBe("A.\n\nB.");
    expect(body.messages).toEqual([{ role: "user", content: "Hi" }]);
  });
});
```

---

## 12. Definition of Done (DoD)

Un binding est considéré correctement implémenté quand :

1. **Interface** : il exporte une constante (ou factory pour OpenAI-compatible) conforme au type `ProviderBinding`. `provider` figé, `terminationMap` et `quirks` figés (`as const` ou `Object.freeze`).
2. **Tests NIB-T** : tous les tests du NIB-T associé passent (§10, §11, §12, ou §13 selon le binding). Aucun test skippé, aucun `.only`.
3. **Pureté** : aucune des fonctions n'effectue d'I/O direct. Seules `readRateLimitHeaders` peut lire `clock.nowMono()` et `clock.nowWall()` (exception matérialisée).
4. **Imports** : conformes à la liste close §10.5. Tout autre import = refus.
5. **LOC** : ≤ 150 pour Anthropic, OpenAI, Google, OpenAI-compatible. Au-delà, justifier ou refactoriser.
6. **Pas de state mutable** : `const` partout, objets figés.
7. **Throws** : uniquement `ResponseParseError` et `ContentFilterError` (pour Gemini safety-block) depuis le binding. Toute autre erreur est retournée via `classifyError`.
8. **Contract tests** : les 6 invariants du NIB-S (I-2, I-5, I-8, I-9, I-11 applicables aux bindings) sont respectés.

---

## 13. Relation avec les autres NIB-M

- **Consomme** :
  - `NIB-M-ERRORS` (classes d'erreur pour `classifyError` et throws internes)
  - `NIB-M-ERROR-CLASSIFIER-BASE` (`classifyFromHttpStatus`)
  - `NIB-M-INFRA-UTILS` (`clock` pour `readRateLimitHeaders` uniquement)
- **Ne consomme PAS** :
  - `NIB-M-SANITIZER` (sanitization appliquée par l'engine, pas le binding)
  - `NIB-M-RETRY-RESOLVER` (retry appliqué par l'engine)
  - `NIB-M-THROTTLE` (throttle appliqué par l'engine)
  - `NIB-M-SIGNAL-COMPOSER` (signaux gérés par l'engine)
  - `NIB-M-TOKEN-ESTIMATOR` (estimation faite par l'engine)
- **Est consommé par** :
  - `NIB-M-EXECUTE-CALL` (orchestration)
  - `NIB-M-FACTORIES` (instanciation des adapters)

---

## 14. Metadata

| Champ | Valeur |
|---|---|
| Source NX | §5.4, §15.1, §15.2, §15.3, §15.4 |
| NIB-T associé | §10 (Anthropic), §11 (OpenAI), §12 (OpenAI-compatible), §13 (Google) |
| Invariants NIB-S couverts | I-2 (moteur unique), I-5 (déterminisme), I-8 (config figée), I-11 (JSON-only v1) |
| Fichiers produits | `src/bindings/anthropic.ts`, `src/bindings/openai.ts`, `src/bindings/openai-compatible.ts`, `src/bindings/google.ts` |
| LOC cible cumulée | 350-550 LOC |

---

## 15. Historique

| Version | Date | Changements |
|---|---|---|
| 1.0.0 | 2026-04 | Création initiale. Regroupe 4 bindings completion (Anthropic, OpenAI, OpenAI-compatible pour 5 providers, Google Gemini) en sous-sections normatives d'un seul NIB-M, selon décision de décomposition. |

---

*VegaCorp — Implicit-Free Execution (IFE) — "La fiabilité précède l'intelligence."*
