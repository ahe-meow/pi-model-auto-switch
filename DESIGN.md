# Pi Model Failover Extension Design

Status: implemented for Pi `0.84.x`; the extension, TUI, v8 persistence, shared coordination, tests, and user documentation are present. The current architecture is documented here and in the README; the historical provider migration plan is superseded.

## Goals

- Provide a global-first Pi extension with a TUI entry point at `/failover`.
- Keep generated v8 configuration limited to model identity, enabled state, and ordered real-target chains.
- Share global real-target enablement and automatic failover coordination across the parent, child/subagent, and independent same-user processes, while keeping request policy in chain scopes with inheritable target overrides.
- Let users select, reorder, add, and remove authenticated models without changing Pi's global catalog or copying credentials.
- Let Pi's recognized provider retries settle before applying extension policy.
- Route provider failures with bounded exact-target retries and expose transitions through the Footer and current-session history.

## Non-goals

- Replacing or configuring Pi's provider retry count, backoff, or retry implementation.
- Editing `models.json` or copying API keys and tokens into extension storage.
- Compatibility filtering or provider capability inference when building the model list.
- Classifying Pi-owned tool execution failures from request history.
- Updating Pi's own thinking setting; reasoning control is applied only at the real-provider request boundary.
- Running a test request as part of direct restore.
- Retrying indefinitely or ignoring a target's shared eligibility and cooldown.

## Data Model

### Extension configuration

The extension-owned global configuration is stored at:

```text
getAgentDir()/model-failover.json
```

The first-run file is empty and contains no automatically selected current model:

```json
{
  "version": 8,
  "models": []
}
```

A user-created generated model contains exactly `id`, `name`, `enabled`, and `chain`; each chain entry contains only `provider` and `id`.

- `version` is the generated failover schema version `8`. v1-v7 inputs migrate shared-first; a failed migration preserves the source bytes and leaves automation blocked.
- `enabled` controls whether a user-created generated chain is active.
- `models` is the authoritative ordered failover configuration. First run writes an empty array; discovery never inserts the current model.
- Target settings and coordination are not stored in this file. Pi's `models.json` remains read-only to this extension.

### Shared target state and chain scopes

Global target state and chain scopes are stored at:

```text
~/.pi/agent/failover-state.json
```

This is a fixed user-global path and does not follow `PI_CODING_AGENT_DIR`. The parent, child/subagent, and independent same-user processes use the same state. It contains no credentials, messages, or Session IDs.

For each exact real `provider/model` target, the global record is authoritative for:

- `enabled`;
- next eligibility (`nextEligibleAt`), cooldown rung, and cumulative cooldown;
- consecutive automatic failures and persistent manual recovery. Legacy persisted runtime `lease` fields are compatibility input only and are removed on the next write; they do not represent current coordination.

Each generated model also has a chain scope keyed by `encodeURIComponent(absolute agent directory):generated model id`. The scope contains chain policy for error behavior, `maxRetries`, no-progress timeout, reasoning effort, and model-parameter toggles, plus one target override for each chain member. Chain reasoning can be an explicit level or `inherit`; when the selected target override is also `inherit`, each request keeps the current Pi session's outer reasoning value, while an explicit target override takes precedence. On first registration, scope policy is initialized from the first real target's policy. Every target override is created with all fields set to `inherit`. A target attempt reads the target's global `enabled` value and resolves effective policy by merging scope settings with the selected target override; an explicit override replaces `inherit`.

Before a target request, an active `nextEligibleAt` deadline causes an immediate skip to the next chain target. Multiple Pi sessions and adapters may concurrently use the same real target. CAS and file locks coordinate cross-process writes to shared state; they do not reserve a target. Success or reset clears consecutive-failure and cooldown state. Persistent failure manual recovery is global for the exact real target. Policy edits are scope-local; global enablement, reset, and runtime coordination are target-global.

Local request progress, UI state, and compatibility memory remain process-local. Transition history is local to the selected Pi session and persists as namespaced custom entries, newest first and bounded to 100; shared target eligibility and recovery remain user-global.

