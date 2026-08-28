# Failover Provider and Generated Models — Development Plan (Draft)

> **Superseded:** This is a historical provider-migration plan, not the current implementation contract. Current behavior is documented in [README.md](README.md) and [DESIGN.md](DESIGN.md): v8 `getAgentDir()/model-failover.json` contains only generated model `id`/`name`/`enabled` and ordered chains; v1-v7 migration is shared-first and byte-preserving on failure; shared target settings and coordination use `~/.pi/agent/failover-state.json`; `models.json` is read-only.

**Status:** Historical draft retained for design history. The implemented v8 architecture supersedes this plan; no source implementation should be started from the instructions below.

Chinese review copy: [`PLAN.zh-CN.md`](PLAN.zh-CN.md)

## 1. Objective

Transform the current global failover controller into a real Pi model provider named `failover`:

- Pi and other extensions select a generated model normally, using the regular model registry.
- Each generated model has a custom stable ID/name and its own ordered real-model fallback chain.
- The existing bounded retry, cooldown, error classification, cache negotiation, parameter toggles, and reasoning controls move inside the selected generated model's provider execution.
- The extension never changes Pi's current model and never injects hidden continuation messages to perform failover.
- Generated models are persisted in the `failover` provider section of `models.json` so native Pi features and other extensions can discover/select them.
- Pi's built-in thinking setting is treated as display/selection input only; the provider ignores it and uses extension-owned reasoning configuration.

## 2. Confirmed review decisions

These decisions are now part of the plan:

1. **`models.json` ownership:** automatically maintain `providers.failover`; do not require manual export for normal use.
2. **Stream fallback:** buffer each failed attempt until a target succeeds; do not leak failed partial text/tool calls into Pi.
3. **Policy scope:** each generated model owns one policy for its whole chain, with optional per-target reasoning/toggle overrides.
4. **Generated metadata:** expose safe minimum capabilities across the chain, not optimistic or user-declared defaults.
5. **v5 migration:** automatically create `failover/default`, named `Default Failover`, preserving the existing chain order and settings.
6. **Disabled models:** omit disabled generated models from `providers.failover.models`; a session already using one receives a clear error on its next request.
7. **Identity:** use a stable user-chosen ID plus an independently editable display name. ID changes require an explicit migration operation because Pi's footer and stored references primarily use the ID.
8. **Cost scope:** exact failed-attempt cost aggregation is deferred until after provider routing is stable. Phase one keeps catalog cost metadata at zero and preserves the successful target's usage where Pi's stream contract allows it.
9. **Configuration authority:** `model-failover.json` is the sole business source of truth. `models.json/providers.failover` is a generated catalog mirror; manual edits inside that managed block are replaced by conflict-safe reconciliation.
10. **Legacy pause:** v5 `enabled` migrates to the default generated model's enabled state; v5 `paused` is discarded because it belonged to direct Pi model replacement. Restore only clears cooldown/manual-recovery state.
11. **Temporary target unavailability:** valid enabled models remain in `models.json`, but Pi availability filters hide a generated model when none of its configured targets are authenticated. It reappears after auth refresh. Empty or structurally invalid chains remain configuration errors.
12. **Target scope:** real targets are limited to Pi built-ins and `models.json` providers. Providers registered only dynamically by other extensions are not eligible chain targets.

## 3. Current baseline

The current main branch is a v5 global controller:

- `src/config.ts` / `src/types.ts`: one ordered `models` chain, global policy, per-real-model request toggles, and per-real-model reasoning overrides.
- `src/index.ts`: lifecycle failover state machine; it currently calls `pi.setModel()` and uses `pi.sendMessage()` for continuations.
- `src/catalog.ts`: uses model reference helpers independent of the extension-owned `ModelRuntime`; it does not register a provider or own `models.json`.
- `src/tui.ts`: edits the one global chain and its policy.
- Provider request hooks inject OpenAI-compatible parameters and currently synchronize Pi native thinking with `pi.setThinkingLevel()`.

The existing behavior and v5 config must remain the migration source, not be silently discarded.

### 3.1 Existing functionality coverage audit

The following is the strict inventory of the current extension. Every row must be either preserved, deliberately adapted to the provider seam, explicitly removed because the new architecture replaces it, or recorded as a later feature. No row may disappear by omission.

