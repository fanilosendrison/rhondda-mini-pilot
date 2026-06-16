# Backlog

Items auto-fixables par `/backlog-crush` ou `/backlog-deep-crush`. Les items exigeant un arbitrage humain sont dans `design-queue.md`.

Historique 2026-04-17→18 :
- `/backlog-deep-crush` session deepcrush-001 : 53 items resolus sur 101.
- Split des 2 meta-items spec-drift ("19 derives" + "44 drifts types") en 16 items atomiques avec `drift_id` stable (regle "1 finding = 1 ligne", cf. `~/.claude/skills/fix-or-backlog/SKILL.md`).
- `migrate-blocked` : 46 items legacy `(blocked: ..., skipped 2x+)` deplaces vers `design-queue.md`.

Il ne reste ici que les 16 items atomiques spec-drift, frais et traitables par `backlog-fix` au prochain cycle.

---

## Notable (16)

### Types / spec-drift atomiques

Items atomiques derives de `spec-drift.json` (17 drifts detectes, 16 `drift_id` uniques). Chaque ligne = 1 drift atomique, dedupable par `drift_id`.

- [x] [notable] spec-drift[EmbeddingBinding] — src/bindings/types.ts <-> specs/NIB-M-BINDING-EMBEDDING.md:40 — Property 'provider' is missing in type 'EmbeddingBinding' (date: 2026-04-18, drift_id: 88ed555f52e1e1c4)
- [x] [notable] spec-drift[ProviderBinding] — src/bindings/types.ts <-> specs/NIB-M-BINDINGS-COMPLETION.md:43 — Signature divergence: parseResponse (body: unknown) vs spec (httpBody: string); readRateLimitHeaders extra nowMono/nowWall args (date: 2026-04-18, drift_id: ec040b59dd7facad)
- [x] [notable] spec-drift[BindingConfig] — src/bindings/types.ts <-> specs/NIB-M-BINDINGS-COMPLETION.md:43 — providerOptions Record<string,unknown> vs spec unknown (date: 2026-04-18, drift_id: a3362656fe8f2b83)
- [x] [notable] spec-drift[RetryDecision] — src/services/retry-resolver.ts <-> specs/NIB-M-RETRY-RESOLVER.md:50 — Code uses discriminated union { retry: true | false } vs spec flat { retry: boolean } (date: 2026-04-18, drift_id: c7643cc052128dbe)
- [x] [notable] spec-drift[ThrottleDecision] — src/services/throttle-resolver.ts <-> specs/NIB-M-THROTTLE.md:49 — Code uses discriminated union { throttle: true | false } vs spec flat { throttle: boolean } (date: 2026-04-18, drift_id: c1fc0d7134eb6586)
- [x] [notable] spec-drift[LLMMessage] — src/types.ts <-> specs/NIB-S-LLMRUNTIME.md:257 — LLMRequest/LLMMessage readonly arrays in code vs mutable in spec §5.1 (I-11 override: code intentionally stricter) (date: 2026-04-18, drift_id: f19c96e426719584)
- [x] [notable] spec-drift[EmbeddingAdapter] — src/types.ts <-> specs/NIB-S-LLMRUNTIME.md:257 — embed(texts, signal?) vs spec embed(texts, options?: { signal? }) — options-bag signature (date: 2026-04-18, drift_id: b0b490e056f06b6c)
- [x] [notable] spec-drift[AdapterConfig] — src/types.ts <-> specs/NIB-S-LLMRUNTIME.md:257 — retry/timeout/sanitization/integrity/logging optional in code vs required in spec; providerOptions Record<string,unknown> vs unknown (date: 2026-04-18, drift_id: ec3eedc925ad56a0)
- [x] [notable] spec-drift[IntegrityPolicy] — src/types.ts <-> specs/NIB-S-LLMRUNTIME.md:388 — failOn* fields optional in code vs required in spec §5.2 (date: 2026-04-18, drift_id: 1c6072973c3de2a9)
- [x] [notable] spec-drift[LoggingPolicy] — src/types.ts <-> specs/NIB-S-LLMRUNTIME.md:388 — enabled field optional in code vs required in spec §5.2 (date: 2026-04-18, drift_id: 54c17c108e2d9c2c)
- [x] [notable] spec-drift[CanonicalHttpRequest] — src/bindings/types.ts <-> specs/NIB-S-LLMRUNTIME.md:454 — bodyKind 'json' in code vs 'json' | 'empty' in spec §6.1; bodyJson required vs optional (date: 2026-04-18, drift_id: 275d838a7c3d9d87)
- [x] [notable] spec-drift[BindingConfig] — src/bindings/types.ts <-> specs/NIB-S-LLMRUNTIME.md:514 — providerOptions Record<string,unknown> vs spec §6.4 unknown (date: 2026-04-18, drift_id: c712d9d8b7bc6b07)
- [x] [notable] spec-drift[ProviderBinding] — src/bindings/types.ts <-> specs/NIB-S-LLMRUNTIME.md:529 — parseResponse(body: unknown) vs spec §6.5 parseResponse(httpBody: string); readRateLimitHeaders extra args (date: 2026-04-18, drift_id: 8f20a0551878582d)
- [x] [notable] spec-drift[EmbeddingBinding] — src/bindings/types.ts <-> specs/NIB-S-LLMRUNTIME.md:549 — Property 'provider' missing; buildRequest readonly string[] vs spec §6.6 mutable (date: 2026-04-18, drift_id: 4c8f0a7bd3f44089)
- [x] [notable] spec-drift[RetryDecision] — src/services/retry-resolver.ts <-> specs/NIB-S-LLMRUNTIME.md:564 — Discriminated union vs spec §6.7 flat (date: 2026-04-18, drift_id: df5f65a323416b5b)
- [x] [notable] spec-drift[ThrottleDecision] — src/services/throttle-resolver.ts <-> specs/NIB-S-LLMRUNTIME.md:564 — Discriminated union vs spec §6.7 flat (date: 2026-04-18, drift_id: f59f9759b6087605)