### Catalog inputs and ordering

Each Pi session gets its own extension-owned `ModelRuntime`, and runtime behavior does not depend on `session_start`. Stable provider callbacks capture transitions before provider registration without attempting session persistence. On `session_start`, the extension reloads and applies the authoritative v8 chain configuration, replaces in-memory history with validated custom entries from the selected session, then enables custom-entry persistence only when that session has a file and installs the current UI/Footer context. A malformed, missing, future-version, or registration-degraded reload clears provider routing and leaves the editor blocked until recovery. The runtime reads `models.json` and authentication state but never writes `models.json`.

At non-history `/failover` open, the extension reloads and applies the authoritative v8 chain configuration before refreshing its owned `ModelRuntime` and observing its model snapshot. `/failover history` is read-only and does not reload configuration. `getAvailableSnapshot()` supplies authenticated candidates for Add; refresh and snapshot failures are reported separately from a successful empty result. An already-open editor is not live-watched; close and reopen it, or trigger `session_start`, after an external config revision.

First setup leaves the authorized list empty. The user creates a generated model and explicitly adds authenticated real targets. After that, the persisted list and its order are authoritative: discovery cannot add, remove, reorder, or rewrite authorization. Newly authenticated models remain available to add explicitly. The extension applies no image/context/capability inference.

### OpenAI-compatible request boundary

Pi adapters build their native payload and await async `onPayload`; failover awaits the outer callback and then applies its cache digest. Responses, Chat Completions, and Azure Responses use their API-specific reasoning fields and headers. OpenRouter is detected by provider or base URL.

For these APIs, the extension uses `reasoning.effort` for Responses (`off` maps to `none`) and `reasoning_effort` for Chat Completions. Explicit reasoning values are mapped only for the selected real-provider request; `inherit` leaves Pi's outer reasoning unchanged and is shown as `inherited` in the Footer/history. Neither path updates Pi's own thinking setting. It derives `prompt_cache_key` as SHA-256 of `pi-model-failover/prompt-cache-key/v1:` plus the Pi Session ID, represented as 64 lower-case hexadecimal characters. It never transmits a raw Session ID through failover headers.

The outer virtual request's `apiKey`, `env`, `headers`, and header transform are intentionally dropped before delegation. The selected target's extension-owned `ModelRuntime` supplies target authentication and native headers, preventing virtual-provider credentials from overriding real-target credentials.

`prompt_cache_retention: "24h"` is requested only when explicit long retention/native support and target compatibility allow it. An explicit `cacheRetention:none` removes both cache key and retention and adds no affinity. If the outer `pi-cache-optimizer` strips the fields, that stripping wins. Recognized session-affinity headers are replaced in place with the same digest while preserving header spelling.

The four target toggles are independent and passive: prompt-cache key, prompt-cache retention, reasoning effort, and session headers. A disabled toggle leaves Pi and outer-hook values unchanged. Structured HTTP 400/422 cache-field negotiation is local to the exact target and API; it removes only the rejected field, preserves unrelated data, and is free and bounded separately from the normal retry budget. Non-OpenAI APIs are unchanged.

## Event and Retry State Machine

Pi remains the owner of provider-native retries. The extension observes the request lifecycle and owns only per-request target attempts plus shared failure accounting.

```text
READY
  -> REQUEST_TARGET

REQUEST_TARGET
  -> REQUESTING              target is globally enabled and eligible
  -> SKIP_AND_ADVANCE        disabled, manual recovery, cooldown, or retry delay
  -> BLOCKED                 shared coordination cannot safely read or write

REQUESTING
  -> PI_RETRYING             Pi-owned, when Pi recognizes a provider retry
  -> SETTLING

SETTLING
  -> SUCCEEDED
  -> CANCELLED               outer request is aborted; stop routing
  -> CLASSIFY_FAILURE        provider/delegate failure or extension timeout

CLASSIFY_FAILURE
  -> COMPATIBILITY_RETRY     bounded cache-field negotiation; normal budget unchanged
  -> MANUAL_RECOVERY_ADVANCE persistent/auth/unavailable target
  -> RETRY_TARGET             retry-eligible automatic failure
  -> TERMINAL_FAILURE        non-automatic provider result

RETRY_TARGET
  -> REQUESTING              same-target budget remains
  -> COOLDOWN_AND_ADVANCE    target budget exhausted

SKIP_AND_ADVANCE / MANUAL_RECOVERY_ADVANCE / COOLDOWN_AND_ADVANCE
  -> REQUEST_TARGET
  -> EXHAUSTED               no configured target remains
```

