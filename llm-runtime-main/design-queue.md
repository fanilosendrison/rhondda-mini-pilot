# Design queue

Items qui necessitent un arbitrage humain avant d'etre traduits en fix atomique. Ces items ne sont **pas** traites par `/backlog-crush` ou `/backlog-deep-crush`. Voir `~/.claude/skills/fix-or-backlog/SKILL.md` pour la convention de format et la logique d'escalade auto.

- [ ] [escalated] tests/engine/*.test.ts — Aucun vi.doMock src/infra/clock.js; defaultClock hors mockClockRegistry. Fix : ajouter vi.doMock clock.js en tete de chaque fichier engine test (6 fichiers). (date: 2026-04-17, source: /senior-review iter-1)
  - origin_severity: major
  - origin_id: 999458b7925c51e7
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/engine/execute-call.ts (700 lignes) — OVERSIZED > 400. Fix : split en execute-call-main + validators + fetch + response-builders + helpers (~150 lignes each). (date: 2026-04-17, source: /dedup-codebase iter-1)
  - origin_severity: major
  - origin_id: 9db3d8c38fb48ca4
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] tests/engine/execute-call-retry.test.ts T-EC-60 — Ne verifie pas snapshot updated vs invalidated. Fix : add follow-up call et assert llm_call_throttled present avec snapshotState known. (date: 2026-04-17, source: /senior-review iter-0)
  - origin_severity: notable
  - origin_id: 40ed872c1314f74a
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] tests/contracts/observability.test.ts C-OB-27 — Ne verifie pas content.length===0 quand rawContentPreview present. Fix : capture response from adapter.call et assert res.content.length === 0 en parallele. (date: 2026-04-17, source: /senior-review iter-0)
  - origin_severity: notable
  - origin_id: 70e2a9894f3b2644
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] tests/global-contract.test.ts C-GL-25 — Pattern fragile push+reassign eventTypes. Fix : refactor en async helper runScenario retournant types+error. (date: 2026-04-17, source: /senior-review iter-0)
  - origin_severity: notable
  - origin_id: e48a5d75bcf6723f
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] tests/fixtures/events-schemas — 14 schemas JSON orphelins, aucun consumer. Fix : delete schemas OR add ajv-based validation test. (date: 2026-04-17, source: /senior-review + /dedup-codebase iter-0)
  - origin_severity: notable
  - origin_id: ac36f6b3c92560e8
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] tests/fixtures/provider-responses — 18 error fixtures orphelins; tests use scenario helpers avec synthetic bodies. Fix : wire fixtures into per-binding parseResponse-error tests OR remove. (date: 2026-04-17, source: /senior-review + /dedup-codebase iter-0)
  - origin_severity: notable
  - origin_id: 6930609c44785dc9
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] tests/fixtures/rate-limit-headers — 4/6 orphelins (groq, together, mistral-no-reset, retry-after-variants). Fix : drive parse-retry-after.test.ts from retry-after-variants.json via it.each(). (date: 2026-04-17, source: /senior-review + /dedup-codebase iter-0)
  - origin_severity: notable
  - origin_id: b6f5a19f04ed34cb
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/engine/execute-embedding.ts:180-321 — Event names divergent de NIB-M DoD #7 (llm_call_* au lieu de llm_embedding_*). Fix : aligner NIB-M a llm_call_ (match NIB-T) ou renommer emissions. (date: 2026-04-17, source: /senior-review iter-1)
  - origin_severity: notable
  - origin_id: 65521142f22c3115
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/engine/execute-embedding.ts — Throttle path entierement absent (spec 3.5.6/7 + DoD #4). Fix : wire throttle-snapshot via ExecuteEmbeddingContext ou amend spec si hors scope v1. (date: 2026-04-17, source: /senior-review iter-1)
  - origin_severity: notable
  - origin_id: 42ad3ecf80b49cc4
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/bindings/types.ts — parseResponse param body:unknown au lieu de spec httpBody:string; engine pre-parse JSON. Fix : signature `(httpBody:string, headers) => ...` + JSON.parse inside bindings. (date: 2026-04-17, source: /senior-review iter-1)
  - origin_severity: notable
  - origin_id: 906bb08a919b7ed7
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/bindings/anthropic.ts:141-167 — classifyError omet extraction error.message depuis body envelope. Fix : helper tryExtractAnthropicErrorMessage. Idem openai.ts / google.ts. (date: 2026-04-17, source: /senior-review iter-1)
  - origin_severity: notable
  - origin_id: b239844f5a0369a1
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/bindings/google.ts:161-182 — classifyError omet extraction error.message depuis {error:{code,message,status}}. Fix : helper tryExtractGoogleErrorMessage. (date: 2026-04-17, source: /senior-review iter-1)
  - origin_severity: notable
  - origin_id: 83d0ccfc374b0351
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/errors/index.ts:37-172 — kind est prototype getter au lieu de own readonly field; change Object.keys et JSON serialization. Fix : revert a `public override readonly kind = '...' as const`. (date: 2026-04-17, source: /senior-review iter-1)
  - origin_severity: notable
  - origin_id: 4603f3088682eb2c
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/errors/index.ts — Constructor utilise init-bag avec message? et default 'LLMRuntimeError' literal diverge de spec `constructor(message, options?)`. Fix : aligner ou remove fake default. (date: 2026-04-17, source: /senior-review iter-1)
  - origin_severity: notable
  - origin_id: 3757195797efcf91
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/factories/openai-embeddings.ts:25-28 — totalInputTokens jamais incremente contradict NIB-M-FACTORIES 3.5 symetrie. Fix : stats.totalInputTokens += delta.inputTokens. (date: 2026-04-17, source: /senior-review iter-1)
  - origin_severity: notable
  - origin_id: 0c19de39782815cb
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] tests/properties/properties.test.ts P-14 vs C-OB-18 — ULID ordering <= vs strict < inconsistant. Fix : aligner apres spec clarification sur ULID monotonic factory. (date: 2026-04-17, source: /senior-review iter-1)
  - origin_severity: notable
  - origin_id: b29cb80d54188926
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/engine/execute-call.ts:304-350 — retry sleep et throttle sleep dupliquent abortableSleep try-catch (seul message differe). Fix : handleAbortableSleep(delayMs, signal, messageContext). (date: 2026-04-17, source: /dedup-codebase iter-1)
  - origin_severity: notable
  - origin_id: 15e5c4ec406fba37
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/engine/execute-call.ts:378-447 vs execute-embedding.ts:232-276 — Fetch-error handling duplique. Fix : extract fetch-error-handler avec logger callback. (date: 2026-04-17, source: /dedup-codebase iter-1)
  - origin_severity: notable
  - origin_id: f5fb15cc4e3ae83b
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/bindings/{anthropic,google,openai,openai-embeddings}.ts — JSON.parse body validation duplique 4x (12 lignes identiques). Fix : extract ensureJsonObject(body, providerLabel). (date: 2026-04-17, source: /dedup-codebase iter-1)
  - origin_severity: notable
  - origin_id: b681c3bcd22ea48a
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/bindings/{anthropic,google}.ts — System/chat message extraction loop duplique. Fix : extract extractSystemAndChatMessages(messages). (date: 2026-04-17, source: /dedup-codebase iter-1)
  - origin_severity: notable
  - origin_id: a1cdf5cfe4a5d5ce
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] tests/bindings/openai-compatible.test.ts T-OC-12..15 — Provider quirks 4 tests byte-identical modulo provider literal. Fix : collapse en it.each + distinct-reference assertions. (date: 2026-04-17, source: /senior-review iter-1)
  - origin_severity: notable
  - origin_id: c521cfd86bf2faf6
  - skipped_count: 3
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/factories/openai-compatible.ts — providerOptions in AdapterConfig comme Record<string,unknown> au lieu de spec unknown. Fix : aligner avec spec ou documenter. (date: 2026-04-17, source: /senior-review iter-1)
  - origin_severity: notable
  - origin_id: 5074b114cb35f7c4
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/engine/execute-embedding.ts:138-352 — totalBatches inconsistent sur success (batches.length) vs failure (batchIndex). Fix : batchIndex+1 ou split en failedBatchIndex. (date: 2026-04-17, source: /senior-review iter-1)
  - origin_severity: notable
  - origin_id: ad75a1045e06d0d4
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/bindings/{anthropic,openai,google}.ts — Usage object constructed as empty LLMUsage then mutated via unsafe cast `(usage as { inputTokens?: number }).inputTokens = input`, violating readonly interface. Fix : build usage object with all fields at construction time using spread. (date: 2026-04-17, source: /senior-review iter-2/loop-clean)
  - origin_severity: notable
  - origin_id: fa3b42f0eba4c252
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/engine/execute-call.ts:69-97 — enrichError uses `err.constructor as new (init)` cast to reconstruct errors; fragile if constructor signature changes. Fix : add abstract clone-with-context to LLMRuntimeError or document init-bag contract. (date: 2026-04-17, source: /senior-review iter-2/loop-clean)
  - origin_severity: notable
  - origin_id: 64333cc298a2306b
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/types.ts — EmbeddingAdapterConfig ne extends pas AdapterConfig per NIB-S §5.1. Fix en GREEN : extends + narrowing commente. (date: 2026-04-17, source: /senior-review iter-0)
  - origin_severity: minor
  - origin_id: c5854b687c39b027
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/types.ts — AdapterConfig optional fields vs NIB-S required. Fix en GREEN : garder optional avec comment documenting factory default application. (date: 2026-04-17, source: /senior-review iter-0)
  - origin_severity: minor
  - origin_id: 255bf0e37022bd11
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] tests/helpers/mock-fetch.ts — body ?? null serialization undocumented. Fix : add branch for undefined → empty string + JSDoc. (date: 2026-04-17, source: /senior-review iter-0)
  - origin_severity: minor
  - origin_id: b6819f3ca399ea84
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] tests/helpers/mock-fetch.ts — MockFetch.calls mutable peut orpheliner closure. Fix : ReadonlyArray<MockFetchCall>. (date: 2026-04-17, source: /senior-review iter-0)
  - origin_severity: minor
  - origin_id: 67711bdeb007e320
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] tests/services/retry-resolver.test.ts P-RR-b — 525 iterations excede NIB-T §27.8 guideline 20-100. Fix : sample at 100 via seededRandom or rename to matrix test. (date: 2026-04-17, source: /senior-review iter-0)
  - origin_severity: minor
  - origin_id: 5bec23a09e97be2f
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] tests/services/sanitizer.test.ts T-SN-24 — Tautological typeof check. Fix en GREEN : assert concrete value per §7.3 calibration. (date: 2026-04-17, source: /senior-review iter-0)
  - origin_severity: minor
  - origin_id: 973db01b467d6de5
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] tests/engine/execute-call-happy-path.test.ts + 5 autres — Empty beforeEach blocks + beforeEach import unused. Fix : remove empty blocks and imports. (date: 2026-04-17, source: /senior-review + /dedup-codebase iter-0)
  - origin_severity: minor
  - origin_id: 4603e990111b12ef
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] tests/engine/execute-call-happy-path.test.ts line 529 — Redundant vi.unstubAllGlobals dans runOnce. Fix : add comment explaining loop-isolated stubs. (date: 2026-04-17, source: /senior-review iter-0)
  - origin_severity: minor
  - origin_id: cfb4a09b9bb58956
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] tests/engine/execute-embedding.test.ts T-EE-22 — Mock-fetch ne honor pas AbortSignal during delayMs. Fix : extend mock-fetch.produce to abort on init.signal. (date: 2026-04-17, source: /senior-review iter-0)
  - origin_severity: minor
  - origin_id: e4640434be2f1f64
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] tests/fixtures/provider-responses/anthropic/error-529-headers.json — Non-uniform fixture shape {body, headers} vs siblings. Fix : rename to error-529-envelope.json. (date: 2026-04-17, source: /senior-review iter-0)
  - origin_severity: minor
  - origin_id: 93922e604325ebbb
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] tests/properties/properties.test.ts sanity — Test sans P-XX ID keeping imports alive. Fix : remove OR add real P-31 determinism test. (date: 2026-04-17, source: /senior-review iter-0)
  - origin_severity: minor
  - origin_id: ad1dcb90ac534f55
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/bindings/{anthropic,openai,openai-compatible,google,openai-embeddings}.ts — notImplemented const duplicated 5x. Fix en GREEN : extract to src/bindings/_stub.ts. (date: 2026-04-17, source: /dedup-codebase iter-0)
  - origin_severity: minor
  - origin_id: f73abeb77706fdb2
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] 9 test files > 400 lignes (observability 909, execute-call-abort-timeout 857, execute-call-retry 772, properties 705, execute-embedding 636, execute-call-happy-path 567, execute-call-integrity 533, global-contract 451, bindings/anthropic 414). Fix eventuel GREEN : split par subsection NIB-T (non-urgent, match spec section scope). (date: 2026-04-17, source: /dedup-codebase iter-0)
  - origin_severity: minor
  - origin_id: 3cc08cfb8ab00900
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/engine/execute-call.ts:196-209 — binding.buildRequest invoque 2x par call + IIFE swallow throws (spec §6.4 violation). Fix : compute canonical request once, reuse URL. (date: 2026-04-17, source: /senior-review iter-1)
  - origin_severity: minor
  - origin_id: 8f4adb0dd87a575f
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/engine/execute-call.ts:696-699 — retry.maxAttempts===0 throws TransientProviderError au lieu de InvalidRequestError. Fix : precondition top-of-function. (date: 2026-04-17, source: /senior-review iter-1)
  - origin_severity: minor
  - origin_id: a8f133381d422d62
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/engine/execute-embedding.ts:267-273 — provider_protocol re-wrap branch unreachable. Fix : remove lines 267-273. (date: 2026-04-17, source: /senior-review iter-1)
  - origin_severity: minor
  - origin_id: 6280cc1385e1186f
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/engine/execute-embedding.ts:118-136 — Endpoint resolution synthesize [''] input pour buildRequest. Fix : binding.resolveEndpoint(config) ou compute depuis config.endpoint. (date: 2026-04-17, source: /senior-review iter-1)
  - origin_severity: minor
  - origin_id: 36accd1c75959b22
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/engine/execute-embedding.ts:232-276 — Fetch-error branch emits aucun observability event (spec 3.5.11). Fix : emit llm_embedding_fetch_error avant continue. (date: 2026-04-17, source: /senior-review iter-1)
  - origin_severity: minor
  - origin_id: a1ab18d783b743da
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/services/error-classifier-base.ts:65-71 — 503 Retry-After non parse onto TransientProviderError.retryAfterMs. Fix : ajouter branche 500/502/503 avec retryAfterMs. (date: 2026-04-17, source: /senior-review iter-1)
  - origin_severity: minor
  - origin_id: 29dee0e247fd7358
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] src/services/token-estimator.ts:10-24 — UTF8_ENCODER.encode alloue Uint8Array par message. Fix : Buffer.byteLength(str, 'utf8') allocation-free. (date: 2026-04-17, source: /senior-review iter-1)
  - origin_severity: minor
  - origin_id: c2b1bc005d97d5ab
  - skipped_count: 2
  - first_blocked_on: 2026-04-17
  - escalated_on: 2026-04-17
  - why: legacy-blocked item migrated to design-queue via `migrate-blocked`. Was invisible to crush since 2026-04-17.
  - cta: decide — retry (move back to backlog.md without marker), drop (resolve via code + check off), or redefine scope (rewrite + move back).

- [ ] [escalated] execute-call.ts exceeds 600 lines with multiple distinct responsibilities — src/engine/execute-call.ts (date: 2026-04-18, finding_id: 116f2cf1a7db4bcd)
  - origin_severity: notable
  - origin_id: c5e11b72e9729225
  - skipped_count: 2
  - escalated_on: 2026-04-18
  - why: recurrent defensive skip by backlog-fix after 2 cycle(s). Likely cause: scope too large, spec ambiguity, or pending product decision.
  - cta: examine manually. See `.claude/run/backlog-deep-crush/*/` for sub-agent skip reasons.

