# Pi Model Failover

Pi Model Failover is a global-first Pi extension that moves a settled failed request through a user-controlled ordered model list. It provides `/failover` for configuration and runtime status.

**Status:** implemented for Pi `0.84.x` APIs. The package contains the TypeScript extension entry, global persistence, catalog discovery, TUI editor, bounded failover state machine, and focused Node tests.

## Install

Install the current public GitHub package through Pi's package manager:

```bash
pi install git:github.com/ahe-meow/pi-model-auto-switch
```

The npm registry package `pi-model-failover` has not been published yet, so this command currently does **not** work:

```bash
pi install npm:pi-model-failover
```

For a local checkout:

```bash
pi install /absolute/path/to/pi-model-auto-switch
```

The package manifest registers `src/index.ts` globally. Pi keeps the extension active across projects and stores its configuration at:

```text
getAgentDir()/model-failover.json
```

Authentication remains owned by Pi. The extension reads Pi's `models.json` and `ModelRegistry`; it never edits `models.json` and never stores API keys or tokens.

## `/failover`

Open `/failover` in the interactive TUI. It refreshes model discovery on every open and shows:

- current model and automation mode;
- the ordered failover list;
- cooldown and manual-recovery statuses;
- the latest source, target, and reason transition.

The list supports selection, add, remove, and reorder. On a new install, only the current model is authorized; other authenticated models discovered through `ModelRegistry.getAvailable()` are available to add explicitly. Discovery is observational: refresh failure or an empty result never removes, reorders, or rewrites the configured list. The configured model order is the authoritative failover authorization. The TUI renders a 20-row viewport, so arrow navigation scrolls only the visible window instead of redrawing the entire model list.

Configuration writes use an adjacent exclusive lock, a retained source revision check, a flushed same-directory temporary file, and atomic rename. Malformed, semantically invalid, unreadable, and future-version configuration files are preserved byte-for-byte; automation stays disabled and `/failover` reports the repair action instead of replacing the file. Supported older versions migrate while preserving configured model order and compatible settings. An existing lock is never deleted automatically; after confirming no Pi process is writing, remove a stale lock manually and reopen `/failover`.

Automation is enabled by default. A manual `/model` or `Ctrl+P` selection pauses it. Press `e` to cycle `enabled → paused → disabled → enabled` without changing the current model, cooldowns, or recovery state. Restore selects the configured first model, clears runtime recovery state, and resumes automation without sending a test request.

Press `t` to open the settings page. Use Up/Down to select a setting, Enter to edit, and Esc to return. The page contains cooldown duration (0-1440 minutes), error behavior, maximum extension retries (0-10), no-result timeout (15-900 seconds or `0` for off), and model parameters. Error behavior defaults to `smart`: permanent errors switch immediately, while transient and unknown errors retry the current model before switching. The default cooldown is 30 minutes, maximum extension retries is 1, and no-result timeout is 90 seconds. The Model parameters page also lets each configured model override the global reasoning effort or inherit it. Add and all `/failover` interactions stay inside the custom panel.

Press `i` in the main panel to select the global fallback reasoning effort. A per-model override takes precedence when that model is selected. The effective value is applied to the provider payload and Pi's native thinking state at session startup, model changes, and after changes, so Pi's built-in footer and child-agent sessions use the selected model's level. If the current model's `reasoning effort` parameter toggle is off, Pi-owned native state is left untouched.

The `Model parameters` entry opens a per-model page for the model selected in the main list. Its first row selects `Reasoning level`: choose `inherit` to use the global fallback or choose one of Pi's supported levels (`off`, `low`, `medium`, `high`, `xhigh`, or `max`). The remaining four rows are independent switches for `prompt_cache_key`, `prompt_cache_retention`, `reasoning effort`, and `session headers`. Press Enter or Space to select/toggle, Left/Right to move to another configured model, and Esc to return. Toggling a parameter off stops the extension from sending that parameter for the model; toggling it on restores the default injection. Settings persist in `model-failover.json` under `modelParameters` and `modelReasoningEfforts`, keyed by `provider/id`; disabling a parameter leaves Pi's own payload fields untouched.

For models using Pi's OpenAI Responses, Chat Completions, or Azure OpenAI Responses APIs—including custom compatible providers—every provider request is adjusted through Pi's `before_provider_request` hook:

- Responses requests receive `reasoning.effort` (`off` maps to OpenAI's `none`).
- Chat Completions requests receive `reasoning_effort`.
- `prompt_cache_key` is a stable SHA-256 digest of the Pi Session ID, so the plaintext Session ID is not sent as the cache key.
- `prompt_cache_retention: "24h"` requests extended prompt-cache retention.
- Existing `session_id`, `x-session-id`, `x-client-request-id`, and `x-session-affinity` affinity headers are replaced with the same digest without changing header spelling.

OpenAI model support is model-dependent. When a 400/422 request-validation JSON error reports a known field through its `code`, `type`, and `param` values—such as `unknown_parameter` or `unsupported_parameter`, `invalid_request_error`, and `prompt_cache_key`/`prompt_cache_retention`—the extension remembers only that field for the provider/model/API and retries the same model without it. The JSON message language is not used for matching; the legacy gateway shape without `param` is supported only when its validation type and known field token are present. The other cache field, reasoning fields, and unrelated payload data remain. This compatibility retry does not consume the configured extension retry budget; `401`/`403` authentication failures still take precedence. `xhigh`, `max`, and 24-hour retention remain best effort. Non-OpenAI API types are unchanged. See the [official API implementation notes](https://github.com/ahe-meow/pi-model-auto-switch/blob/main/docs/research/openai-pi-request-parameters.md) for source references and Pi hook details.

## Failure policy

Pi owns recognized transient retries and their count/backoff. This extension waits for `agent_settled` before making a failover decision. The extension's maximum retry setting counts its own same-model continuations and is separate from Pi's native provider retry count.

- In `smart` mode, `401`, `403`, `404`, and balance/quota/usage errors switch immediately and are marked for manual recovery. Permanent recovery reasons survive Pi restarts until Restore clears them.
- In `smart` mode, `429`, network failures, `5xx` failures, unknown provider errors, and enabled no-progress timeouts retry the current model up to the configured limit, then switch.
- `switch` mode skips same-model continuations; `retry` mode retries every automatic failure up to the configured limit, then switches.
- Cooldown duration applies when a cooldown-class failure makes a model ineligible for later requests. While automation is enabled, each new user request starts on the first configured model that is not cooling down or in manual recovery, so an expired model can be reused automatically. Manual `/model` or `Ctrl+P` selections pause automation, and an explicit Restore selection is honored for its next request. User cancellation and tool execution errors stop automatic failover.
- A request attempts the configured list at most once. Exhaustion reports the attempted chain and reasons.
- Transition notifications include source, target, and reason.

Pi does not expose a public exact retry-current-turn API. Continuations use Pi's supported `pi.sendMessage` context path and do not resend the original user prompt. They are best-effort: a provider failure after tool execution can duplicate tool calls or other side effects. The extension does not promise duplicate-free continuation.

## Development and testing

Install development dependencies, then run the focused tests and TypeScript check:

```bash
npm install
node --test --loader ./test/typescript-loader.mjs test/*.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

The tests cover classified/non-destructive config loading, lock/revision/atomic persistence, observational catalog discovery, current-only first-run authorization, blocked runtime gates, cache-field negotiation, session hashing, TUI behavior, error policy, cooldowns, request traversal, and exhaustion. Live provider behavior and visual terminal interaction still require a Pi session.