| Existing contract | Current evidence | New-plan disposition |
| --- | --- | --- |
| Secret-free extension config; strict v1→v5 migration; defaults and numeric ranges (`cooldownMinutes`, `maxRetries`, `noProgressTimeoutSeconds`) | `src/config.ts`; `test/config.test.ts` defaults, migrations, malformed values | **Adapt:** generated-model schema v6 migration preserves values and rejects malformed shapes fail-closed. |
| Atomic config persistence: exclusive lock, source-revision CAS, temporary-file flush, atomic rename, owned-lock cleanup, stale-lock preservation, concurrent first-run conflict | `saveConfig()`; `test/config.test.ts` lock/CAS/concurrency cases | **Preserve:** apply the same discipline to `model-failover.json`; add an explicit two-file reconciliation/recovery rule for `models.json`. |
| Blocked config states (malformed, invalid, unreadable, future version) preserve bytes and disable behavior until explicit reload | `loadConfig()`, `refreshCatalog()`, `blockAfterPersistenceFailure()`; `test/config.test.ts`, `test/extension.test.ts` | **Preserve/adapt:** provider registration and catalog sync fail closed without changing Pi's selected model. |
| First-run authorization copies only the current authenticated model; later discovery cannot rewrite configured order | `discoverModels()`, `seedModelList()`; `test/catalog.test.ts`, `test/extension.test.ts` | **Adapt:** v5 becomes `failover/default`; target picker uses approved static built-in/`models.json` scope, while generated catalog is managed separately. |
| Refresh at session startup and `/failover` open; distinguish successful empty snapshots from refresh/snapshot failures | `refreshCatalog()`, `discoverModels()`; `test/catalog.test.ts`, `test/extension.test.ts` | **Preserve:** refresh private target runtime and generated availability without deleting valid business config. |
| Prompt-cache optimization: namespaced SHA-256 of Pi Session ID as `prompt_cache_key`; never transmit plaintext session ID | `promptCacheKey()`; `test/request-params.test.ts` | **Preserve inside provider:** apply per real target before delegation, with target/API-scoped capability state. |
| 24-hour `prompt_cache_retention` request, best effort | `applyOpenAIRequestParameters()`; request/runtime tests and README/DESIGN | **Preserve inside provider:** only for supported OpenAI-compatible APIs and only when the target toggle is on. |
| Session-affinity hashing: replace `session_id`, `x-session-id`, `x-client-request-id`, `x-session-affinity` in place while retaining header spelling/case | `replaceOpenAISessionHeaders()`; `test/request-params.test.ts` | **Preserve inside provider:** do not add, delete, or rewrite unrelated headers; leave non-OpenAI and missing-session paths unchanged. |
| Structured cache-field negotiation: HTTP 400/422, nested JSON, accepted validation types/codes, `param`/`field`, legacy no-param known-token form, malformed JSON tolerance | `extractJsonRecords()`, `nestedRecords()`, `rejectedCacheFields()`; `test/settings-runtime.test.ts` | **Preserve/adapt:** negotiate per generated-model/real-target/API; remember only the named field; auth 401/403 wins; repeated rejection follows normal policy. |
| Cache negotiation removes rejected fields from reused payloads, preserves the other cache field/reasoning/custom data, and does not consume normal `maxRetries` | `retryWithoutRejectedCacheFields()`; `test/settings-runtime.test.ts` | **Preserve/fix:** provider attempt snapshots must rebuild payloads without the rejected field; disabled toggles must not enter negotiation (the current implementation needs this explicit guard). |
| Four strict passive parameter toggles: cache key, cache retention, reasoning effort, session affinity; absent entry means all-on; disabled fields leave Pi-owned values untouched | `modelParameterToggles()`, `readModelParameters()`; `test/parameter-toggles.test.ts`, `test/tui.test.ts` | **Preserve/adapt:** move to generated-model policy plus target overrides and retain all-four strict validation. |
| Reasoning global fallback, per-real-model override/inherit, model `thinkingLevelMap`, `null` means leave provider reasoning untouched, `off` maps to provider `none` where supported | `resolveReasoningEffort()`, `reasoningEffortForModel()`; request/settings/TUI tests | **Preserve/adapt:** resolve generated-model policy + target override; ignore Pi native reasoning input; never call `pi.setThinkingLevel()`. |
| Pi native retry runs first; extension retry count is separate; `smart`/`switch`/`retry` behavior and permanent-vs-transient classification | `classifyFailure()`, `shouldRetryCurrentModel()`, `handleSettled()`; `test/state.test.ts`, `test/settings-runtime.test.ts`, DESIGN state table | **Adapt:** `ModelRuntime.completeSimple()` owns native target retries; provider router owns only the configured extra policy and must not double-count. |
| Error classes: balance/quota/usage, 401/403/404 persistent/manual recovery; 429/network/5xx cooldown; unknown/no-progress automatic; cancellation/tool failure terminal | `src/state.ts`; state/runtime/extension tests | **Preserve/adapt:** unify status parsing for both `HTTP error (NNN)` and bare `NNN:` forms; preserve precedence and reasons. |
| Per-request attempted set, no revisit loop, exhaustion summary, transition source/target/reason | `RequestState`, `nextUnattemptedModel()`, `requestSummary()`; state/runtime/TUI tests | **Preserve/adapt:** isolate by generated model and request; never let cooldown expiry revisit a target within the same request. |
| Cooldown timestamps are runtime-only; expired targets re-enter at the next request; manual recovery reasons persist across restart until Restore; model removal clears all associated runtime/config state | `cooldowns`, `manualRecovery`, `restoreFailover()`, removal actions; cooldown/settings tests | **Preserve/adapt:** state key becomes generated ID + real target; Restore clears only recovery state and never selects a Pi model. |
| No-progress timer defaults to 90s, accepts 15–900/0; arms only active non-native-retry attempts; resets on response/message/turn/tool progress; aborts only when still active and Pi is not idle | `startProgressTimer()`, `noteProgress()`, `canArmProgressTimer()`; state/runtime tests | **Adapt:** implement equivalent target-stream timeout/progress semantics behind provider buffering, excluding Pi-native retry and user abort. |
| Hidden continuation/context filtering removes the failed assistant message before retry; duplicate settlement is guarded | `sendContinuation()`, `context` hook, `settling`; runtime/extension tests | **Explicitly replace:** buffered provider attempts eliminate hidden continuation and context deletion; successful tool-call results are forwarded, but tool failures/user cancellation never trigger fallback. |
| Child/full-resource sessions may not emit `session_start`; uninitialized provider hooks must not overwrite native child reasoning/header values | `configAccess` readiness guard; `test/settings-runtime.test.ts` and prior child regression | **Preserve as stronger invariant:** provider registration/config snapshot must work without session lifecycle hooks. |
| TUI custom panel, serial action queue, 20-row viewport, add/remove/reorder, settings ranges, per-model reasoning/toggles, empty/stale-model guards | `src/tui.ts`; `test/tui.test.ts`, settings runtime tests | **Adapt:** generated-model/name/ID/chain editor retains responsiveness, safe navigation, validation, and no nested Pi modal behavior. |
| Status footer, notifications, latest transition, cooldown/manual-recovery display, exhaustion chain summary | `updateStatus()`, `notify()`, `viewFor()`, TUI render; runtime/TUI tests | **Adapt:** report generated model and target without changing Pi's current model; support headless/provider error diagnostics. |
| Pi owns authentication; extension never stores keys/tokens; only authenticated models are selectable | catalog/config tests and README/DESIGN | **Preserve/adapt:** private target runtime resolves Pi auth; generated provider exposes availability only when a static target is authenticated and never logs credentials. |
| Global install/package entry, Pi 0.84.x compatibility, reload/new/resume/shutdown cleanup | `package.json`, extension registration, lifecycle handlers, README | **Preserve/adapt:** register provider during async factory, support `--list-models`, native `/model`, child sessions, reload, and clean shutdown. |
| Known current gaps: `src/state.ts` has narrower status parsing than `src/index.ts`; cache negotiation does not yet explicitly gate disabled fields; no-eligible-model behavior needs a defined error | pre-commit audit and source inspection | **Fix during Phase A/C:** unify status parsing, enforce passive negotiation, and return explicit no-target provider errors. |

