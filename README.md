# Pi Model Failover

Pi Model Failover is a global-first Pi extension that moves a settled failed request through a user-controlled ordered model list. It provides `/failover` for configuration and runtime status. Version 8 keeps generated model metadata small: the generated file stores only chain identity, order, and enabled state; fixed shared state stores global target operational state and per-chain policy scopes.

**Status:** implemented for Pi `0.84.x` APIs. The package contains the TypeScript extension entry, global persistence, catalog discovery, TUI editor, bounded failover state machine, and focused Node tests.

## Install

Install the current public GitHub package through Pi's package manager:

```bash
pi install git:github.com/ahe-meow/pi-model-failover
```

The npm registry package `pi-model-failover` has not been published yet, so this command currently does **not** work:

```bash
pi install npm:pi-model-failover
```

For a local checkout:

```bash
pi install /absolute/path/to/pi-model-auto-switch
```

The package manifest registers `src/index.ts` globally. Pi keeps the extension active across projects and stores its v8 configuration at:

```text
getAgentDir()/model-failover.json
```

Each generated model in v8 contains only `id`, `name`, `enabled`, and its ordered real-model `chain`. Migration from v1-v7 is shared-first; if migration cannot complete, the source configuration remains byte-for-byte unchanged and automation stays blocked.

Global target state and chain scopes are stored separately at:

```text
~/.pi/agent/failover-state.json
```

This path is fixed for the user, even when `PI_CODING_AGENT_DIR` points elsewhere. The state is shared by the parent, child/subagent, and independent same-user processes. It contains no credentials, messages, or Session IDs. It has two layers:

- global records keyed by exact real `provider/model`, holding `enabled`, consecutive failures, `nextEligibleAt`, cooldown state, cumulative cooldown, and manual recovery; legacy persisted runtime `lease` fields are read only as compatibility input and are removed on the next write; they do not represent current coordination;
- chain scopes keyed by the encoded absolute agent directory plus generated model id (implemented as `encodeURIComponent(agent directory):model id`), holding chain policy and per-target overrides. Scope settings are initialized from the first real target, every override field defaults to `inherit`, and effective request settings merge scope policy with the selected target override.

Failover creates its own `ModelRuntime` for every Pi session, including child and subagent sessions. It reads the shared `models.json` and authentication state directly, so child-session lifecycle hooks and version-specific `pi-subagents` patches are not required. On `session_start`, it reloads and applies the authoritative v8 chain configuration, then restores session history and installs Footer/status context. Runtime failover itself remains usable before `session_start`; an already-open editor is not live-watched, so close and reopen it or trigger `session_start` to observe an external config revision.

Authentication remains owned by Pi. The extension reads `models.json` through its owned `ModelRuntime`; it never edits `models.json` directly and never stores API keys or tokens. Outer virtual request credentials and header transforms are not forwarded to real targets; each target runtime supplies its own authentication and native headers.

## `/failover`

Open `/failover` in the interactive TUI. Every non-history open reloads and applies the authoritative v8 chain configuration and refreshes model discovery before showing:

`/failover history` remains read-only and bypasses chain-config refresh.

- current model and automation mode;
- the ordered failover list;
- cooldown and manual-recovery statuses;
- the latest source, target, and reason transition.

The list supports selection, add, remove, and reorder. A first run creates an empty v8 configuration: no generated chain and no current model are added automatically. Create a generated model, then add authenticated real targets explicitly from the owned `ModelRuntime` snapshot. Once configured, the stored chain order is the authoritative failover authorization. The main model list and detail target chain keep a 20-row viewport with a visible range indicator. The Add-target candidate viewport reads Pi's `autocompleteMaxVisible` and displays that many real-model rows; the surrounding instructions do not count against the model-row limit. Once candidates are open, type directly to filter case-insensitively by `provider/model`; Backspace deletes search text, Up/Down scrolls, Enter adds, and Esc clears the search before closing. No-match results show a prompt and cannot be added.