Operational rules:

1. An enabled generated chain consults global target enablement, `nextEligibleAt`, manual recovery, cooldown, and retry delay before each target attempt.
2. Each request resolves the effective chain-scope policy merged with the selected target override. Multiple Pi sessions and adapters may attempt the same real target concurrently; shared CAS/file-lock writes coordinate their persisted state without reserving a target.
3. Pi handles any provider retry it recognizes before the extension classifies the settled result.
4. `maxRetries=N` means exactly N same-target retries after the initial attempt. Backoff is 1s, 2s, 4s, then doubles up to 60s.
5. Every retry-eligible automatic failure uses that effective target budget. There is no separate one-attempt allowance for unknown errors or no-progress timeouts.
6. Exhausting one target's budget updates only that exact real target and advances through the configured chain. Other targets retain independent failure, cooldown, and eligibility state.
7. User cancellation terminates the current request and stops routing; it does not change shared target state. Pi-owned tool execution happens outside this provider state machine.
8. If no eligible target remains, the request ends in `EXHAUSTED`. If every target genuinely fails, each may independently enter cooldown during the traversal.

The no-progress timeout is a policy field in the chain scope and target override. Disabling the timeout does not disable classification of provider errors.

## Error Classification

| Condition | Pi handling before extension policy | Shared target action | Same-target action | Chain action |
| --- | --- | --- | --- | --- |
| Structured HTTP `400`/`422` rejecting an injected cache field | Adapter returns the settled validation error | Remember only the rejected field for the exact target/API | Bounded compatibility retry; normal budget unchanged | Stay on the target while negotiation remains valid |
| Balance, quota, usage, HTTP `401`/`403`/`404`, or target unavailable | Any Pi handling has settled | Set persistent manual recovery | None | Advance to the next eligible target |
| HTTP `429`, network failure, or HTTP `5xx` | Pi performs recognized retries first | Count the automatic failure; arm cooldown only after the effective budget is exhausted | Retry exactly up to `maxRetries` unless mode is `switch` | Advance after target cooldown settlement |
| Unknown provider/delegate failure | Pi performs any recognized retries first | Same exact-target failure accounting | Use the effective scoped budget | Advance after target cooldown settlement |
| No-progress timeout | Extension aborts the bounded target attempt | Same exact-target failure accounting | Use the effective scoped budget | Advance after target cooldown settlement |
| User cancellation | Outer abort wins | No shared target-state mutation or failure update | None | Stop immediately |
| Historical `toolResult` with `isError` | Remains ordinary request context | No inferred failure or settlement | None | Continue the provider request normally |
| Pi tool execution failure | Happens after provider output, outside this router | Not classified by the extension | Not applicable | Not applicable |

A persistent classification describes the failed exact target and its required manual recovery; it does not consume the retry budget or advance the cooldown ladder. Retry-eligible failures use the request-time effective scope/override settings. A historical tool result is never converted into a synthetic terminal response. Delegate throws, transport errors, request timeouts, and shared-settlement failures remain provider-path failures. Error text is bounded and sanitized before it reaches terminal output, callbacks, Footer/history, or persisted shared state.

## TUI Behavior

`/failover` opens the global failover configuration and status view. Every non-history open reloads and applies the authoritative v8 chain configuration, then refreshes catalog data. `/failover history` is read-only and bypasses configuration refresh. Runtime failover does not depend on `session_start`; that hook performs the same authoritative v8 config refresh before restoring the selected session's bounded transition history, activating its UI/Footer context, and enabling custom-entry persistence for persisted sessions. An already-open editor is not live-watched and must be closed/reopened or followed by a session refresh after an external config change.