This matrix is the compatibility checklist for implementation and review. The new provider is not complete merely because ordinary target failover works; all preserved rows require focused regression coverage.

The cache optimization was under-specified in the first draft. It is now a named, mandatory migration module in section 4.5, with its privacy, passive-toggle, negotiation, target-isolation, and retry-budget contracts stated explicitly.

## 4. Proposed target architecture

### 4.1 Provider seam

Register a native/custom provider with provider ID `failover` and a custom stream implementation. Generated entries use `provider: "failover"` and stable generated IDs.

Because the same `models.json` will contain the managed `failover` provider after migration, the private target runtime must use a target-only view that excludes `providers.failover` before provider composition; it must not recurse or fail composition merely because the generated catalog exists. Phase A must prove this without writing a second user-visible catalog or importing dynamic extension providers.

The provider adapter is the deep module with a small interface:

```text
streamSimple(generatedModel, PiContext, PiRequestOptions) -> AssistantMessageEventStream
```

Its implementation owns target resolution, request preparation, bounded attempts, failure classification, cooldown/manual-recovery state, and final stream/message metadata. It delegates each attempt through the private Pi `ModelRuntime.completeSimple()` path; it does not reimplement OpenAI, Anthropic, Google, target-provider auth, or other provider protocols.

The adapter must use the public request seams exposed by `ModelsSimpleStreamOptions`: `onPayload` for payload mutation, `transformHeaders` for post-auth header mutation, and `onResponse` for the authoritative HTTP status used by failure/cache classification. It must pass the active abort signal through every delegated attempt.

