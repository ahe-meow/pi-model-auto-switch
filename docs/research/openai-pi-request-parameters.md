# OpenAI request parameters in Pi

## Official OpenAI fields

Sources:

- [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Responses API](https://platform.openai.com/docs/api-reference/responses/create)
- [Chat Completions API](https://platform.openai.com/docs/api-reference/chat/create)

OpenAI documents `reasoning.effort` for the Responses API. The documented values are model-dependent and can include `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. The extension's user-facing `off` value maps to OpenAI's `none`. A model can support only a subset, so the provider/model must be checked before relying on `xhigh` or `max`.

For Chat Completions, the equivalent request field is top-level `reasoning_effort`. Its accepted values are also model-dependent. The extension should only inject it for an OpenAI-compatible API that declares/supports reasoning effort.

Prompt caching uses these top-level request fields on supported Responses and Chat Completions requests:

```json
{
  "prompt_cache_key": "stable-key",
  "prompt_cache_retention": "24h"
}
```

`prompt_cache_key` influences cache routing when repeated requests share the same prefix. OpenAI recommends stable values such as session IDs, but the key does not replace exact prefix matching. OpenAI also documents a roughly 15 requests/minute traffic guideline per key; higher traffic can miss cache.

`prompt_cache_retention: "24h"` requests extended retention for supported models. It is a maximum/best-effort retention policy, not a guarantee that every request gets a cache hit. Support is model- and organization-dependent; unsupported models or providers can reject the field. The implementation must therefore scope this to official OpenAI/Azure OpenAI request models rather than blindly adding it to every OpenAI-compatible gateway.

## Pi 0.84.2 request seam

Pi exposes the exact needed extension hooks:

- `before_provider_request`: `event.payload` is the provider payload before it is sent; mutating it or returning a replacement changes the request.
- `before_provider_headers`: `event.headers` is mutable after headers are assembled and before the HTTP request.
- `ExtensionContext.sessionManager.getSessionId()`: stable session identity.

Pi's current `pi-ai` already sends its own `prompt_cache_key` from `options.sessionId` and can send `prompt_cache_retention: "24h"` when `PI_CACHE_RETENTION=long`. It currently clamps the raw session ID to 64 characters rather than hashing it (`openai-prompt-cache.js`), and its session-affinity headers can also contain the raw session ID. The extension must therefore override the payload key and, for privacy, replace OpenAI session-affinity header values with the same digest.

Pi's existing provider serialization is:

- `openai-responses` / Azure Responses: `reasoning: { effort }`.
- `openai-completions`: `reasoning_effort`.
- Pi calls extension payload hooks after building those provider-specific fields, so the extension's override wins.

## Implementation decision

1. Add a persisted `reasoningEffort` setting with six user values: `off`, `low`, `medium`, `high`, `xhigh`, `max`; default `medium` for new installs and normalize old configs to that default.
2. Add a small `/failover` TUI control to cycle the setting.
3. On every official OpenAI/Azure OpenAI request, map `off` to `none` and inject the API-specific reasoning field.
4. Derive a deterministic `sha256("pi-model-failover/prompt-cache-key/v1:" + sessionId)` hex digest. This is 64 ASCII characters, contains no plaintext Session ID, and is stable for the session.
5. Inject `prompt_cache_key` and `prompt_cache_retention: "24h"` into the request payload and replace any OpenAI session-affinity header values with the same digest.
6. Leave non-OpenAI providers untouched. Real cache hits remain provider/model/prefix dependent and require live credentials to verify.

## Limitations

- OpenAI's model-dependent support means `max`/`xhigh` may be rejected by a model that does not advertise them.
- A 24-hour request is not a cache-hit guarantee.
- This extension can override the outgoing payload, but it cannot make an unsupported upstream provider accept OpenAI fields.
