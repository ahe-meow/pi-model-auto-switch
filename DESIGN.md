# Pi Model Failover Extension Design

Status: implemented for Pi `0.84.x`; the extension, TUI, persistence, tests, and user documentation are present.

## Goals

- Provide a global-first Pi extension with a TUI entry point at `/failover`.
- Keep automatic failover enabled by default while allowing an explicit user-controlled pause and restore.
- Maintain one explicitly authorized ordered model list; discovery only supplies candidates for the user to add.
- Let users select, reorder, add, and remove authenticated models without changing Pi's global catalog or copying credentials.
- Let Pi's native retry behavior run first for provider failures that Pi recognizes as transient.
- Switch models only after Pi has settled the request, with bounded traversal and clear status notifications.
- Persist only extension-owned settings and model references in the Pi agent directory.

## Non-goals

- Replacing or configuring Pi's native retry count, backoff, or provider retry implementation.
- Editing `getAgentDir()/models.json`, currently `/root/.pi/agent/models.json`, or copying API keys and tokens into extension storage.
- Compatibility filtering or provider capability inference when building the model list.
- Retrying user cancellation (`Esc` or `Ctrl+C`) or tool execution failures.
- Guaranteeing duplicate-free continuation after a provider failure that followed tool calls.
- Running a test request as part of direct restore.
- Retrying indefinitely or revisiting a model during one user request.

## Data Model

### Extension configuration

The extension-owned global configuration is stored at:

```text
getAgentDir()/model-failover.json
```

The persisted shape is intentionally small and contains no credentials:

```json
{
  "version": 7,
  "models": [
    {
      "id": "default",
      "name": "Default Failover",
      "enabled": true,
      "chain": [
        { "provider": "<provider>", "id": "<model-id>" }
      ],
      "reasoningEffort": "medium",
      "errorHandlingMode": "smart",
      "maxRetries": 1,
      "noProgressTimeoutSeconds": 90,
      "modelParameters": {},
      "targetOverrides": {},
      "manualRecovery": {}
    }
  ]
}
```

- `version` is the generated failover schema version `7`; generated v6 and legacy v1-v5 inputs migrate to it.
- `enabled` defaults to `true` for a new configuration.
- `models` is the authoritative ordered failover authorization. A model reference is identified by provider and model id and contains no authentication material.
- `reasoningEffort` is the global fallback for best-effort OpenAI-compatible reasoning parameters and Pi's native thinking level. `modelReasoningEfforts` overrides it per configured `provider/id`; `inherit` removes an override. The selected level is inherited by child sessions and displayed by Pi's footer.
- The cooldown ladder is fixed and always enabled: 10, 20, 40, 60, 90, 180, and 360 minutes. It advances once per user request after a terminal cooldown-class failure and same-target retry exhaustion, and is reset by success, `Reset cooldown`, or `Restore`.
- `noProgressTimeoutSeconds` defaults to `90`. Valid user values are `15` through `900`, or `0` to disable the extension-owned no-progress timeout.
- `paused` records a manual `/model` or Ctrl+P choice until explicit TUI restore.
- `manualRecovery` records non-secret permanent failure reasons for balance/quota/usage, `401`/`403`, and `404`; these statuses survive Pi restarts until restore clears them.

The configuration is extension-owned. Pi's global models catalog remains the source for catalog discovery and is read-only to this extension.

### Runtime state

Runtime state is held for the active process/request and is not persisted as credentials or request history. It includes:

- automation mode: enabled, paused, or disabled;
- the active model and the source/target/reason for the latest transition;
- the current request's attempted model references;
- at most one same-model continuation used by the unknown-error/no-progress path;
- per-target cooldown expiry and the next ladder rung for transient `429`, network, and `5xx` failures; and
- runtime-only cache-field incompatibilities keyed by provider, model, and API; and
- whether the current request is waiting for Pi's native retry handling, settled, switching, or exhausted.

Persistent non-secret recovery state is kept in the extension configuration. Cooldown timers, ladder levels, and request attempts remain process/request state; permanent recovery reasons and the manual pause flag survive restart.