The Footer status includes the current real target and effective thinking level, without a `Failover:` prefix. When the reasoning-effort toggle is disabled for that target, it shows `inherited`; targets without reasoning support show `unsupported`. Examples are `real a/m1 | thinking high` and `a/m1 → b/m2 (HTTP 500) | real b/m2 | thinking high`. Use `/failover history` to open the transition history for the current Pi session. Namespaced Pi custom entries preserve it across extension reloads and session resume without adding it to model context. It keeps the newest 100 switches, shows source, target, effective thinking level, local timestamp, and reason, and supports Up/Down scrolling plus Esc/q to close.

Configuration and shared-state writes use an adjacent filesystem lock, a retained source revision check, a flushed same-directory temporary file, and atomic rename. `releaseOwnedLock` removes only the lock owned by that write operation. Malformed, semantically invalid, unreadable, and future-version configuration files are preserved byte-for-byte; automation stays disabled and `/failover` reports the repair action instead of replacing the file. Supported older versions migrate to the v8 generated-model shape. Migration from v1-v7 is shared-first and preserves the original bytes if migration fails. An existing lock is never deleted automatically; after confirming no Pi process is writing, remove a stale lock manually and reopen `/failover`.

Shared-state read, lock, write, or compare-and-swap failure also fails closed: target attempts, provider routing, and TUI mutations remain blocked until the shared file passes a verified recovery check. The extension does not route against an unpersisted process-local projection.

Automation follows enabled generated chains and shared target coordination. The real target's global `enabled`, `nextEligibleAt`, cooldown, consecutive-failure, and manual-recovery state are consulted before an automatic attempt; effective policy comes from the chain scope merged with the selected target override. Multiple Pi sessions and adapters may concurrently use the same real target; CAS and file locks coordinate cross-process writes. `e` in chain detail toggles the global real-target `enabled` flag; `e` in the main list toggles generated-chain `enabled`.

In chain detail, press `Enter` to open `Target Settings: provider/model` for the selected target. Press `t` to open separate `Chain Settings: generated-model-id`; `p` is inert. Target settings edit only that target's override in the selected chain scope. Chain settings edit error behavior, max retries, no-progress timeout, reasoning effort, and four independent model-parameter toggles. Chain reasoning can be an explicit level or `inherit`; target overrides can also be `inherit`, which follows the chain value. The page also shows global target runtime and shared coordination, including `nextEligibleAt`, consecutive failures, cooldown/manual-recovery state, and cumulative cooldown. `e` changes global target enablement, and reset operates on global target runtime.

When chain or target reasoning is explicit and the reasoning-effort toggle is enabled, the effective merged value is mapped for the selected real target and applied at the provider request boundary. When both are `inherit`, the current Pi session thinking level is passed through unchanged on every request. The extension Footer and history display `inherited` for this path. The extension does not update Pi's own thinking setting.

Turning a parameter off stops the extension from sending or rewriting that parameter for the target; Pi and outer-hook values remain unchanged. An override set to `inherit` uses the chain scope's value. An explicit `cacheRetention:none` removes the cache key and retention request and adds no affinity. Policy persists in `failover-state.json` by scope and real target; global enablement and runtime coordination persist by real target.

For models using Pi's OpenAI Responses, Chat Completions, or Azure OpenAI Responses APIs, Pi adapters build the native payload and await async `onPayload`; failover awaits the outer callback and then applies its cache digest. Responses requests receive `reasoning.effort` (`off` maps to OpenAI's `none`), and Chat Completions requests receive `reasoning_effort`. OpenRouter is recognized by provider or base URL.

`prompt_cache_key` is `SHA-256("pi-model-failover/prompt-cache-key/v1:" + session ID)`, represented as 64 lower-case hexadecimal characters. The plaintext Session ID is never sent. `prompt_cache_retention: "24h"` follows only explicit long-retention/native-field support and target compatibility; an outer `pi-cache-optimizer` strip wins. Existing session-affinity headers are replaced with the same digest without changing header spelling. An explicit `cacheRetention:none` removes cache key and retention and adds no affinity.