### Senior-review findings (pre-existing, non-blocking)

- [x] [notable] executeEmbedding emits llm_embedding_batch event with durationMs:0 before the fetch, not after — src/engine/execute-embedding.ts:159 (date: 2026-04-18, finding_id: 2dbaec96dd48f0e9)
- [x] [minor] executeEmbedding allocates new AbortController per retry sleep instead of reusing NEVER_ABORTING_SIGNAL — src/engine/execute-embedding.ts:139 (date: 2026-04-18, finding_id: 9b79114f3e0b4ae3)
- [x] [minor] googleBinding parseResponse recreates FILTER_REASONS Set on every call — src/bindings/google.ts:99 (date: 2026-04-18, finding_id: 5934ec8cd729260d)
- [x] [minor] executeCall computes durationMs twice with separate clock.nowMono() calls producing slightly different values — src/engine/execute-call.ts:571 (date: 2026-04-18, finding_id: b0d0a6725d2e32b6)
- [x] [minor] executeCall invokes binding.buildRequest twice: once to extract the URL for the start event and once in the loop — src/engine/execute-call.ts:131 (date: 2026-04-18, finding_id: 26d1b3054bb02d8f)

### Dedup-codebase findings (pre-existing, non-blocking)

- [x] [minor] validateAdapterConfig and validateEmbeddingAdapterConfig duplicate retry and timeout validation logic — src/factories/validate-config.ts:12 (date: 2026-04-18, finding_id: 7bb2e5e0f7de57ad)
- [x] [minor] JSON body parsing guard pattern duplicated across anthropic.ts, google.ts, openai-common.ts, openai-embeddings.ts — src/bindings/anthropic.ts:73 (date: 2026-04-18, finding_id: e2a5b9b2a7d8c12f)
- [ ] [notable] AdapterConfig construction duplicated ~69 times across 11 test files — extract shared baseAdapterConfig helper to tests/helpers/base-adapter-config.ts (date: 2026-04-18, finding_id: e8a1d4f2b7c03965)