A request's attempted set resets at the start of each user request. Before a new request runs, enabled automation selects the first configured model that is not in manual recovery and whose cooldown has expired; this lets recovered models re-enter rotation without waiting for the current model to fail. A model is not selected again during that request after it has been attempted, even if its cooldown has elapsed. Manual model/cycle selections pause automation, while an explicit Restore selection is honored for the next request.

### Catalog inputs and ordering

At startup and whenever `/failover` opens, the extension observes Pi's model registry. `getAvailable()` supplies authenticated candidates for Add; refresh and snapshot failures are reported separately from a successful empty result.

On first setup, only the current model is copied into the authorized list. After that, the persisted list and its order are authoritative: discovery cannot add, remove, reorder, or rewrite authorization. Newly authenticated models remain available to add explicitly. The extension applies no image/context/capability inference.

### OpenAI-compatible request boundary

For `openai-responses`, `openai-completions`, and `azure-openai-responses`, request preparation injects the API-appropriate reasoning effort, a SHA-256 `prompt_cache_key`, and best-effort 24-hour cache retention. Recognized session-affinity headers, including `x-session-id`, are replaced in place with the same digest; plaintext Pi Session IDs are not transmitted by this extension.

Each configured model can choose its own reasoning level or inherit the global fallback. The settings page's `Model parameters` entry opens a per-model page with a reasoning-level selector followed by four switches: `prompt_cache_key`, `prompt_cache_retention`, `reasoning effort`, and `session headers` (the affinity-header digest). Turning a switch off means the extension does not send that parameter for the model and leaves any Pi-owned payload fields untouched; turning it on restores the default. Settings persist under `modelParameters` and `modelReasoningEfforts`, keyed by `provider/id` in the versioned config (schema v5), defaulting to all-on/inherit for models without entries, and are pruned when the model is removed. Because negotiation only runs for fields the extension actually sent, a disabled parameter is never recorded as provider-rejected.

A structured HTTP 400/422 request-validation JSON error is eligible when its `code`, `type`, and `param` values identify an unknown or unsupported known cache field: `code` is `unknown_field`, `unknown_parameter`, `unsupported_field`, or `unsupported_parameter`; `type` is a request-validation type such as `invalid_request_error`; and `param` is `prompt_cache_key` or `prompt_cache_retention`. The extension records only that field for the active provider/model/API and sends one same-model compatibility continuation without consuming `maxRetries`. It actively deletes remembered rejected fields, including from reused payloads, while preserving the other cache field, reasoning, and unrelated data. A legacy payload with no `param` remains eligible only when its validation `type` and known field token are present; its human-language message is not matched as a fixed phrase. `401`/`403` authentication handling wins, repeated rejection of an already omitted field falls through to normal policy, and other targets probe independently. Non-OpenAI APIs are unchanged.

## Event and Retry State Machine

Pi remains the owner of provider-native retries. The extension observes the request lifecycle and owns only the additional decisions below.

```text
READY
  -> REQUESTING
  -> PI_RETRYING (Pi-owned, when Pi recognizes a transient failure)
  -> SETTLING
  -> SUCCEEDED

SETTLING
  -> CANCELLED              user presses Esc or Ctrl+C
  -> TOOL_FAILED            tool execution failure
  -> CLASSIFY_FAILURE       provider failure or extension timeout

CLASSIFY_FAILURE
  -> CONTINUING_ONCE         unknown provider error or no-progress timeout
  -> COOLDOWN_AND_ADVANCE    429, network, or 5xx after native retries
  -> PERSISTENT_AND_ADVANCE  balance/quota/usage, 401/403, or 404
  -> TERMINAL_FAILURE        no-switch terminal condition

CONTINUING_ONCE
  -> SUCCEEDED
  -> COOLDOWN_AND_ADVANCE   continuation fails and the next model is eligible
  -> EXHAUSTED               no unattempted model remains

COOLDOWN_AND_ADVANCE / PERSISTENT_AND_ADVANCE
  -> SWITCHING
  -> REQUESTING              best-effort continuation on the target model
  -> EXHAUSTED               no unattempted model remains
```

Operational rules:

