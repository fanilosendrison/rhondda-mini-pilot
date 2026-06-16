---
id: NIB-M-EXECUTE-CALL
type: nib-module
version: "1.0.0"
scope: llm-runtime
module: execute-call
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-M-EXECUTE-CALL — Module Brief — `executeCall` (moteur d'orchestration completion)

**Package** : `@vegacorp/llm-runtime`
**Source NX** : §14.1 (flux end-to-end), §5.3 (Execution Engine), §10 (décisions matérialisées), §11 (observabilité), §13 (signaux), §14.1 (28 sous-étapes détaillées)
**NIB-T associé** : §15 (happy path), §16 (retry), §17 (throttle), §18 (abort/timeout), §19 (integrity)

---

## 1. Purpose

`executeCall` est le **point unique d'exécution** d'un call completion dans `@vegacorp/llm-runtime`. Son rôle : orchestrer le flux complet depuis la réception d'une `LLMRequest` jusqu'au retour d'une `LLMResponse` matérialisée et observable.

**Principe normatif structurant — "moteur unique, bindings minces" (I-2 du NIB-S)** : toute décision opérationnelle (retry, throttle, timeout, signal composition, sanitization, integrity, enrichissement d'erreur, émission d'events) est matérialisée dans `executeCall`. Les bindings ne font que traduire ; l'engine seul orchestre.

**Principe normatif structurant — "zero decision latitude" (I-3 du NIB-S)** : `executeCall` n'a aucune latitude décisionnelle cachée. Chaque branche est explicitée dans le flux §3 ci-dessous. Les 28 sous-étapes sont exhaustives et ordonnées ; toute inversion, ajout, ou suppression viole le contrat.

**Principe normatif structurant — "fail-closed" (I-4 du NIB-S)** : toute ambiguïté (binding qui throw, signal aborted non attendu, snapshot corrompu) fait throw une erreur sémantique appropriée. Aucune dégradation silencieuse.

**Non-exporté publiquement** : `executeCall` n'est **pas** dans l'API publique du package. Seules les factories (voir NIB-M-FACTORIES) l'appellent en interne. Les consommateurs utilisent `adapter.call(request)`, qui délègue à `executeCall(request, binding, config)`.

**Fichier cible** : `src/engine/execute-call.ts`. **LOC cible** : ~250-350.

---

## 2. Inputs / Outputs

### 2.1 Signature

```ts
export async function executeCall(
  request: LLMRequest,
  externalSignal: AbortSignal | undefined,      // extrait de options.signal par l'adapter
  binding: ProviderBinding,
  config: AdapterConfig,
  throttleSnapshot: ThrottleSnapshotService,    // injecté par la factory
  logger: LLMLogger,                            // résolu depuis config.logging
  stats: AdapterStats,                          // mutable — incrémenté en place
): Promise<LLMResponse>;
```

**Note sur les paramètres injectés** (`throttleSnapshot`, `logger`, `stats`) : ils sont injectés par la factory (NIB-M-FACTORIES §3) pour préserver la testabilité et éviter les singletons globaux. Le test NIB-T construit un faux `throttleSnapshot` en mémoire pour chaque cas. Les stats sont mutées in-place dans l'objet `adapter.stats` — unique effet de bord admis sur un objet extérieur.

### 2.2 Contrat de sortie

- Succès → `LLMResponse` (voir NIB-S §6.2) avec tous les champs canoniques remplis.
- Échec → throw une instance de `LLMRuntimeError` enrichie (callId, provider, model, attempts). Aucun autre type d'erreur ne peut être levé. Tout throw inattendu d'une dépendance est capturé et converti en erreur sémantique avant d'être levé.

### 2.3 Garanties temporelles

- Aucun sleep supérieur à `config.timeout.perAttemptMs` dans un même attempt.
- Aucun call sans passage par la matérialisation `throttleDecision` (même si `throttle: false`).
- Aucun throw sans émission préalable d'`llm_call_end` (voir §3.24).

---

## 3. Algorithme — 28 sous-étapes

L'ordre ci-dessous est **normatif**. Une implémentation qui réordonne, fusionne, ou omet une étape est non conforme. Les étapes 7.a à 7.w forment la boucle de retry ; les étapes 1-6, 8-10 sont hors boucle.

### 3.1 Générer `callId`
```ts
const callId = generateCallId();  // ulid() (voir NIB-M-INFRA-UTILS §3)
```

### 3.2 Capturer `startedAt` (wall)
```ts
const startedAt = nowWallIso();  // ISO 8601 string
```

### 3.3 Capturer `startMono`
```ts
const startMono = nowMono();  // monotone pour durée
```

### 3.4 Émettre `llm_call_start`
```ts
logger.emit({
  type: "llm_call_start",
  callId, provider: binding.provider, model: config.model,
  ts: startedAt,
  request: { messageCount: request.messages.length, hasMaxTokens: request.maxTokens !== undefined, hasTemperature: request.temperature !== undefined },
});
```

### 3.5 Valider `request`
- `request.messages.length > 0`, sinon throw `InvalidRequestError("messages cannot be empty")` enrichie `(callId, provider, model, attempts: 0)`. Pas de retry, pas de sleep : on entre directement en §3.27 (log end + throw).
- Chaque `message.role` ∈ `{"system", "user", "assistant"}`. Sinon idem.
- Cohérence séquentielle optionnelle en v1 : pas de vérif stricte alternance user/assistant (laissé au binding/provider qui rejettera 400 si besoin).

### 3.6 Charger le snapshot throttle initial

```ts
let snapshot: RateLimitSnapshot | null = throttleSnapshot.get();
let lastHeaders: Record<string, string> = {};
let lastError: LLMRuntimeError | undefined = undefined;
const bindingConfig: BindingConfig = {
  model: config.model,
  apiKey: config.apiKey,
  endpoint: config.endpoint,
  providerOptions: config.providerOptions,
};
```

**Note normative** : `bindingConfig` est **calculé une fois**, avant la boucle, et **immutable** pour toute la durée du call. Jamais reconstruit à chaque attempt. Cette projection `AdapterConfig → BindingConfig` matérialise la séparation "paramètres binding" vs "policies engine" (§5.4 NX).

### 3.7 Boucle d'attempts

```ts
for (let attempt = 0; attempt < config.retry.maxAttempts; attempt++) {
  // §3.8 à §3.26 ci-dessous
}
// §3.27 : si la boucle sort sans return
```

**Invariant de boucle** : à tout instant, `attempt` représente le nombre de fetches **déjà effectués** dans cet attempt. Un retry signifie `attempt+1` devient le nouveau `attempt`. `attempt = 0` est l'attempt initial.

### 3.8 Pré-check : signal déjà aborted

```ts
if (externalSignal?.aborted) {
  if (cleanup) cleanup();  // nettoyer un éventuel timer précédent
  const err = new AbortedError("request aborted before execution");
  enrichAndThrow(err, { callId, provider: binding.provider, model: config.model, attempts: attempt });
}
```

**`enrichAndThrow`** est un helper interne qui :
1. Écrase systématiquement les champs `callId`, `provider`, `model`, `attempts` de l'erreur (l'engine connaît toujours mieux le contexte — §14.1 step 7.b NX).
2. Émet `llm_call_end` avec `success: false, errorKind: err.kind`.
3. Throw l'erreur.

