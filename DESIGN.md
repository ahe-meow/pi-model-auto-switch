# Pi Model Failover Extension Design

Status: implemented for Pi `0.84.x`; the extension, TUI, persistence, tests, and user documentation are present.

## Goals

- Provide a global-first Pi extension with a TUI entry point at `/failover`.
- Keep automatic failover enabled by default while allowing an explicit user-controlled pause and restore.
- Maintain one ordered model list containing models Pi currently considers authenticated.
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
  "version": 2,
  "enabled": true,
  "paused": false,
  "models": [
    { "provider": "<provider>", "id": "<model-id>" }
  ],
  "noProgressTimeoutSeconds": 90,
  "manualRecovery": {
    "<provider>/<model-id>": "HTTP 401"
  }
}
```

- `version` supports deliberate future migrations.
- `enabled` defaults to `true` for a new configuration.
- `models` is the single ordered failover list. A model reference is identified by its provider and model id; it contains no authentication material.
- `noProgressTimeoutSeconds` defaults to `90`. Valid user values are `15` through `900`, or `0` to disable the extension-owned no-progress timeout.

- `paused` records a manual `/model` or Ctrl+P choice until explicit TUI restore.
- `manualRecovery` records non-secret permanent failure reasons for balance/quota/usage, `401`/`403`, `404`, and unavailable catalog models; these statuses survive Pi restarts until restore clears them.

The configuration is extension-owned. Pi's global models catalog remains the source for catalog discovery and is read-only to this extension.

### Runtime state

Runtime state is held for the active process/request and is not persisted as credentials or request history. It includes:

- automation mode: enabled, paused, or disabled;
- the active model and the source/target/reason for the latest transition;
- the current request's attempted model references;
- at most one same-model continuation used by the unknown-error/no-progress path;
- per-model cooldown expiry for transient `429`, network, and `5xx` failures; and
- whether the current request is waiting for Pi's native retry handling, settled, switching, or exhausted.

Persistent non-secret recovery state is kept in the extension configuration. Cooldowns and request attempts remain process/request state; permanent recovery reasons and the manual pause flag survive restart.

A request's attempted set resets at the start of each user request. A model is not selected again during that request after it has been attempted, even if its cooldown has elapsed.

### Catalog inputs and ordering

At startup and whenever `/failover` opens, the extension refreshes Pi's model registry. The registry reads Pi's global models catalog at `getAgentDir()/models.json`, while `getAvailable()` supplies models with configured authentication.

The available set contains only models Pi currently considers authenticated. The extension applies no image/context/capability compatibility filter among those models. On first setup, the current model is placed first, followed by the available-model order. User edits to the ordered list are authoritative afterward; refreshes update discovery without replacing the user's explicit order. Newly authenticated models remain available to add.

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
3. A recognized transient failure is therefore first handled by Pi. If it remains a failure, the extension applies the classification table below.
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
| HTTP `429` | Pi handles recognized native retries first | Put the failed model on a 30-minute cooldown | No after native retries | Advance to the next eligible unattempted model |
| Network failure | Pi handles recognized native retries first | Put the failed model on a 30-minute cooldown | No after native retries | Advance to the next eligible unattempted model |
| HTTP `5xx` | Pi handles recognized native retries first | Put the failed model on a 30-minute cooldown | No after native retries | Advance to the next eligible unattempted model |
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
- the configured no-progress timeout; and
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
- Write only the extension-owned `model-failover.json` configuration through an atomic same-directory rename; each concurrent save uses an independent temporary file.
- Persist provider/model references, the manual pause flag, and permanent recovery reasons. API keys, tokens, and other credentials remain in Pi's existing authentication/configuration systems.
- Keep request attempts and transient cooldown timestamps runtime-owned; permanent recovery reasons are non-secret and persist until explicit restore.
- Make the default configuration automatic, global, and usable without requiring the extension to duplicate Pi's secrets.

## Known Pi Limitations

Pi has no public exact API for retrying the current turn. Any extension continuation, whether after a same-model continuation allowance or after switching models, is therefore best-effort through the available extension lifecycle/model-selection behavior.

A continuation may duplicate tool calls or other side effects when the provider failed after tool execution. The extension must surface this limitation in project documentation and must not promise duplicate-free continuation. Pi's native retry count and backoff remain Pi-controlled.

## Implementation Phases

1. **Global integration and discovery**: register the global extension and `/failover`; read the catalog and `ModelRegistry`; seed the first-run ordered list with the current model followed by authenticated model order.
2. **Configuration and TUI**: implement the minimal config shape, validation, startup/open refresh, list editing, status display, auto-save, and explicit restore/pause behavior.
3. **Lifecycle observation and classification**: observe request settlement, cancellation, tool failures, native retry completion, provider errors, and the extension-owned no-progress timer.
4. **Failover execution**: enforce the state machine, cooldowns, one-continuation rule, bounded model traversal, transition notifications, and exhaustion summaries.
5. **Verification**: test ordering, persistence/security boundaries, pause/restore, each error class, cooldown expiry, timeout settings, cancellation/tool-failure stops, and no-loop behavior.

## Acceptance Checklist

- [x] The extension is designed for global installation and exposes `/failover`.
- [x] Automatic failover defaults to enabled.
- [x] First setup orders the current model first, followed by authenticated model order.
- [x] The available model set contains Pi-authenticated models and excludes unauthenticated catalog entries without applying compatibility filtering.
- [x] The TUI can select, reorder, add, and remove models and auto-saves the ordered list.
- [x] Startup and `/failover` opening refresh catalog data.
- [x] The extension reads Pi's catalog but never edits `getAgentDir()/models.json`.
- [x] The extension-owned config contains no API keys or tokens.
- [x] Permanent balance/quota/authentication/model-recovery reasons persist across Pi restarts until explicit restore.
- [x] Manual `/model` and `Ctrl+P` selection pauses automation until explicit TUI restore.
- [x] Direct restore does not issue a test request.
- [x] Pi's recognized transient retries run first; native retry count/backoff remain Pi-controlled.
- [x] The extension waits for Pi to settle before switching.
- [x] Balance/quota/usage, `401`/`403`, and `404` errors are not retried on the same model and are marked for manual recovery.
- [x] `429`, network, and `5xx` failures apply a 30-minute per-model cooldown after native retries.
- [x] Unknown errors and no-progress timeouts get one best-effort same-model continuation, then switch.
- [x] The timeout defaults to 90 seconds, accepts 15-900 seconds, and supports `0` to disable.
- [x] `Esc`, `Ctrl+C`, and tool execution failures never trigger a switch.
- [x] Each request attempts the configured model list at most once and cannot loop indefinitely.
- [x] Notifications show source, target, and reason.
- [x] Chain exhaustion shows a failure summary.
- [x] Documentation states that continuation may duplicate tool calls/side effects.