`src/index.ts` becomes orchestration/registration/configuration code. It must not call `pi.setModel()` or use `pi.sendMessage()` as a failover mechanism.

### 4.2 Generated-model configuration

Replace the single global chain with a versioned collection of generated models. Proposed shape:

```ts
interface GeneratedFailoverModel {
  id: string;                 // stable machine ID under provider failover
  name: string;               // custom label shown by Pi
  enabled: boolean;
  chain: RealModelRef[];      // ordered provider/id targets
  reasoningEffort: ReasoningEffort;
  cooldownMinutes: number;
  errorHandlingMode: ErrorHandlingMode;
  maxRetries: number;
  noProgressTimeoutSeconds: number;
  modelParameters: ModelParameterToggles;
  targetOverrides: Record<string, {
    reasoningEffort?: ReasoningEffort;
    modelParameters?: ModelParameterToggles;
  }>;
}
```

The field names may still change during implementation, but the approved structure is: one generated-model policy, one real fallback chain, plus optional per-target overrides for settings that truly differ by target. The important invariant is that every generated model owns its policy and chain; cooldowns, manual recovery, unsupported cache fields, retry counters, and exhaustion state are isolated by generated-model ID and real target.

The former global `paused` state is removed. Each generated model has its own `enabled` flag. A provider-level fatal configuration error blocks routing without changing Pi's selected model.

### 4.3 `models.json` ownership and reconciliation

`model-failover.json` is the sole source of business configuration. Confirmed policy: the extension automatically maintains only `providers.failover` in `models.json`. It preserves every unrelated provider and field semantically; JSON formatting may be normalized by the atomic rewrite, but unrelated values and credentials must not change.

Reconciliation must:

1. Read and validate the existing file without logging credentials.
2. Replace only the extension-owned generated-model definitions.
3. Use an exclusive lock, source-revision check, atomic temporary-file write, and rename, reusing the existing persistence discipline.
4. Preserve external edits and report a conflict instead of overwriting them.
5. Keep generated IDs stable when only a display name or chain changes.
6. Treat manual edits inside the managed `providers.failover` block as catalog drift and replace them from `model-failover.json`; never reverse-import them.
7. Refresh the private target runtime and re-register the generated provider after a successful config/catalog update.

The provider registration remains the runtime execution seam. The `models.json` block is the durable discovery/catalog seam. A short implementation spike must verify the exact Pi merge order, auth availability behavior, and minimal valid `failover` provider metadata before coding the router.

### 4.4 Provider metadata

Each generated model exposes conservative safe-minimum metadata for Pi's model picker and context checks:

- `name`: user-defined display name.
- `input`: intersection of chain capabilities by default.
- `contextWindow`: safe minimum across targets.
- `maxTokens`: safe minimum across targets.
- `cost`: zero-valued catalog metadata in phase one. Exact aggregation across failed attempts is an explicitly deferred follow-up; successful target usage is preserved when available.
- `reasoning` and `thinkingLevelMap`: advertise only levels the approved policy can guarantee across the chain.
- custom provider/API metadata sufficient for Pi to register the virtual model; the real target API is selected internally per attempt.

Metadata must never claim image/tool/reasoning support that a fallback target cannot actually provide.

### 4.5 Legacy request and cache optimization