When a structured HTTP 400/422 request-validation error identifies `prompt_cache_key` or `prompt_cache_retention`, compatibility negotiation is local to the exact target and API. It remembers only the rejected field, preserves the other field and unrelated payload data, and retries without consuming the normal retry budget; the negotiation remains bounded. Disabled fields are never negotiated. `401`/`403` authentication failures take precedence. Non-OpenAI API types are unchanged. See the [official API implementation notes](https://github.com/ahe-meow/pi-model-failover/blob/main/docs/research/openai-pi-request-parameters.md) for source references and Pi hook details.

## Failure policy

Pi owns recognized transient retries and their count/backoff. Failover waits for the settled result before applying the effective policy from the chain scope and selected target override. The normal newly initialized maximum retry value is `5`; it is separate from Pi's native provider retry count.

Automatic failure coordination is user-global and keyed by real `provider/model`. Parent, child/subagent, and independent same-user processes share consecutive automatic failure counts, `nextEligibleAt`, the fixed cooldown ladder, cumulative cooldown duration, persistent manual recovery, and global enablement. Multiple Pi sessions and adapters can concurrently attempt the same real target; CAS and file locks coordinate cross-process updates to the shared state. The ladder is 10, 20, 40, 60, 90, 180, and 360 minutes. Before `nextEligibleAt`, a request skips that target immediately and continues to the next chain target.

Success or reset clears the target's consecutive-failure and cooldown state. A persistent failure marks manual recovery globally for that real target. Policy edits from one chain do not rewrite the same target's override in another chain; global enablement, reset, and runtime coordination remain shared by exact real target. A legacy persisted runtime `lease` field is accepted only while reading old state and is omitted on the next write; it is not current target coordination.

- In `smart` mode, permanent errors switch immediately and enter global manual recovery; retry-eligible transient, unknown, and no-progress failures use the effective scoped retry budget before switching.
- `switch` mode performs no same-target retry. `retry` mode uses the same effective per-target budget for retry-eligible automatic failures, with exponential backoff (1s, 2s, 4s, capped at 60s), then switches.
- `maxRetries` is the exact number of same-target retries after the initial attempt. With `maxRetries=1`, a failure sequence can be A, A, B: only A enters cooldown after its retry is exhausted, B can succeed with clean state, and untouched targets remain unchanged.
- No-progress timeout is resolved from the selected scope and target override; user cancellation terminates the current request and stops routing without changing shared target state.
- A chain request is bounded by its configured targets. If every real target fails, each target may correctly enter its own cooldown during the same traversal; this is exact-target isolation, not consumption of a shared chain budget.

The router performs each real-target attempt inside the same virtual provider request with the Pi-supplied request context. Historical `toolResult` entries, including error results, remain context for the selected real model and never synthesize an early terminal result. Pi owns tool execution after provider output, so tool failures are outside this provider classifier. Delegate, transport, timeout, and shared-settlement failures remain provider-path failures; user cancellation remains terminal.

Transitions are exposed through the Footer and `/failover history`, which record source, target, and sanitized reason. The implementation does not emit a separate popup for every transition. Error output is bounded, credential material is redacted, and terminal-control characters are removed before display or persistence.

## Development and testing

Final verification passed the full custom-loader suite: 209/209 tests. `git diff --check` passed. Primary LSP diagnostics reported 0 findings across the 7 core files. `node ./node_modules/typescript/lib/tsc.js --noEmit --pretty false` passed. An isolated live `failover/orc-peon` smoke also passed through real Pi/provider authentication: exit code 0, exact marker `REAL_FAILOVER_SMOKE_OK`, empty stderr, and no 401, 403, or model-unavailable result. The smoke did not force a first-target failure or verify an automatic target switch.

With the local TypeScript dependency present, the standard commands are:

```bash
node --loader ./test/typescript-loader.mjs --test test/*.test.ts
node ./node_modules/typescript/lib/tsc.js --noEmit --pretty false
git diff --check
```

The tests cover configuration safety and migration, shared-state coordination, chain-scope inheritance and target overrides, authorization boundaries, request-field negotiation, session hashing, TUI behavior, context-preserving tool results, error policy, cooldown traversal, and exhaustion. Live provider behavior and visual terminal interaction still require a Pi session.
