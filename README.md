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
- the no-progress timeout; and
- the latest source, target, and reason transition.

The list supports selection, add, remove, and reorder. TUI write actions run serially, and each change auto-saves atomically through an independent temporary file. New setup places the current model first, followed by Pi's authenticated model order. Discovery uses `ModelRegistry.getAvailable()`, so unauthenticated catalog entries do not appear in `/failover`; no image/context/capability compatibility filter is applied among authenticated models. Later refreshes preserve explicit user order and expose newly authenticated models through Add. The TUI renders a 20-row viewport, so arrow navigation scrolls only the visible window instead of redrawing the entire model list.

Automation is enabled by default. A manual `/model` or `Ctrl+P` selection pauses it until Restore is chosen in `/failover`. Restore selects the configured first model and resumes automation without sending a test request. The configured timeout defaults to 90 seconds; valid values are 15-900 seconds or `0` for off.

## Failure policy

Pi owns recognized transient retries and their count/backoff. This extension waits for `agent_settled` before making a failover decision.

- `401`, `403`, `404`, and balance/quota/usage errors are marked for manual recovery and are not retried on that model. Permanent recovery reasons survive Pi restarts until Restore clears them.
- `429`, network failures, and `5xx` failures place the model on a 30-minute runtime cooldown before advancing.
- Unknown provider errors and an enabled no-progress timeout receive one best-effort same-model continuation, then advance if that continuation fails.
- User cancellation and tool execution errors stop automatic failover.
- A request attempts the configured list at most once. Exhaustion reports the attempted chain and reasons.
- Transition notifications include source, target, and reason.

Pi does not expose a public exact retry-current-turn API. Continuations use Pi's supported `pi.sendMessage` context path and do not resend the original user prompt. They are best-effort: a provider failure after tool execution can duplicate tool calls or other side effects. The extension does not promise duplicate-free continuation.

## Development and testing

Install development dependencies, then run the focused tests and TypeScript check:

```bash
npm install
npm test
npm run check
```

The tests cover config validation and concurrent atomic persistence, secret-free serialization, catalog/auth discovery and first-run ordering, serialized TUI reordering, error classification, cooldown eligibility, request traversal, and exhaustion summaries. Live provider behavior and visual terminal interaction require a Pi session and are not exercised by the unit tests.