The cache/request adapter must apply `onPayload` and `transformHeaders` per target attempt, and use `onResponse` status together with the final assistant error message. It must not rely on the outer extension's `before_provider_request` or `before_provider_headers` hooks, because the selected Pi model is now the virtual `failover` model.

1. For `openai-responses`, `openai-completions`, and `azure-openai-responses`, derive `prompt_cache_key` as SHA-256 of `pi-model-failover/prompt-cache-key/v1:` plus the Pi Session ID. Never send the plaintext Session ID.
2. Request `prompt_cache_retention: "24h"` only when the generated-model/target toggle is enabled; preserve an existing Pi-owned value when disabled.
3. Replace, in place and with original spelling/case, `session_id`, `x-session-id`, `x-client-request-id`, and `x-session-affinity` with the same digest when session affinity is enabled and a session ID exists. Non-OpenAI APIs, missing sessions, and unrelated headers remain untouched.
4. Resolve the four strict passive toggles independently: `promptCacheKey`, `promptCacheRetention`, `reasoningEffort`, and `sessionAffinity`. An absent target entry means all-on; a disabled field is neither injected nor rewritten.
5. When a target rejects a cache field, inspect HTTP 400/422 structured validation records, nested `errors` shapes, accepted validation types/codes, `param`/`field`, and the legacy no-parameter known-token form. Do not match arbitrary human-language phrases.
6. Remember unsupported fields by generated model, real target, and API. On the next attempt, remove only the remembered field—even when the payload was reused or already contains it—while preserving the other cache field, reasoning, custom payload data, and headers.
7. Do not negotiate a disabled field, a value-validation error, an unrelated validation error, or an authentication error; 401/403 takes precedence. A compatibility retry does not consume the generated model's normal retry allowance. A repeated rejection of an already omitted field follows the ordinary error policy.
8. Keep each target's capability memory independent. A rejection on target A or one API must not disable the field for target B or another API.

The current `src/index.ts` implementation has one known gap: negotiation must explicitly consult passive toggles before recording a rejection. The new adapter must fix this while preserving the documented behavior. The status parser must also accept every error shape used by the current code, including bare `NNN:` forms.

### 4.6 Thinking-level isolation

The provider must ignore `PiRequestOptions.reasoning`, `ctx.thinkingLevel`, `settings.json`, and built-in thinking-level changes when deciding the real request's reasoning strength.

The extension-owned reasoning value is resolved from the selected generated model, then from any approved target override, and finally from the migrated default. It is mapped through each real target's `thinkingLevelMap` and passed to the delegated provider stream. The implementation removes the current `pi.setThinkingLevel()` synchronization path and does not use `thinking_level_select` to mutate extension policy.

Pi may still display or clamp a native thinking level for the virtual model. That display must not affect the provider request; tests must prove that changing Pi's native setting leaves the actual target request at the extension-selected level.

### 4.7 Attempt and stream semantics

For each request against a generated model:

1. Snapshot the generated model configuration and create a fresh attempted-target set.
2. Select the first eligible real target in configured order.
3. Apply the existing request-parameter toggles and reasoning mapping for that target.
4. Execute the delegated target through `ModelRuntime.completeSimple()` and buffer its complete result.
5. Classify a failed terminal result using the existing smart/switch/retry policy.
6. Retry the same target or move to the next eligible target within the same provider call, bounded by the generated model's policy.
7. Return one final Pi-compatible assistant stream/message with a clear generated-model identity and target diagnostics in non-context metadata.

Approved stream policy: the provider buffers a target attempt until it has a successful terminal result. Failed attempts are discarded from user-visible output before moving to the next target. This avoids duplicated text, duplicated tool calls, and broken partial assistant messages.

Abort signals must cancel the active target and stop the chain immediately.

### 4.8 Availability and update lifecycle

- `models.json` keeps every structurally valid, enabled generated model as durable catalog metadata.
- The native provider's availability filter exposes a generated model only when its chain currently contains at least one authenticated static target.
- Pi/provider refresh also refreshes the private target runtime, so restored authentication makes the model available again without editing the chain.
- Every provider call snapshots one generated-model configuration. TUI changes do not mutate or cancel an in-flight request; they apply to the next request.
- Empty chains, unknown targets during reconciliation, stale target references, and failed catalog writes produce explicit `/failover` diagnostics instead of silent fallback.
- The former global `paused` state and manual model-selection pause behavior are removed. Per-generated-model `enabled` controls catalog participation; Restore clears only runtime recovery state.