### 3.9 Résolution retry (attempts > 0 uniquement)

Si `attempt === 0` : skip cette étape.
Si `attempt > 0` :

```ts
const retryDecision = resolveRetryDecision(lastError!, attempt, lastHeaders, config.retry);
// retryDecision: { retry: boolean, delayMs: number, reason: RetryReason }
```

Voir NIB-M-RETRY-RESOLVER pour la sémantique exacte de `resolveRetryDecision`.

### 3.10 Classification "transient_unknown"

```ts
if (attempt > 0 && retryDecision.reason === "transient_unknown") {
  logger.emit({
    type: "llm_call_unknown_error_classified",
    callId, provider: binding.provider, model: config.model,
    attempt, reason: "transient_unknown",
    rawSignal: extractRawSignal(lastError),  // status, bodySnippet ≤500 chars, networkErrorKind, rawMessage
  });
}
```

### 3.11 Décision fatale retry

```ts
if (attempt > 0 && retryDecision.retry === false) {
  // Enrichir lastError et throw via enrichAndThrow.
  enrichAndThrow(lastError!, { callId, provider: binding.provider, model: config.model, attempts: attempt });
}
```

### 3.12 Log `llm_call_retry_scheduled` (avant sleep)

Si `attempt > 0` et `retryDecision.retry === true` :

```ts
logger.emit({
  type: "llm_call_retry_scheduled",
  callId, provider: binding.provider, model: config.model,
  attempt, delayMs: retryDecision.delayMs, reason: retryDecision.reason,
});
```

### 3.13 Sleep retry interruptible

```ts
if (attempt > 0) {
  try {
    await abortableSleep(retryDecision.delayMs, externalSignal);
  } catch (e) {
    // Le sleep a reject → abort externe pendant l'attente.
    const err = new AbortedError("aborted during retry wait", { cause: e });
    enrichAndThrow(err, { callId, provider: binding.provider, model: config.model, attempts: attempt });
  }
}
```

Voir NIB-M-SIGNAL-COMPOSER pour le contrat `abortableSleep`.