The TUI shows:

- the current model and enabled chain state;
- the ordered model chains;
- shared coordination health;
- `nextEligibleAt`, consecutive failures, retry, cooldown, manual-recovery, and cumulative-cooldown state; and
- the latest source, target, reason, and effective reasoning value.

The main chain list and each detail target chain keep a 20-row viewport with a visible range. The add-target candidate viewport reads Pi's `autocompleteMaxVisible` and displays that many real-model rows; the surrounding instructions do not count against the model-row limit. Once candidates are open, direct text input filters case-insensitively by `provider/model`; Backspace deletes search text, Up/Down scrolls, Enter adds, and Esc clears the search before closing. No-match results show a prompt and cannot be added. All rendered rows remain clipped to the available width.

The TUI allows the user to select, reorder, add, and remove chain targets. From chain detail, `Enter` opens target override settings for the selected target; `t` opens separate `Chain Settings: generated-model-id`; `p` is inert. Target override fields are error behavior, max retries, no-progress timeout, reasoning effort, and four independent model-parameter toggles, each of which can be `inherit`. In chain detail, `e` toggles global enablement for the selected real target; in the main list, `e` toggles generated-chain enablement. TUI write actions execute serially so rapid keypresses operate on the latest ordered list. Chain changes auto-save to `getAgentDir()/model-failover.json`; scope and override changes auto-save to the fixed shared state file.

The empty `/failover` branch is now a catalog-backed Model Manager runtime. It reads `MODELS_JSON_PATH` and the adjacent `model-manager.json` sidecar with `readModelCatalog`, keeps the real snapshot and blocked state in `TuiState`, and selects the existing `renderManagerScreen`, `renderFailoverScreen`, or `renderHistoryScreen` from the fixed tab order. `1`/`2`/`3` and Tab dispatch tab actions; `r` and `v` collect Raw/Environment submissions and dispatch parser actions; `c` dispatches cancel; `d` performs read-only impact analysis; `y`/`n` dispatch cascade confirmation; and delete completion dispatches the existing transaction-result action. Delete analysis uses a generation guard so cancellation or selection changes cannot resurrect stale pending state or commit from a stale `y`; Environment parsing receives only an explicitly injected read-only source. The loop is intentionally a release-sized shell: Raw/Environment submissions report reducer results but do not yet create records, and create/edit/clone forms remain outside this release. The existing `history` subcommand and non-empty Failover editor remain separate.

Deletion is the one write path wired from this screen. `commitDeleteDraft` re-reads the current sidecar, requires an exact record/impact/ack match, applies `{ remove: [recordId] }`, serializes the sidecar, and uses the existing catalog transaction for revision-checked commit. It notifies the registered Model Manager bridge only after the sidecar commit succeeds. If notification fails after that commit, the UI re-reads the catalog and shows a fixed warning instead of a prepare failure. The bridge is already serialized through Failover's `chainOperation`; Model Manager never writes `model-failover.json`, `failover-state.json`, or generated provider content.

Reset and recovery actions operate on shared target state. Direct restore does not run a test request.

## Persistence and Security