## 5. UI and user workflow

Rework `/failover` into generated-model management:

1. List generated models with custom name, ID, enabled state, and chain summary.
2. Add/rename/delete/reorder generated models.
3. Edit one generated model's real fallback chain using authenticated Pi models, excluding `failover/*` to prevent recursion.
4. Edit that generated model's cooldown, error mode, retry count, no-progress timeout, reasoning level, and request-parameter toggles.
5. Show target cooldown/manual-recovery status and last attempt/exhaustion reason without selecting or replacing Pi's current model.
6. Reconcile `models.json` after every successful persisted model change.

Pi's native `/model`, footer, child-agent selection, CLI `--model`, and other extensions must see the generated entries through the normal registry. `/failover` edits configuration; it does not perform model selection as a side effect.

## 6. Migration

Introduce a new config version after the user approves the shape.

- Migrate the existing v5 ordered chain into `failover/default`, named `Default Failover`, preserving its order and all current policy values.
- Migrate v5 `enabled` to `failover/default.enabled`; discard v5 `paused` because direct model switching no longer exists.
- Preserve global/per-real-model reasoning and parameter-toggle behavior by translating them into the generated model's policy/target overrides.
- Generate the stable default ID `default` and name `Default Failover` only for v5 migration; later user-created models require an explicit stable ID and display name.
- Do not delete or rewrite unrelated `models.json` providers during migration.
- If migration or `models.json` reconciliation is blocked, leave source files byte-for-byte intact and disable only the new provider routing, with an actionable error in `/failover`.

## 7. Implementation phases after approval

### Phase A — contract spike

- Confirm native-provider registration, `models.json` merge order, dummy/extension-owned failover-provider auth, private `ModelRuntime` target delegation, availability filtering, and child-session behavior with a minimal isolated test/provider.
- Decide generated-model metadata and stream identity semantics.

### Phase B — schema and persistence

- Add the approved generated-model config and migration.
- Add `models.json` read/merge/write reconciliation with conflict safety.
- Add stable ID validation, editable display names, explicit ID migration, disabled-model catalog filtering, strict validation, and stale-entry cleanup.

### Phase C — provider router

- Extract reusable request/cache/reasoning mapping and failure-classification helpers, including the full cache optimization contract in section 4.5.
- Add a provider-attempt adapter using `onPayload`, `transformHeaders`, and `onResponse` rather than outer-model lifecycle hooks.
- Implement per-generated-model attempt state and target routing behind the provider stream seam.
- Remove direct `setModel`/continuation failover paths.
- Add abort, partial-stream, tool-call, cooldown, authentication, cache-negotiation, and exhaustion handling.
- Preserve Pi-native retry ordering and keep provider-level retry counts separate from the delegated target runtime's native retries.

### Phase D — TUI and registry integration

- Replace the global-chain editor with generated-model and chain editors populated only from authenticated built-in and `models.json` targets.
- Register generated entries early enough for `/model`, CLI, child sessions, and other extensions.
- Ensure reload/new/resume and config conflicts remain safe.

### Phase E — migration, docs, and verification

- Update README/DESIGN and migration notes.
- Run focused tests, full tests, TypeScript, diff checks, diagnostics, Pi `--list-models`, native `/model`, child-agent selection, and a real provider smoke test.
- Review the final diff and verify no path directly changes Pi's current model.

## 8. Acceptance criteria

- A user can create two generated models with different stable IDs, display names, and real fallback chains.
- Both generated models appear as `failover/<id>` in `models.json`, Pi `/model`, CLI model listing, and `ctx.modelRegistry` for another extension when at least one configured static target is authenticated.
- Selecting a generated model through native Pi remains selected for the whole session; failover never calls `pi.setModel()` or sends hidden continuation messages.
- A failure in target A routes to the configured target B using the generated model's own retry/cooldown/error policy, without affecting another generated model's state.
- Disabled cache/reasoning/session parameters remain passive for the selected target; existing Pi-owned payload/header values are untouched.
- Prompt-cache key hashing, 24-hour retention, affinity-header replacement, structured field negotiation, per-target capability memory, and retry-budget exclusion all retain the contracts in section 4.5.
- Pi native thinking/settings changes do not change the actual reasoning value sent by the extension.
- Child sessions and provider calls use the generated model's extension-owned reasoning policy.
- Partial output and tool-call buffering, user abort, auth errors, cooldown recovery, cache negotiation, config conflicts, and empty/invalid chains have explicit tested behavior.
- Providers registered only dynamically by other extensions are intentionally excluded from real fallback chains and the `/failover` target picker.
- Existing v5 configuration migrates into `failover/default` without losing chain order or per-target settings; obsolete `paused` is not carried forward.
- Disabled generated models are omitted from the managed catalog; an already-open session using one receives a clear provider error on its next request.
- All unrelated `models.json` providers and credentials remain intact.
- Exact aggregation of failed-attempt usage/cost is not an initial acceptance criterion; it remains a documented follow-up after provider routing is proven.