### 3.14 Calcul throttle decision

```ts
const estimatedTokens = estimateCallTokens(request.messages, snapshot, request.maxTokens);
const throttleDecision = resolveThrottleDecision(snapshot, estimatedTokens, nowMono());
```

Voir NIB-M-TOKEN-ESTIMATOR et NIB-M-THROTTLE.

### 3.15 Sleep throttle interruptible

```ts
if (throttleDecision.throttle === true) {
  logger.emit({
    type: "llm_call_throttled",
    callId, provider: binding.provider, model: config.model,
    attempt, waitMs: throttleDecision.waitMs, reason: throttleDecision.reason,
    estimatedTokens, snapshotState: snapshot?.state ?? "null",
  });
  try {
    await abortableSleep(throttleDecision.waitMs, externalSignal);
  } catch (e) {
    const err = new AbortedError("aborted during throttle wait", { cause: e });
    enrichAndThrow(err, { callId, provider: binding.provider, model: config.model, attempts: attempt });
  }
}
```

### 3.16 Log `llm_call_attempt_start`

```ts
logger.emit({
  type: "llm_call_attempt_start",
  callId, provider: binding.provider, model: config.model,
  attempt, estimatedTokens,
});
```

### 3.17 `binding.buildRequest`

```ts
const canonicalRequest = binding.buildRequest(request, bindingConfig);
```

Si le binding throw (ne devrait pas, buildRequest est pur) : enrichir et throw. Le binding v1 garantit qu'il ne throw pas depuis `buildRequest`.

### 3.18 Compose signal avec timeout

```ts
const { signal: composedSignal, cleanup } = composeSignal(externalSignal, config.timeout.perAttemptMs);
```

Voir NIB-M-SIGNAL-COMPOSER §3.1 pour les règles de priorité (abort externe > timeout interne).

### 3.19 Fetch HTTP

```ts
let response: Response;
let bodyText: string;
let headers: Record<string, string>;
try {
  response = await fetch(canonicalRequest.url, {
    method: canonicalRequest.method,
    headers: canonicalRequest.headers,
    body: canonicalRequest.body,
    signal: composedSignal,
  });
} catch (err) {
  cleanup();
  lastHeaders = {};
  const providerSignal = buildProviderErrorSignalFromFetchError(err, externalSignal);
  logger.emit({
    type: "llm_call_fetch_error",
    callId, provider: binding.provider, model: config.model,
    attempt,
    networkErrorKind: providerSignal.networkErrorKind,
    message: err instanceof Error ? err.message : String(err),
  });
  lastError = binding.classifyError(providerSignal);
  continue;  // retour boucle — décision retry en §3.9 du tour suivant
}
```

**`buildProviderErrorSignalFromFetchError`** — helper interne :
```ts
function buildProviderErrorSignalFromFetchError(err: unknown, externalSignal?: AbortSignal): ProviderErrorSignal {
  if (err instanceof DOMException && err.name === "AbortError") {
    // Priorité §13.2 NX : abort externe l'emporte sur timeout interne.
    if (externalSignal?.aborted) return { aborted: true, timeout: false, headers: {} };
    return { aborted: false, timeout: true, headers: {} };
  }
  if (err instanceof TypeError) {
    return { aborted: false, timeout: false, headers: {}, networkErrorKind: inferNetworkErrorKind(err) };
  }
  return { aborted: false, timeout: false, headers: {}, networkErrorKind: "unknown" };
}
```

**`inferNetworkErrorKind`** (§14.1 step 7.h NX) : helper interne best-effort, non exporté. Codomain `"dns" | "connection" | "reset" | "unknown"` avec fallback obligatoire `"unknown"` et absence de throw.

### 3.20 Lire status + body + normaliser headers

```ts
const status = response.status;
bodyText = await response.text();
headers = Object.fromEntries(response.headers.entries());
lastHeaders = headers;
```

