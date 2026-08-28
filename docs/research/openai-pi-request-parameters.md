# OpenAI request parameters in Pi

This note records the implemented v8 request behavior. It is an implementation reference, not a promise that every upstream model or gateway supports every field.

## Official OpenAI fields

Sources:

- [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Responses API](https://platform.openai.com/docs/api-reference/responses/create)
- [Chat Completions API](https://platform.openai.com/docs/api-reference/chat/create)

OpenAI documents `reasoning.effort` for the Responses API. Supported values are model-dependent and can include `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. The extension's user-facing `off` value maps to OpenAI's `none`.

For Chat Completions, the equivalent request field is top-level `reasoning_effort`. The accepted values are also model-dependent.

Prompt caching uses these top-level fields on supported Responses and Chat Completions requests:

```json
{
  "prompt_cache_key": "stable-key",
  "prompt_cache_retention": "24h"
}
```

`prompt_cache_key` influences cache routing when repeated requests share the same prefix. A stable key does not replace exact prefix matching. `prompt_cache_retention: "24h"` is a best-effort retention request, not a cache-hit guarantee; support depends on the model, provider, and organization.

## Pi adapter boundary

Pi adapters build the native provider payload and await async `onPayload` callbacks. Failover awaits the outer callback and then applies its cache digest. This preserves Pi's API-specific payload construction before failover's final parameter handling.

The supported API families are:

- OpenAI Responses;
- OpenAI Chat Completions; and
- Azure OpenAI Responses.

Responses, Completions, and Azure use their API-specific fields and headers. OpenRouter is recognized by provider or base URL. Other API types are unchanged.

## Implemented behavior

1. Resolve the exact real `provider/model` target and its shared target settings.
2. Apply the reasoning field for the target API when the reasoning-effort toggle is enabled. Responses use `reasoning.effort`; Chat Completions use `reasoning_effort`; `off` maps to `none` where the API supports it.
3. Derive `prompt_cache_key` as:

   ```text
   SHA-256("pi-model-failover/prompt-cache-key/v1:" + sessionId)
   ```

   The result is 64 lower-case hexadecimal characters. The raw Pi Session ID is never sent through failover headers.
4. Request `prompt_cache_retention: "24h"` only when explicit long retention/native field support and target compatibility permit it. If `cacheRetention:none` is explicit, remove cache key and retention and add no affinity.
5. Replace recognized session-affinity header values with the same digest in place, preserving header spelling. A disabled session-header toggle leaves existing Pi/outer values unchanged.
6. If an outer `pi-cache-optimizer` strips cache fields, that stripping wins.

The four parameter toggles are independent and passive: prompt-cache key, prompt-cache retention, reasoning effort, and session headers. A disabled toggle prevents the extension from injecting or rewriting that parameter and leaves Pi/outer-hook values unchanged.

## Compatibility negotiation

A structured HTTP 400/422 request-validation error can identify an unsupported `prompt_cache_key` or `prompt_cache_retention` field. Negotiation is target- and API-local:

- remember only the rejected field for the exact real target and API;
- remove that field from the next compatible payload, including a reused payload;
- preserve the other cache field, reasoning fields, unrelated payload data, and unrelated headers;
- do not negotiate disabled fields, value-validation errors, unrelated validation errors, or authentication failures;
- let `401`/`403` authentication handling take precedence; and
- keep the compatibility retry free from and bounded separately from the normal retry budget.

The structured matcher uses the supported validation `code`, `type`, and `param`/`field` forms. Legacy gateway errors without a parameter are eligible only when their validation type and known field token identify one of the two cache fields; human-language message text is not matched as a fixed phrase. Rejection on one target or API does not change another target or API. A repeated rejection of an already omitted field follows normal failover policy.

## Limitations

- Model-dependent reasoning support means `xhigh` and `max` may be rejected.
- A 24-hour retention request does not guarantee a cache hit.
- Custom gateways can reject, strip, or ignore OpenAI fields.
- Cache compatibility negotiation does not make an unsupported upstream provider accept an unsupported field.