- Read `models.json` through the extension-owned `ModelRuntime`; never write Pi's catalog directly.
- Keep v8 `model-failover.json` limited to generated model identity, enabled state, and ordered chains. Malformed, semantically invalid, unreadable, and future-version files are preserved; blocked configuration disables automation until the user repairs it and explicitly reopens `/failover`.
- Migrate v1-v7 inputs shared-first. A failed registration, shared-state write, source revision check, or generated-config write preserves the legacy source bytes and blocks routing and editing.
- Serialize authorized config writes with an adjacent exclusive filesystem lock, re-read and compare the retained source revision under that lock, flush a same-directory temporary file, then atomically rename it. A revision mismatch conflicts without touching newer bytes.
- Never delete an existing lock automatically; timeout fails closed with manual recovery guidance. `releaseOwnedLock` removes only this invocation's owned filesystem lock; temporary-file cleanup removes only successfully created files.
- Store global real-target enablement and runtime coordination plus chain scopes and target overrides at the fixed `~/.pi/agent/failover-state.json` path, regardless of `PI_CODING_AGENT_DIR`.
- Treat malformed, unreadable, locked, write-failed, or compare-and-swap-exhausted shared state as unavailable. Target attempts and all mutations return a coordination failure; provider routing and TUI writes remain blocked until a verified read/write check restores shared status.
- Treat scope registration and target references as configuration relationships only; removing a registration only changes configuration relationships and does not alter other target runtime records.
- Keep credentials, messages, and raw Session IDs out of shared and generated state. Target authentication comes from the selected target runtime, not outer virtual request credentials.
- Keep cache negotiation capability memory local to the exact target and API. Redact credential material, strip C0/C1 terminal controls from provider text, and reject malformed/control-bearing session-history entries.

## Known Pi Limitations

Pi controls the retry count and backoff inside its real-provider adapters. The extension observes only the settled provider outcome and then applies its separate scoped budget.

Routing stays inside one virtual provider request and reuses the request context supplied by Pi; no message-injection API is involved. Tool execution occurs after a successful provider result and is therefore not visible to this provider classifier. Historical tool results remain context, not control signals.

Explicit reasoning effort is mapped into supported real-provider request fields; chain-level `inherit` keeps Pi's current session reasoning value and is reported as `inherited` by the Footer/history. The extension does not alter Pi's own thinking setting.

Transition history is bounded to 100 entries for the selected session. Persisted sessions restore validated namespaced custom entries; ephemeral sessions keep history only in memory. Live provider/network behavior and visual terminal interaction still require verification in a Pi session.

## Implementation Phases

1. **Global integration and discovery**: register the global extension and `/failover`; install stable provider callbacks before provider registration; own one target `ModelRuntime` per extension instance; initialize an empty v8 chain file.
2. **Configuration and TUI**: classify config loads, preserve blocked files, serialize revision-checked atomic writes, and implement chain CRUD, chain-scope policy, inheritable target overrides, shared runtime status, and recovery actions.
3. **Lifecycle and request compatibility**: route without depending on `session_start`, isolate outer virtual credentials, await the outer payload callback, apply final request parameters, and negotiate rejected extension-injected cache fields.
4. **Shared failover execution**: enforce effective scope/override policy, exact-target retry budgets, shared eligibility and manual recovery, cooldowns, bounded traversal, Footer/history transitions, and exhaustion summaries.
5. **Verification**: cover empty first run, v1-v7 migration, fail-closed coordination, auth isolation, request-field negotiation, session hashing/history, TUI action serialization, failure classes, concurrent exact-target traversal, and legacy runtime-field compatibility.

## Acceptance Checklist