**Règle normative** : les clés de `headers` après `Object.fromEntries` sont **lowercase** (garanti par l'API `Headers`). Les headers multi-valeur sont collapsés sur la dernière occurrence.

### 3.21 cleanup timer

```ts
cleanup();
```

**Règle normative I-5 NIB-S (timer ownership)** : le timer est libéré immédiatement après lecture du body, indépendamment du statut HTTP.

### 3.22 Handling status non-2xx

```ts
if (status < 200 || status >= 300) {
  const providerSignal: ProviderErrorSignal = { aborted: false, timeout: false, status, headers, bodyText };
  lastError = binding.classifyError(providerSignal);
  logger.emit({
    type: "llm_call_provider_error",
    callId, provider: binding.provider, model: config.model,
    attempt,
    status,
    semanticErrorKind: lastError.kind,
    retryable: isRetriableKind(lastError.kind),
  });

  // Mise à jour snapshot sur rate-limit signaling (429 ou 529).
  if ((lastError.kind === "rate_limit" || lastError.kind === "overloaded") && binding.quirks.hasRateLimitHeaders) {
    const newSnapshot = binding.readRateLimitHeaders(headers);
    if (newSnapshot !== null) {
      throttleSnapshot.set(newSnapshot);
      snapshot = newSnapshot;
    } else {
      const invalidated = { ...(snapshot ?? {}), state: "unknown" as const, capturedAtMono: nowMono() };
      throttleSnapshot.set(invalidated);
      snapshot = invalidated;
    }
  }
  // Si hasRateLimitHeaders === false, le snapshot n'est PAS modifié sur erreur.

  continue;  // retour boucle
}
```

### 3.23 `binding.parseResponse`

```ts
let parsedResponse: ParsedProviderResponse;
try {
  parsedResponse = binding.parseResponse(bodyText, headers);
} catch (err) {
  if (err instanceof ResponseParseError || err instanceof ContentFilterError) {
    lastError = err;
  } else {
    lastError = new ResponseParseError("unexpected parse error", { cause: err });
  }
  logger.emit({
    type: "llm_call_parse_error",
    callId, provider: binding.provider, model: config.model,
    attempt,
    errorKind: lastError.kind,
    message: lastError.message,
  });
  continue;  // retour boucle — décision retry en §3.9 du tour suivant (fatal_parse_error)
}
```

**Note** : les erreurs de parse sont traitées uniformément via la boucle. Le `resolveRetryDecision` au prochain tour retournera `retry: false` pour `ResponseParseError` (fatal_parse_error) — voir NIB-M-RETRY-RESOLVER §3.1.

### 3.24 Mise à jour snapshot après succès parsing

```ts
const newSnapshot = binding.readRateLimitHeaders(headers);
if (newSnapshot !== null) {
  // Enrichir avec lastCallOutputTokens si disponible (pour le token-estimator)
  const enriched = parsedResponse.usage?.outputTokens !== undefined
    ? { ...newSnapshot, lastCallOutputTokens: parsedResponse.usage.outputTokens }
    : newSnapshot;
  throttleSnapshot.set(enriched);
  snapshot = enriched;
}
// Si null → NE PAS invalider (un call sans headers exploitables ne doit pas effacer un état connu précédent).
```

### 3.25 Sanitization

```ts
const resolvedStripThinkingTags = config.sanitization?.stripThinkingTags ?? binding.quirks.defaultSanitization.stripThinkingTags;
const resolvedStripJsonFence = config.sanitization?.stripJsonFence ?? binding.quirks.defaultSanitization.stripJsonFence;

const { content: cleanContent, sanitizationInfo } = sanitizeContent(parsedResponse.rawContent, {
  stripThinkingTags: resolvedStripThinkingTags,
  stripJsonFence: resolvedStripJsonFence,
});

logger.emit({
  type: "llm_call_sanitized",
  callId, provider: binding.provider, model: config.model,
  attempt,
  info: sanitizationInfo,
});
```

Voir NIB-M-SANITIZER.

### 3.26 Integrity (truncation + terminationMap + mismatch check)

**3.26.a — Détection truncation (heuristique)** :
```ts
const heuristicallyTruncated = config.integrity.detectHeuristicTruncation
  ? detectHeuristicTruncation(cleanContent)
  : false;
```

**3.26.b — Mapping termination** :
```ts
const terminationReason: TerminationReason = binding.terminationMap[parsedResponse.terminationSignal] ?? "unknown";
```

**3.26.c — Truncation explicite par `max_tokens`** :
```ts
const explicitlyTruncated = terminationReason === "max_tokens";
```

**3.26.d — Fail si `failOnSilentTruncation`** :
```ts
if (config.integrity.failOnSilentTruncation && heuristicallyTruncated && !explicitlyTruncated) {
  lastError = new SilentTruncationError("content truncated heuristically", { extra: { rawContent: parsedResponse.rawContent.slice(0, 500), terminationSignal: parsedResponse.terminationSignal } });
  enrichAndThrow(lastError, { callId, provider: binding.provider, model: config.model, attempts: attempt + 1 });
}
```

**3.26.e — Fail si `failOnUnknownTermination`** :
```ts
if (config.integrity.failOnUnknownTermination && terminationReason === "unknown") {
  lastError = new ProviderProtocolError(`unknown termination signal: ${parsedResponse.terminationSignal}`);
  enrichAndThrow(lastError, { callId, provider: binding.provider, model: config.model, attempts: attempt + 1 });
}
```

**3.26.f — Mismatch check** (ordre précis, voir §14.1 step 7.q NX) :
```ts
if (config.integrity.failOnModelMismatch === true) {
  if (config.integrity.modelMismatchPredicate) {
    const mismatch = config.integrity.modelMismatchPredicate(request.model ?? config.model, parsedResponse.providerModel ?? (request.model ?? config.model));
    if (mismatch) {
      enrichAndThrow(new ProviderProtocolError("model mismatch (custom predicate)"), { callId, provider: binding.provider, model: config.model, attempts: attempt + 1 });
    }
  } else if (!binding.quirks.mayRouteModel
             && parsedResponse.providerModel !== undefined
             && parsedResponse.providerModel !== (request.model ?? config.model)) {
    enrichAndThrow(new ProviderProtocolError(`model mismatch: requested ${request.model ?? config.model}, got ${parsedResponse.providerModel}`), { callId, provider: binding.provider, model: config.model, attempts: attempt + 1 });
  }
  // Si providerModel est undefined → skip silencieusement (pas d'information exploitable).
}
```

### 3.27 Construction `LLMResponse` et return

```ts
const endedAt = nowWallIso();
const durationMs = Math.round(nowMono() - startMono);

const llmResponse: LLMResponse = {
  callId,
  provider: binding.provider,
  model: config.model,
  requestedModel: request.model ?? config.model,
  providerResponseId: parsedResponse.providerResponseId,
  providerModel: parsedResponse.providerModel,
  content: cleanContent,
  rawContent: parsedResponse.rawContent,
  terminationReason,
  terminationSignal: parsedResponse.terminationSignal,
  sanitization: sanitizationInfo,
  integrity: {
    heuristicallyTruncated,
    explicitlyTruncated,
    modelMismatch: parsedResponse.providerModel !== undefined
                   && parsedResponse.providerModel !== (request.model ?? config.model),
  },
  usage: parsedResponse.usage,
  attemptCount: attempt + 1,  // 1-indexé dans la réponse
  startedAt,
  endedAt,
  durationMs,
};

// Update stats (mutation in-place sur objet extérieur — effet de bord assumé).
stats.totalCalls += 1;
if (parsedResponse.usage?.inputTokens !== undefined)  stats.totalInputTokens  += parsedResponse.usage.inputTokens;
if (parsedResponse.usage?.outputTokens !== undefined) stats.totalOutputTokens += parsedResponse.usage.outputTokens;
stats.totalDurationMs += durationMs;

logger.emit({
  type: "llm_call_end",
  callId, provider: binding.provider, model: config.model,
  success: true,
  attemptCount: attempt + 1,
  durationMs,
  usage: parsedResponse.usage,
  terminationReason,
});

return llmResponse;
```

### 3.28 Fin de boucle sans return

Si la boucle sort sans avoir return (i.e., `attempt === maxAttempts` atteint via `continue` consécutifs) :

```ts
// Post-boucle — tous les attempts épuisés.
enrichAndThrow(lastError!, {
  callId, provider: binding.provider, model: config.model,
  attempts: config.retry.maxAttempts,
});
```

`enrichAndThrow` émet `llm_call_end` avec `success: false` avant de throw.

---

## 4. Helpers internes

Les helpers ci-dessous sont **privés** à `src/engine/execute-call.ts` (ou dans un fichier interne `src/engine/_internal/` s'ils deviennent réutilisés par `execute-embedding.ts`) :

| Helper | Rôle | Signature |
|---|---|---|
| `enrichAndThrow(err, ctx)` | Écrase `callId`/`provider`/`model`/`attempts`, émet `llm_call_end { success: false }`, throw. | `(err: LLMRuntimeError, ctx: { callId, provider, model, attempts }) => never` |
| `buildProviderErrorSignalFromFetchError(err, signal)` | Construit `ProviderErrorSignal` depuis un throw de `fetch`. | `(err: unknown, externalSignal?: AbortSignal) => ProviderErrorSignal` |
| `inferNetworkErrorKind(err)` | Best-effort, codomain `"dns" \| "connection" \| "reset" \| "unknown"`. | `(err: TypeError) => "dns" \| "connection" \| "reset" \| "unknown"` |
| `extractRawSignal(err)` | Pour logs `llm_call_unknown_error_classified` — extrait status, bodySnippet (≤500 chars), networkErrorKind, rawMessage. | `(err: LLMRuntimeError) => { status?, bodySnippet?, networkErrorKind?, rawMessage }` |

Aucun de ces helpers n'est exporté hors du package.

---

## 5. Examples

### 5.1 Happy path — Anthropic succès premier attempt

```ts
const request: LLMRequest = {
  messages: [{ role: "user", content: "Hi" }],
  maxTokens: 100,
};
const config: AdapterConfig = {
  model: "claude-opus-4",
  apiKey: "sk-ant-...",
  retry: { maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60000 },
  timeout: { perAttemptMs: 120000 },
  sanitization: {},
  integrity: { detectHeuristicTruncation: false, failOnSilentTruncation: false, failOnUnknownTermination: false, failOnModelMismatch: false },
  logging: { enabled: true },
};
const response = await executeCall(request, anthropicBinding, config, throttleSnapshot, logger, stats);
// response.attemptCount === 1
// response.terminationReason === "completed"
// response.sanitization.stripThinkingTagsApplied === true (défaut Anthropic)
```

Séquence events émis :
1. `llm_call_start`
2. `llm_call_attempt_start` (attempt: 0)
3. `llm_call_sanitized`
4. `llm_call_end` (success: true, attemptCount: 1)

### 5.2 Retry — 429 puis succès

```ts
// Attempt 0 : 429
// Attempt 1 : sleep(Retry-After) puis fetch → 200
const response = await executeCall(request, openaiBinding, config, throttleSnapshot, logger, stats);
// response.attemptCount === 2
```

Séquence events :
1. `llm_call_start`
2. `llm_call_attempt_start` (attempt: 0)
3. `llm_call_provider_error` (attempt: 0, status: 429, semanticErrorKind: "rate_limit", retryable: true)
4. `llm_call_retry_scheduled` (attempt: 1, delayMs: <parsed>, reason: "rate_limit")
5. `llm_call_attempt_start` (attempt: 1)
6. `llm_call_sanitized`
7. `llm_call_end` (success: true, attemptCount: 2)

### 5.3 Fatal — `ResponseParseError` sur premier attempt

```ts
// Body non-JSON → binding.parseResponse throw ResponseParseError.
await executeCall(request, binding, config, ...);  // throw ResponseParseError enrichie
```

Séquence :
1. `llm_call_start`
2. `llm_call_attempt_start` (attempt: 0)
3. `llm_call_parse_error` (attempt: 0, errorKind: "parse")
4. (boucle tour 2 : resolveRetryDecision → retry: false, reason: "fatal_parse_error")
5. `llm_call_end` (success: false, errorKind: "parse", attempts: 1)
6. throw

### 5.4 Abort externe pendant retry sleep

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 100);  // abort après 100ms
const request = { ...baseRequest, signal: controller.signal };
// Attempt 0 échoue 429 avec Retry-After: 5 → sleep 5000ms, mais abort à 100ms.
await executeCall(request, binding, config, ...);  // throw AbortedError après ~100ms
```

L'abort pendant `abortableSleep` reject, §3.13 capture et throw `AbortedError(attempts: 1)`. Pas de nouvelle attempt.

---

## 6. Edge cases

### 6.1 `maxAttempts === 0`
Comportement : la boucle ne s'exécute pas. `lastError` est `undefined`. §3.28 post-boucle throw un `InvalidRequestError("retry.maxAttempts must be >= 1")`. Cette validation peut être anticipée à la factory (voir NIB-M-FACTORIES), mais l'engine reste défensif.

### 6.2 `maxAttempts === 1`
Un seul attempt, pas de retry possible. Si l'attempt échoue avec une erreur retriable, §3.11 throw immédiatement au tour 2 (boucle sort après `continue` → `attempt === 1` → condition de boucle `attempt < 1` fausse → sort).

### 6.3 Signal déjà aborted en entrée
§3.8 détecte et throw `AbortedError` au premier tour (attempt: 0, cohérent avec aucun fetch effectué).

### 6.4 Binding qui throw depuis `buildRequest`
**Non attendu** (contrat binding : buildRequest est pure). Si cela arrive, l'erreur n'est **pas** capturée par la boucle — elle propage directement. Cette rupture du contrat binding est considérée comme un bug à corriger dans le binding. L'engine ne compense pas.

### 6.5 Timeout interne pendant fetch
`fetch` throw `DOMException("AbortError")`. `buildProviderErrorSignalFromFetchError` distingue `externalSignal.aborted === true` (abort externe prioritaire) vs timeout interne. Dans le cas timeout interne, `binding.classifyError({ aborted: false, timeout: true, headers: {} })` retourne `TimeoutError`. Retriable si `isRetriableKind("timeout") === true`.

### 6.6 `providerResponseId` et `providerModel` undefined
Cas normal pour certains providers (Gemini legacy). `LLMResponse` les expose en `undefined`. Pas d'erreur. Le mismatch check (§3.26.f) skip silencieusement si `providerModel` absent.

### 6.7 Snapshot invalidé par 429 mais pas de `Retry-After`
§3.22 met le snapshot en état `"unknown"`. §3.9 tour suivant : `resolveRetryDecision` → `delayMs = backoff` (calculé via backoff exponentiel, pas `parseRetryAfter`). Le throttle decision au tour suivant respectera le snapshot `unknown` (voir NIB-M-THROTTLE §3.2).

### 6.8 `usage` partiel (seulement inputTokens)
Stats incrémentées partiellement (`totalInputTokens += inputTokens`, `totalOutputTokens` inchangé). `LLMResponse.usage` expose `{ inputTokens: X, outputTokens: undefined, totalTokens: undefined }`. Comportement défensif.

### 6.9 Logger qui throw depuis `emit`
**Contrat LLMLogger** : `emit` ne doit jamais throw. Si cela arrive, l'erreur propage (l'engine ne catch pas les throws de logger). Un consommateur qui fournit un logger buggé voit son call crasher — c'est le prix de l'injection non-défensive. Alternative rejetée : wrapper try/catch systématique autour de chaque `emit` (surcharge de code et dissimulation de bugs logger).

---

## 7. Constraints

### 7.1 Séquence d'émission des events — invariant mécanique
Un test NIB-T (§22.3) vérifie que pour tout call réussi :
1. Exactement un `llm_call_start` au début.
2. Exactement un `llm_call_attempt_start` par attempt.
3. Exactement un `llm_call_end` à la fin (succès ou échec).
4. `llm_call_sanitized` présent si et seulement si un parsing a réussi (attempt réussi jusqu'au §3.25).
5. Pour un call avec N attempts successfuls (N ≥ 2) : exactement N-1 `llm_call_retry_scheduled`, N-1 events d'erreur (fetch/provider/parse), N `llm_call_attempt_start`.

### 7.2 Corrélation
Tous les events d'un même call partagent `callId`. Tous les events ont `provider` et `model`. Tous les events ont `type`. Tous les events ont un `ts` (ISO 8601).

### 7.3 Pas d'`await` hors des points identifiés
Les seuls `await` permis dans `executeCall` :
- `abortableSleep` (retry §3.13, throttle §3.15)
- `fetch` (§3.19)
- `response.text()` (§3.20)

Tout autre `await` est une violation (logique pure partout ailleurs).

### 7.4 Pas de try/catch global autour de la boucle
La boucle `for` n'est **pas** enveloppée dans un try/catch global. Les catchs sont ciblés autour de chaque opération susceptible de throw (fetch, parse, sleep). Cette granularité garantit que chaque erreur suit le bon chemin de log et de classification.

### 7.5 Pas de partage mutable entre attempts (sauf `snapshot`, `lastError`, `lastHeaders`)
Ces trois variables sont les **seuls** états mutables autorisés dans la boucle. Toute autre variable locale doit être re-déclarée dans chaque tour (`let canonicalRequest`, `let bodyText`, etc. sont re-assignés mais conceptuellement "neufs" à chaque attempt).

### 7.6 Pas de modification de `request`
`request` est strictement en lecture. Une copie (`{ ...request, messages: [...request.messages] }`) n'est pas nécessaire tant qu'aucune mutation n'a lieu. L'invariant I-LR-01 du NIB-S (request immutable) est vérifié par test NIB-T §15.7.

### 7.7 Imports autorisés (liste close)

```ts
// Types
import type { LLMRequest, LLMResponse, LLMRuntimeError, ProviderBinding, AdapterConfig, BindingConfig, RateLimitSnapshot, ProviderErrorSignal, ParsedProviderResponse, TerminationReason, LLMLogger, AdapterStats } from "../types";
// Erreurs
import { AbortedError, TimeoutError, InvalidRequestError, ResponseParseError, ContentFilterError, SilentTruncationError, ProviderProtocolError } from "../errors";
// Services transverses
import { resolveRetryDecision } from "../services/retry-resolver";
import { resolveThrottleDecision, type ThrottleSnapshotService } from "../services/throttle";
import { estimateCallTokens } from "../services/token-estimator";
import { sanitizeContent, detectHeuristicTruncation } from "../services/sanitizer";
import { composeSignal, abortableSleep } from "../services/signal-composer";
import { isRetriableKind } from "../services/error-kind";
import { nowWallIso, nowMono } from "../services/clock";
import { generateCallId } from "../services/callId-generator";
```

Pas d'import `fetch` (natif, global). Pas d'import binding spécifique (binding reçu en paramètre).

---

## 8. Integration snippets

### 8.1 Consommation par la factory

```ts
// Dans src/factories/anthropic.ts
export function createAnthropicAdapter(config: AdapterConfig): ProviderAdapter {
  const throttleSnapshot = createThrottleSnapshotService();  // instance par adapter
  const logger = resolveLogger(config.logging);
  const stats: AdapterStats = { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalDurationMs: 0 };
  return {
    provider: anthropicBinding.provider,
    call: (request) => executeCall(request, anthropicBinding, config, throttleSnapshot, logger, stats),
    stats,
  };
}
```

### 8.2 Test d'acceptance (référence NIB-T §15.1)

```ts
// tests/engine/execute-call-happy-path.test.ts
import { describe, test, expect, vi } from "vitest";
import { executeCall } from "../../src/engine/execute-call";
import { anthropicBinding } from "../../src/bindings/anthropic";

describe("executeCall — Anthropic happy path", () => {
  test("T-EC-01: returns LLMResponse with attemptCount=1, emits 4 events", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(/* fixture Anthropic 200 */, { status: 200 }));
    global.fetch = fetchMock;
    const logged: LLMEvent[] = [];
    const logger: LLMLogger = { emit: (ev) => logged.push(ev) };
    const throttleSnapshot = createFakeThrottleSnapshot();
    const stats = { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalDurationMs: 0 };

    const response = await executeCall(fixtureRequest, anthropicBinding, fixtureConfig, throttleSnapshot, logger, stats);

    expect(response.attemptCount).toBe(1);
    expect(response.terminationReason).toBe("completed");
    expect(logged.map(e => e.type)).toEqual([
      "llm_call_start", "llm_call_attempt_start", "llm_call_sanitized", "llm_call_end",
    ]);
    expect(stats.totalCalls).toBe(1);
  });
});
```

---

## 9. Definition of Done (DoD)

1. **Signature** : `executeCall(request, binding, config, throttleSnapshot, logger, stats): Promise<LLMResponse>` exportée depuis `src/engine/execute-call.ts`.
2. **28 sous-étapes** : toutes présentes dans l'ordre exact §3.1 à §3.28.
3. **Tests NIB-T** : §15 (happy path), §16 (retry), §17 (throttle), §18 (abort/timeout), §19 (integrity) tous passent. §22 (observabilité) passe.
4. **Helpers internes** : les 4 helpers §4 implémentés, non exportés.
5. **Imports** : conformes à la liste close §7.7.
6. **LOC** : 250-350 (incluant helpers internes).
7. **Invariants** :
   - Séquence d'events vérifiée par test (I-7 NIB-S).
   - Enrichissement systématique `callId/provider/model/attempts` sur tout throw (I-ER-01).
   - Pas d'altération de `request` (I-LR-01).
   - Timer toujours libéré (I-5).
8. **Contract tests** : §22 (observabilité), §23 (temporel), §24 (signaux) passent.

---

## 10. Relation avec les autres NIB-M

- **Consomme** :
  - `NIB-M-BINDINGS-COMPLETION` (`ProviderBinding` concret injecté par la factory)
  - `NIB-M-ERRORS` (toutes les classes d'erreur pour throws enrichis)
  - `NIB-M-ERROR-KIND` (`isRetriableKind`)
  - `NIB-M-INFRA-UTILS` (`clock`, `callId-generator`, `logger`)
  - `NIB-M-RETRY-RESOLVER` (`resolveRetryDecision`)
  - `NIB-M-THROTTLE` (`resolveThrottleDecision`, service snapshot)
  - `NIB-M-TOKEN-ESTIMATOR` (`estimateCallTokens`)
  - `NIB-M-SANITIZER` (`sanitizeContent`, `detectHeuristicTruncation`)
  - `NIB-M-SIGNAL-COMPOSER` (`composeSignal`, `abortableSleep`)
- **Est consommé par** :
  - `NIB-M-FACTORIES` (4 factories completion : `createAnthropicAdapter`, `createOpenAIAdapter`, `createOpenAICompatibleAdapter`, `createGoogleAdapter`)

---

## 11. Metadata

| Champ | Valeur |
|---|---|
| Source NX | §14.1 (flux, 28 sous-étapes), §5.3, §10, §11, §13 |
| NIB-T associé | §15, §16, §17, §18, §19, §22, §23, §24 |
| Invariants NIB-S couverts | I-2, I-3, I-4, I-5, I-6, I-7, I-ER-01, I-LR-01 |
| Fichier produit | `src/engine/execute-call.ts` |
| LOC cible | 250-350 |
| Non exporté publiquement | oui (appelé depuis factories uniquement) |

---

## 12. Historique

| Version | Date | Changements |
|---|---|---|
| 1.0.0 | 2026-04 | Création initiale. 28 sous-étapes normatives, helpers internes (enrichAndThrow, buildProviderErrorSignalFromFetchError, inferNetworkErrorKind, extractRawSignal). Séquence d'events mécaniquement testée. Séparation décision/exécution/preuve respectée. |

---

*VegaCorp — Implicit-Free Execution (IFE) — "La fiabilité précède l'intelligence."*