1. A user request begins on the current model when automation is enabled and not paused.
2. The extension waits for Pi's native retry handling to settle before deciding whether to switch. It does not run a competing native retry loop.
3. A recognized transient failure is therefore first handled by Pi. If it remains a failure, the extension applies the classification table below; a terminal cooldown-class failure arms the current ladder rung and advances the next rung by one.
4. Unknown provider failures and extension-owned no-progress timeouts receive one best-effort continuation on the same model after native retries. A failed continuation advances to the next model.
5. For a switch, the extension records the source model, target model, and reason, then asks Pi to continue on the target through the supported extension path.
6. A model that has been attempted is not revisited in the same request. The request traverses the configured list at most once and cannot create an infinite loop.
7. If no candidate remains, the request ends in `EXHAUSTED` and the TUI reports a failure summary.
8. User cancellation and tool execution failure end the automatic path without switching.

The extension-owned no-progress timer is `90` seconds by default, can be edited to `15` through `900` seconds, and is disabled by `0`. Disabling this timer does not disable classification of provider errors.

## Error Classification

| Condition | Native Pi handling | Extension action after settlement | Same-model retry | Chain action |
| --- | --- | --- | --- | --- |
| Recognized transient provider failure | Pi retries using Pi-controlled count/backoff | Wait for Pi to settle, then classify the final outcome | No extension-native retry loop | Continue according to the final classification |
| Balance, quota, or usage failure | No extension retry | Mark persistent manual recovery | No | Advance once to the next unattempted model when available |
| HTTP `401` or `403` | No extension retry | Mark persistent manual recovery | No | Advance once to the next unattempted model when available |
| HTTP `404` | No extension retry | Mark persistent manual recovery | No | Advance once to the next unattempted model when available |
| HTTP `429` | Pi handles recognized native retries first | Arm the current per-target cooldown rung: 10 -> 20 -> 40 -> 60 -> 90 -> 180 -> 360 minutes, capped at 6 hours | No after native retries | Advance to the next eligible unattempted model |
| Network failure | Pi handles recognized native retries first | Arm the current per-target cooldown rung: 10 -> 20 -> 40 -> 60 -> 90 -> 180 -> 360 minutes, capped at 6 hours | No after native retries | Advance to the next eligible unattempted model |
| HTTP `5xx` | Pi handles recognized native retries first | Arm the current per-target cooldown rung: 10 -> 20 -> 40 -> 60 -> 90 -> 180 -> 360 minutes, capped at 6 hours | No after native retries | Advance to the next eligible unattempted model |
| Unknown provider error | Pi handles any recognized native retries first | Use the one best-effort continuation allowance | Once | Switch after the continuation fails |
| No-progress timeout | Extension-owned timer | Use the one best-effort continuation allowance | Once | Switch after the continuation fails |
| User presses `Esc` or `Ctrl+C` | User cancellation | Stop automatic failover | No | Never switch |
| Tool execution failure | Tool failure | Stop automatic failover | No | Never switch |

A persistent classification describes the failed model and the required eventual manual recovery; it does not authorize repeated attempts on that model. Provider failure after tool calls can repeat side effects during a best-effort continuation. This is an accepted, documented limitation rather than a duplicate-free execution guarantee.

## TUI Behavior

`/failover` opens the global failover configuration and status view. Opening it refreshes catalog data; the same refresh also occurs at extension startup.

The TUI shows:

- the current model;
- whether automation is enabled, paused, or disabled;
- the ordered model list;
- cooldown and persistent manual-recovery status;
- the configured no-progress timeout;
- the model-level `Reset cooldown` action; and
- the latest failover source, target, and reason.

The model list renders a 20-row viewport. Arrow navigation changes the selection and scrolls the viewport instead of rendering every configured model on each keypress.

The TUI allows the user to select, reorder, add, and remove models. TUI write actions execute serially so rapid keypresses operate on the latest ordered list. Configuration changes auto-save to `getAgentDir()/model-failover.json`.

Notifications are emitted for each automatic transition and include:

- source model;
- target model; and
- reason, such as cooldown, persistent provider failure, unknown error, or no-progress timeout.

When the list is exhausted, the TUI shows a failure summary containing the attempted chain and the relevant reasons/statuses.

A manual model choice through `/model` or `Ctrl+P` pauses automation. Automatic switching stays paused until the user explicitly chooses the TUI restore action. Direct restore changes the selected model/mode but does not run a test request.

## Persistence and Security