## 9. Future live Web UI (planned)

The user also wants a settings command to generate a URL pointing to a live Web UI for extension configuration. This is a planned follow-up phase, not an excuse to duplicate business logic or expose credentials. The recommended delivery order is provider core first, then Web UI after the shared configuration seam is stable.

### 9.1 Web UI invariants

- A settings action (proposed `/failover web` or a `Web UI` action inside `/failover`) starts or reuses a session-scoped settings server and displays a URL.
- The page manages the same generated models, stable IDs/names, real fallback chains, policy values, target overrides, cache/reasoning toggles, and recovery/status data as the TUI.
- HTTP handlers call the same deep configuration/domain module as the TUI. They must not implement a second persistence, migration, validation, models.json reconciliation, or failover-policy path.
- Changes use the existing lock/CAS/atomic-write and `models.json` reconciliation rules. Concurrent terminal/Web edits produce an explicit conflict and never silently overwrite newer data.
- The page is live: updates made in the page, TUI, Pi refresh, or provider runtime are reflected without a full page reload through a bounded polling or server-push transport chosen during the contract spike.
- The layout is mobile-first and touch-optimized: narrow-screen responsive layout, readable controls, large tap targets, no terminal-width assumptions, safe-area-aware spacing, keyboard accessibility, and usable portrait scrolling. Desktop is supported but is not the primary constraint.
- The Web UI never displays or returns API keys, OAuth tokens, raw auth headers, session plaintext IDs, or arbitrary provider error payloads that may contain secrets.
- The URL is protected by a high-entropy expiring token. The server has an explicit bind policy, rejects unauthenticated requests, limits origin exposure, and stops on session shutdown/explicit close/expiry. It must not silently expose a Pi/PRoot listener to the LAN.
- The Web UI edits configuration only. It never calls `pi.setModel()` and never changes Pi's current model as a side effect.

### 9.2 Web UI implementation phase

Phase F, after provider routing and the shared configuration seam:

1. Contract spike for URL reachability, bind address, token validation, lifecycle, and live-update transport.
2. Extract/finish a shared settings/domain module used by TUI and HTTP.
3. Add a minimal Node-standard-library HTTP server and static mobile-first HTML/CSS/JS unless a dependency is justified by the contract spike.
4. Add responsive settings screens, generated-model chain editing, validation/error views, conflict recovery, and live status.
5. Test phone-width rendering/interaction, touch-equivalent controls, token expiry, LAN exposure, concurrent edits, shutdown, reload, and secret redaction.

The following Web UI decisions are confirmed:

1. **Reachability:** bind localhost by default; LAN binding is not part of the first Web UI delivery. Same-device phone/browser access is the supported path; users who need another device provide their own secure tunnel.
2. **URL delivery:** show the URL in the terminal and copy it when a system clipboard capability is available. Do not add a QR dependency in the first delivery.
3. **Live transport:** use bounded polling, approximately once per second, with pause/stop behavior when the page is hidden, closed, expired, or the server shuts down.
4. **Delivery scope:** implement Phase F as a separate follow-up after provider core acceptance, reusing the stable shared configuration seam.

Open details such as exact token TTL, command spelling, clipboard bridge, and page route are implementation-level contract-spike decisions; they must retain the security invariants above.

## 10. Plan approval

All product decisions required for implementation are now recorded. Review this document and either request corrections or explicitly approve development.

## 11. Approval gate

No source implementation begins until the user explicitly approves the core provider plan and the separate Phase F Web UI direction. Approved wording such as `按这个计划开始开发` is enough; implementation should begin with Phase A, not Phase F.