- [x] The extension is designed for global installation and exposes `/failover`.
- [x] First run writes an empty v8 configuration and leaves `models.json` unchanged.
- [x] A v8 generated model contains only identity, enablement, and its ordered real-target chain.
- [x] v1-v7 migration registers shared targets/scopes before writing v8; any failed step preserves source bytes and blocks routing/editing.
- [x] Parent, child/subagent, and independent same-user processes share exact-target runtime coordination; policy remains chain-scoped.
- [x] Scope keys combine the encoded absolute agent directory with generated model id; scope policy starts from the first target and every override field starts as `inherit`.
- [x] Each request snapshots effective scope/override settings; cancellation stops the current request without changing shared target state.
- [x] Malformed, unreadable, locked, write-failed, and compare-and-swap-exhausted shared state blocks target attempts and mutations until verified recovery.
- [x] The TUI opens target overrides with `Enter`, chain settings with `t`, leaves `p` inert, and uses detail `e` for global target enablement.
- [x] Rapid reorder, enable, and override actions execute serially against the latest state.
- [x] The Footer and `/failover history` expose transitions; the implementation emits no per-transition popup.
- [x] Current-session history uses validated namespaced custom entries, local timestamps, deduplication, and a 100-entry bound.
- [x] Outer virtual credentials and header transforms are dropped; the selected target runtime supplies authentication.
- [x] Reasoning effort is applied only to supported real-provider request fields and does not alter Pi's own thinking setting.
- [x] Prompt-cache keys use a namespaced SHA-256 digest; raw Session IDs are neither sent nor persisted by failover.
- [x] Cache-field negotiation is structured, exact-target/API-local, bounded, and excluded from `maxRetries`.
- [x] `maxRetries` is the exact same-target retry count after the initial attempt; all retry-eligible automatic failures use the effective target budget.
- [x] Retry and cooldown state is isolated by exact real target; one target's exhaustion does not consume another target's budget.
- [x] Global target enablement, cooldown, failures, `nextEligibleAt`, cumulative cooldown, and manual recovery remain outside chain-scope policy; legacy `lease` input is stripped on write.
- [x] Historical error tool results remain request context and do not synthesize a provider failure; Pi tool execution stays outside provider classification.
- [x] Credential material is redacted, provider text is bounded, C0/C1 controls are removed, and unsafe history entries are rejected.
- [x] The historical Failover v8 baseline recorded in the earlier report was 209/209; that number is not a current full-suite result. The current Model Manager release acceptance is the explicit ten-file suite, with its latest result recorded in the development report.
- [x] `node ./node_modules/typescript/lib/tsc.js --noEmit --pretty false` passed. An isolated live `failover/orc-peon` smoke passed through real Pi/provider authentication with exit code 0, exact marker `REAL_FAILOVER_SMOKE_OK`, empty stderr, and no 401, 403, or model-unavailable result; it did not force a first-target failure or verify an automatic switch.

Verification commands:

```bash
node --loader ./test/typescript-loader.mjs --test test/*.test.ts
node ./node_modules/typescript/lib/tsc.js --noEmit --pretty false
git diff --check
```

## Model Manager Layers

The Model Manager path is split into small ownership boundaries:

- `model-manager-types`: sidecar/catalog types, multiplier validation, stable IDs, aliases, cloning, and grouping as pure helpers.
- `model-manager-input`: in-memory Raw and Environment key parsing with whole-batch rejection.
- `model-manager-sidecar`: sidecar bytes, validation, canonical serialization, revisions, and blocked states.
- `model-manager-catalog`: read-only Pi provider adaptation and the sanitized catalog snapshot.
- `model-manager-store`: normalized revisions, fixed dictionary-order file locks, CAS checks, atomic writes, and rollback.
- `model-manager-impact`: read-only chain/generated-block/state reference analysis and cascade confirmation.
- `model-manager-operations`: create/edit/clone drafts, secret-free previews, transaction submission, and the confirmed sidecar-only delete coordinator.
- `model-manager-tui`: the three-screen renderers and pure reducer; it does not perform I/O.
- `model-manager-bridge`: explicit Failover chain registration, virtual-model gating, and the delete notification seam.

A catalog transaction has three stages. `prepare` acquires normalized target locks in dictionary order, validates ownership and duplicate paths, rereads revisions, checks CAS, and caches original bytes. `commit` writes the prepared catalog files through atomic replacement. On failure, `rollback` restores earlier bytes or removes newly created files; a rollback failure is reported separately and is never hidden as an ordinary validation error. Locks release in reverse order in every exit path.

A CAS mismatch is a prepare conflict. It reports the affected path revisions and performs zero writes, so an external update is never overwritten. Preview and cancel also perform zero writes.

Failover remains the owner of `model-failover.json`, `failover-state.json`, and generated `providers.failover` content. Model Manager owns its sidecar and native catalog transaction but does not write Failover files directly. After read-only impact analysis and `confirmCascade`, deletion notification goes through `registerModelManagerBridge`/`notifyModelManagerDelete`; the Failover runtime forwards it through its existing serialized `chainOperation` queue to the optional delete coordinator callback.