- Read `models.json` and `ModelRegistry` data; never write Pi's catalog.
- Classify configuration as missing, loaded, or blocked. Malformed, semantically invalid, unreadable, and future-version files are preserved; blocked configuration disables automation until the user repairs it and explicitly reopens `/failover`.
- Preserve authorized order and compatible settings when migrating supported older versions.
- Serialize every authorized write with an adjacent exclusive lock, re-read and compare the retained source revision under that lock, flush a same-directory temporary file, then atomically rename it. A revision mismatch conflicts without touching newer bytes.
- Never delete an existing lock automatically; timeout fails closed with manual recovery guidance. Cleanup removes only this invocation's owned lock and successfully created temporary file.
- Persist provider/model references, the manual pause flag, and permanent recovery reasons. API keys, tokens, and other credentials remain in Pi's existing authentication/configuration systems.
- Keep request attempts, transient cooldown timestamps, cooldown ladder levels, and cache capability observations runtime-owned.

## Known Pi Limitations

Pi has no public exact API for retrying the current turn. Any extension continuation, whether after a same-model continuation allowance or after switching models, is therefore best-effort through the available extension lifecycle/model-selection behavior.

A continuation may duplicate tool calls or other side effects when the provider failed after tool execution. The extension must surface this limitation in project documentation and must not promise duplicate-free continuation. Pi's native retry count and backoff remain Pi-controlled.

## Implementation Phases

1. **Global integration and discovery**: register the global extension and `/failover`; observe the catalog and `ModelRegistry`; seed first-run authorization with only the current model.
2. **Configuration and TUI**: classify config loads, preserve blocked files, serialize revision-checked atomic writes, and implement list editing, status display, settings, and restore/pause behavior.
3. **Lifecycle and request compatibility**: observe settlement and negotiate rejected extension-injected cache fields before normal failover policy.
4. **Failover execution**: enforce configurable retry policy, the fixed per-target cooldown ladder, bounded traversal, transition notifications, and exhaustion summaries.
5. **Verification**: test configuration safety, authorization boundaries, request-field negotiation, session hashing, persistence, TUI behavior, each error class, and no-loop behavior.

## Acceptance Checklist

- [x] The extension is designed for global installation and exposes `/failover`.
- [x] Automatic failover defaults to enabled.
- [x] First setup authorizes only the current model; other discovered models require an explicit Add action.
- [x] Discovery is observational and cannot prune, reorder, or rewrite the configured authorization list.
- [x] The TUI can select, reorder, add, and remove models and auto-saves the ordered list.
- [x] Startup and `/failover` opening refresh catalog data.
- [x] The extension reads Pi's catalog but never edits `getAgentDir()/models.json`.
- [x] Malformed, invalid, unreadable, and future-version configuration is preserved and disables automation.
- [x] Authorized writes use lock + source revision CAS + flushed temporary file + atomic rename.
- [x] The extension-owned config contains no API keys or tokens.
- [x] `prompt_cache_key` and `prompt_cache_retention` negotiate field-specific 400/422 rejection without consuming normal retries.
- [x] Supported OpenAI-compatible `x-session-id` values are hashed; non-OpenAI paths remain unchanged.
- [x] Permanent balance/quota/authentication/model-recovery reasons persist across Pi restarts until explicit restore.
- [x] Manual `/model` and `Ctrl+P` selection pauses automation until explicit TUI restore.
- [x] Direct restore does not issue a test request.
- [x] Pi's recognized transient retries run first; native retry count/backoff remain Pi-controlled.
- [x] The extension waits for Pi to settle before switching.
- [x] Balance/quota/usage, `401`/`403`, and `404` errors are not retried on the same model and are marked for manual recovery.
- [x] `429`, network, and `5xx` failures apply the fixed per-target ladder (10, 20, 40, 60, 90, 180, 360 minutes) after native retries, capped at 6 hours.
- [x] Unknown errors and no-progress timeouts get one best-effort same-model continuation, then switch.
- [x] The timeout defaults to 90 seconds, accepts 15-900 seconds, and supports `0` to disable.
- [x] `Esc`, `Ctrl+C`, and tool execution failures never trigger a switch.
- [x] Each request attempts the configured model list at most once and cannot loop indefinitely.
- [x] Notifications show source, target, and reason.
- [x] Chain exhaustion shows a failure summary.
- [x] Documentation states that continuation may duplicate tool calls/side effects.
