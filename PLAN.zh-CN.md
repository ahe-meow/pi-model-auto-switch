# Failover 模型供应商与生成模型——开发计划（草案）

**状态：** 已纳入全部讨论决策的草案。本文档仅是开发计划；未经用户明确批准，不开始任何源代码实现。

英文原稿：[`PLAN.md`](PLAN.md)

## 1. 目标

把当前全局错误回退控制器改造成 Pi 中真实的 `failover` 模型供应商：

- Pi 和其他扩展通过常规模型注册表选择本项目生成的模型。
- 每个生成模型都有自定义且稳定的 ID、可修改的显示名称，以及独立的真实模型有序回退链。
- 现有的有界重试、冷却、错误分类、缓存字段协商、请求参数开关和思考强度控制，全部移入所选生成模型的供应商执行流程。
- 扩展不再改变 Pi 当前选择的模型，也不再通过隐藏 continuation 消息执行回退。
- 生成模型持久化到 `models.json` 的 `providers.failover` 中，供 Pi 原生功能和其他扩展发现、选择。
- Pi 内置 thinking 设置只参与 Pi 自己的界面显示或选择；供应商忽略它，实际请求始终使用扩展自己的思考强度配置。

## 2. 已确认的讨论决策

以下决策已成为计划的一部分：

1. **`models.json` 管理方式：** 扩展自动维护 `providers.failover`，正常使用不需要手动导出。
2. **流式回退：** 每次真实目标请求先完整缓冲；失败尝试的 partial 文本和工具调用不暴露给 Pi。
3. **策略归属：** 每个生成模型拥有一套完整链级策略；真实目标仅在确有差异时覆盖 reasoning 或请求参数开关。
4. **生成模型元数据：** 自动取整条链可保证的安全下限，不使用乐观值或用户手工声明值。
5. **v5 迁移：** 自动创建 `failover/default`，显示名为 `Default Failover`，保留现有链顺序和设置。
6. **禁用模型：** 禁用的生成模型从 `providers.failover.models` 中移除；已经使用该模型的旧会话在下一次请求时收到明确错误。
7. **模型身份：** 使用用户指定的稳定 ID，加上可独立修改的显示名称。修改 ID 必须执行明确的迁移操作，因为 Pi footer 和持久化引用主要使用 ID。
8. **成本范围：** 首期不实现失败尝试的精确成本聚合。模型目录成本暂设为 0；在 Pi 流契约允许时保留成功目标的 usage。
9. **配置主来源：** `model-failover.json` 是唯一业务事实来源。`models.json/providers.failover` 是自动生成的目录镜像；该托管区内的手工改动会在冲突安全的同步后被替换。
10. **旧 paused：** v5 的 `enabled` 迁移到默认生成模型；v5 的 `paused` 被丢弃，因为它属于旧的“直接替换 Pi 当前模型”机制。Restore 只清理 cooldown 和 manual-recovery 状态。
11. **目标暂时不可用：** 合法且启用的生成模型仍保存在 `models.json`；如果链中没有任何已认证目标，Pi 可用模型列表暂时过滤该生成模型。认证恢复并刷新后自动重新出现。空链或结构非法的链仍属于配置错误。
12. **真实目标范围：** 仅支持 Pi 内置供应商和 `models.json` 供应商。只由其他扩展动态注册的供应商不能加入真实回退链。

## 3. 当前基线

当前 `main` 分支是 v5 全局控制器：

- `src/config.ts` / `src/types.ts`：一条全局有序 `models` 链、全局策略、真实模型级请求参数开关和 reasoning 覆盖。
- `src/index.ts`：生命周期错误回退状态机；当前会调用 `pi.setModel()`，并使用 `pi.sendMessage()` 发送 continuation。
- `src/catalog.ts`：只观察 `ModelRegistry`，不注册供应商，也不维护 `models.json`。
- `src/tui.ts`：编辑一条全局回退链及其策略。
- 供应商请求 hook 注入 OpenAI 兼容参数，并且当前通过 `pi.setThinkingLevel()` 同步 Pi 原生 thinking。

现有行为和 v5 配置必须作为迁移来源，不能静默丢弃。

### 3.1 现有功能覆盖审计

以下是对当前扩展的严格功能盘点。每一项都必须在新架构中标记为“保留、适配、明确移除、修复或延期”；不能因为重做供应商而遗漏。

| 现有契约 | 当前证据 | 新计划处理 |
| --- | --- | --- |
| 配置不保存密钥；v1→v5 迁移；默认值和 cooldown/maxRetries/timeout 范围校验 | `src/config.ts`；`test/config.test.ts` | **适配：** 新生成模型 schema 迁移保留值，非法结构 fail-closed。 |
| 配置排他锁、源 revision CAS、临时文件 flush、原子 rename、并发首次写入冲突、锁所有权清理 | `saveConfig()`；配置锁/CAS 测试 | **保留：** 用于 `model-failover.json`，并新增 `models.json` 两文件同步失败恢复规则。 |
| malformed/invalid/unreadable/future-version 配置原字节保留并禁用，显式重新加载才恢复 | `loadConfig()`、`refreshCatalog()`、`blockAfterPersistenceFailure()`；配置/扩展测试 | **保留并适配：** 供应商注册和目录同步失败时不能改变 Pi 当前模型。 |
| 首次只授权当前模型；后续发现不能改写用户已授权顺序 | `discoverModels()`、`seedModelList()`；catalog/extension 测试 | **适配：** v5 转成 `failover/default`；真实目标候选改为已确认的内置 + `models.json` 范围。 |
| session 启动和 `/failover` 打开时刷新；区分成功空快照和刷新失败快照 | `refreshCatalog()`、`discoverModels()` | **保留：** 刷新私有目标运行时和生成模型可用性，不能删除业务配置。 |
| `prompt_cache_key`：命名空间前缀 + Pi Session ID 的 SHA-256；绝不发送明文 Session ID | `promptCacheKey()`；请求参数测试 | **保留并移入供应商：** 每个真实目标请求前应用，能力记忆按目标/API 隔离。 |
| `prompt_cache_retention: "24h"` 延长缓存 | `applyOpenAIRequestParameters()`；请求/运行时测试和文档 | **保留并移入供应商：** 只对支持的 OpenAI 兼容 API 且开关启用时发送。 |
| 四种 affinity header 原地替换并保持原大小写：`session_id`、`x-session-id`、`x-client-request-id`、`x-session-affinity` | `replaceOpenAISessionHeaders()`；请求参数测试 | **保留并移入供应商：** 不添加/删除/改写无关 header；非 OpenAI、无 session 时不动。 |
| 400/422 结构化缓存字段协商：嵌套 JSON、验证 type/code、`param`/`field`、无 param 的已知 token 旧网关格式、坏 JSON 容错 | `extractJsonRecords()`、`nestedRecords()`、`rejectedCacheFields()`；运行时测试 | **保留并适配：** 按生成模型/真实目标/API 记录，只记录被点名字段；401/403 优先，重复拒绝走普通策略。 |
| 协商重试从复用 payload 删除被拒字段，保留另一缓存字段/reasoning/自定义数据，且不消耗普通 maxRetries | `retryWithoutRejectedCacheFields()`；运行时测试 | **保留并修复：** 新适配器重新构造 payload；关闭的开关不能进入协商（当前实现需补显式保护）。 |
| 四个严格被动开关：cache key、retention、reasoning、session affinity；缺省全开；关闭时不注入、不改 Pi 已有字段 | `modelParameterToggles()`、`readModelParameters()`；参数/TUI 测试 | **保留并适配：** 放入生成模型策略和真实目标覆盖，仍要求四个布尔值齐全。 |
| 全局 reasoning fallback、真实模型 override/inherit、`thinkingLevelMap`、`null` 保持 provider 字段不动、`off` 映射 provider `none` | `resolveReasoningEffort()`、`reasoningEffortForModel()`；请求/设置/TUI 测试 | **保留并适配：** 生成模型策略 + 目标覆盖；忽略 Pi native reasoning，删除 `pi.setThinkingLevel()`。 |
| Pi 原生 retry 先执行；扩展 retry 预算独立；smart/switch/retry 和错误分类保持 | `classifyFailure()`、`shouldRetryCurrentModel()`、`handleSettled()`；state/运行时测试 | **适配：** `ModelRuntime.completeSimple()` 负责真实目标原生 retry，路由器只负责扩展额外策略，不能重复计数。 |
| 错误类别：余额/quota/usage、401/403/404 持久恢复；429/network/5xx cooldown；unknown/no-progress 自动处理；取消/工具失败终止 | `src/state.ts`；state/运行时/extension 测试 | **保留并适配：** 统一解析 `HTTP error (NNN)` 和裸 `NNN:`，保留优先级和原因。 |
| 每请求 attempted 集合、不回访、exhaustion 摘要、source/target/reason 通知 | `RequestState`、`nextUnattemptedModel()`、`requestSummary()`；state/runtime/TUI 测试 | **保留并适配：** 按生成模型隔离；同一请求内即使 cooldown 到期也不能回访。 |
| cooldown 仅运行时；到期后新请求重新进入；manual recovery 跨重启；Restore 清理；删除模型清理所有关联状态 | `cooldowns`、`manualRecovery`、`restoreFailover()`、删除动作 | **保留并适配：** 状态键变为生成模型 ID + 真实目标；Restore 不选择 Pi 模型。 |
| no-progress 默认 90 秒，15–900/0；只给活动且非 native-retry 尝试计时；响应/消息/turn/tool 活动重置；Pi idle 时不 abort | `startProgressTimer()`、`noteProgress()`、`canArmProgressTimer()`；state/runtime 测试 | **适配：** 在供应商缓冲层实现等价超时，排除 Pi native retry 和用户取消。 |
| 隐藏 continuation、context hook 删除失败 assistant、settling 防重复结算 | `sendContinuation()`、`context` hook、`settling`；extension/runtime 测试 | **明确替换：** 缓冲供应商不再隐藏 continuation/context 删除；成功的 tool-call 结果正常交给 Pi，工具失败和用户取消不触发回退。 |
| full-resource/子会话可能没有 `session_start`；未初始化 hook 不能覆盖子会话 native reasoning/header | readiness guard；settings-runtime 子会话回归 | **强化保留：** provider 注册和配置快照不能依赖 session 生命周期。 |
| 自定义 TUI、串行 action queue、20 行 viewport、增删排序、范围设置、reasoning/toggle、空/过时模型保护 | `src/tui.ts`；TUI/runtime 测试 | **适配：** 改成生成模型/name/ID/链编辑器，保留响应性、安全导航和不嵌套 Pi 弹窗。 |
| footer status、通知、最近 transition、cooldown/manual recovery 展示、exhaustion 链摘要 | `updateStatus()`、`notify()`、`viewFor()`、TUI render | **适配：** 报告生成模型和真实目标，不改变 Pi 当前模型；支持 headless/provider 错误诊断。 |
| Pi 管理认证；扩展不保存密钥/token；只有已认证模型可加入 | catalog/config 测试、README/DESIGN | **保留并适配：** 私有目标运行时使用 Pi auth；不打印凭据。 |
| 全局安装、Pi 0.84.x、reload/new/resume/shutdown 清理 | `package.json`、扩展注册和生命周期 handlers | **保留并适配：** async factory 注册供应商，支持 `--list-models`、原生 `/model`、子会话、reload 和干净关闭。 |
| 已知当前缺口：`src/state.ts` 状态解析比 `src/index.ts` 窄；缓存协商未显式检查关闭开关；无可用目标行为未定义 | 预提交审计与源码检查 | **Phase A/C 修复：** 统一状态解析、强制被动协商、无目标时返回明确 provider 错误。 |

这张矩阵是实现和审查的兼容性清单。新供应商不能只证明“普通目标能回退”就算完成；所有保留项都必须有聚焦回归测试。

第一版计划只笼统提到了缓存协商，遗漏了现有缓存优化的完整契约。现在已把它作为第 4.5 节的强制迁移模块，明确写入隐私、被动开关、协商、目标隔离和 retry 预算规则。

## 4. 目标架构

### 4.1 供应商 seam

注册一个 ID 为 `failover` 的原生/自定义供应商，并提供自定义流实现。生成模型统一使用 `provider: "failover"` 和稳定的生成模型 ID。

由于迁移后同一个 `models.json` 会包含托管的 `failover` 供应商，私有目标运行时必须在供应商组合前使用排除 `providers.failover` 的“真实目标视图”；不能因为生成目录存在而递归或组合失败。Phase A 必须在不写第二份用户可见目录、也不导入动态扩展供应商的前提下验证这一点。

供应商 adapter 是一个深模块，只暴露一个小接口：

```text
streamSimple(生成模型, Pi Context, Pi 请求选项) -> AssistantMessageEventStream
```

其实现负责：目标解析、请求准备、有界尝试、失败分类、cooldown/manual-recovery 状态，以及最终流和消息元数据。每次真实请求通过私有 Pi `ModelRuntime.completeSimple()` 委托；本项目不重新实现 OpenAI、Anthropic、Google、真实供应商认证或其他协议。

adapter 必须使用 `ModelsSimpleStreamOptions` 的公开请求 seam：用 `onPayload` 修改 payload，用 `transformHeaders` 修改认证完成后的 header，用 `onResponse` 获取用于失败/缓存分类的权威 HTTP 状态，并把当前 abort signal 传给每次真实尝试。

`src/index.ts` 最终只负责编排、注册和配置。它不能再调用 `pi.setModel()`，也不能再以 `pi.sendMessage()` 作为错误回退机制。

### 4.2 生成模型配置

把单条全局链替换为带版本的生成模型集合。建议的数据结构：

```ts
interface GeneratedFailoverModel {
  id: string;                 // failover 供应商下的稳定机器 ID
  name: string;               // Pi 显示的自定义名称
  enabled: boolean;
  chain: RealModelRef[];      // provider/id 真实目标的有序链
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

具体字段名可以在实现时微调，但已确认的结构不变：一个生成模型拥有一套链级策略、一条真实回退链，以及仅用于真实目标差异的可选覆盖。

每个生成模型的 cooldown、manual recovery、不支持的缓存字段、重试计数和 exhaustion 状态，都必须按“生成模型 ID + 真实目标”隔离。

旧的全局 `paused` 被移除。每个生成模型使用自己的 `enabled`。供应商级致命配置错误只能阻止路由，不能改变 Pi 当前选择的模型。

### 4.3 `models.json` 所有权与同步

`model-failover.json` 是唯一业务配置来源。扩展自动维护 `models.json` 中的 `providers.failover`。

扩展必须在语义上保留所有无关供应商和字段。原子重写可能统一 JSON 格式，但无关值和凭据不能发生变化。

同步流程必须：

1. 读取并验证现有文件，禁止在日志中输出凭据。
2. 只替换扩展托管的生成模型定义。
3. 使用排他锁、源 revision 校验、同目录临时文件、flush 和原子 rename，复用现有持久化纪律。
4. 如果写入期间检测到外部修改，则报告冲突，不覆盖外部修改。
5. 只修改显示名或链时保持生成模型 ID 不变。
6. 把托管 `providers.failover` 内的手工修改视为目录漂移；以 `model-failover.json` 重新生成，不做反向导入。
7. 成功更新配置和目录后，刷新私有真实目标运行时，并重新注册生成模型供应商。

供应商注册是运行时执行 seam；`models.json` 区块是持久目录 seam。正式编写路由前，先通过一个最小契约实验验证 Pi 合并顺序、认证可用性和 `failover` 供应商所需的最小合法元数据。

### 4.4 供应商元数据

每个生成模型向 Pi 暴露整条链的保守安全下限：

- `name`：用户定义的显示名称。
- `input`：默认取链上能力交集。
- `contextWindow`：取链上最小值。
- `maxTokens`：取链上最小值。
- `cost`：首期目录元数据为 0；失败尝试精确聚合属于明确延期项；可用时保留成功目标 usage。
- `reasoning` 和 `thinkingLevelMap`：只声明整条链能够保证的级别。
- 自定义供应商/API 元数据：只用于让 Pi 注册虚拟模型；每次尝试的真实 API 在内部选择。

元数据不能声明任一 fallback 目标无法提供的图片、上下文或 reasoning 能力。

### 4.5 原有请求与缓存优化（必须保留）

缓存/请求 adapter 必须在每个真实目标尝试中使用 `onPayload` 和 `transformHeaders`，并结合 `onResponse` 状态与最终 assistant 错误消息。不能依赖外层扩展的 `before_provider_request` 或 `before_provider_headers`，因为 Pi 当前选择的模型已经是虚拟 `failover` 模型。

当前请求优化不是偶然的 hook 代码，而是扩展的正式功能，必须搬到真实目标 adapter 后面，并保留专门测试：

1. 对 `openai-responses`、`openai-completions`、`azure-openai-responses`，使用 `pi-model-failover/prompt-cache-key/v1:` + Pi Session ID 的 SHA-256 生成 `prompt_cache_key`，绝不发送明文 Session ID。
2. 只有生成模型/真实目标开关打开时才请求 `prompt_cache_retention: "24h"`；关闭时保留 Pi 原有值。
3. 有 session ID 且 affinity 开关打开时，原地替换 `session_id`、`x-session-id`、`x-client-request-id`、`x-session-affinity`，保留原 header 拼写/大小写。同非 OpenAI API、无 session、无关 header 保持不动。
4. 四个被动开关独立解析：`promptCacheKey`、`promptCacheRetention`、`reasoningEffort`、`sessionAffinity`。缺省目标配置全开；关闭字段既不注入，也不改写。
5. 目标拒绝缓存字段时，检查 HTTP 400/422 的结构化验证记录、嵌套 `errors`、允许的 validation type/code、`param`/`field`，以及无参数但包含已知字段 token 的旧格式；不能匹配任意人类语言短语。
6. 不支持字段按“生成模型 + 真实目标 + API”记忆。下一次尝试只删除记忆字段，即使 payload 被复用或已含该字段；另一缓存字段、reasoning、自定义 payload 和 header 保持不变。
7. 关闭的字段、值校验错误、无关验证错误、认证错误都不能进入协商；401/403 优先。兼容重试不消耗生成模型普通 retry 预算；已省略字段再次被拒时走普通错误策略。
8. 每个真实目标的能力记忆独立；目标 A 或一种 API 的拒绝不能禁用目标 B 或另一 API。

当前 `src/index.ts` 有一个已知缺口：缓存协商需要在记录拒绝前明确检查被动开关。新 adapter 必须修复这一点，同时保留上述契约。状态解析也必须覆盖当前代码使用的所有形式，包括裸 `NNN:`。

### 4.6 思考强度隔离

决定真实请求思考强度时，供应商必须忽略：

- `PiRequestOptions.reasoning`
- `ctx.thinkingLevel`
- `settings.json` 中的 thinking 设置
- Pi 内置 thinking 控件产生的变化

实际值按以下顺序解析：

1. 所选生成模型的 `reasoningEffort`
2. 当前真实目标的可选 override
3. 迁移后的扩展默认值

然后通过真实目标的 `thinkingLevelMap` 转换，并传入真实供应商请求。

实现必须删除当前 `pi.setThinkingLevel()` 同步路径，也不能通过 `thinking_level_select` 事件修改扩展配置。

Pi 仍可能为虚拟模型显示或 clamp 一个原生 thinking 档位，但该显示值不能影响真实请求。测试必须证明：改变 Pi thinking 后，发送给真实供应商的值仍然是扩展配置值。

### 4.7 尝试与流语义

每次调用一个生成模型时：

1. 快照生成模型配置，并创建新的 attempted-target 集合。
2. 按配置顺序选择第一个符合条件的真实目标。
3. 为该目标应用现有请求参数开关和 reasoning 映射。
4. 通过 `ModelRuntime.completeSimple()` 执行真实目标，并完整缓冲结果。
5. 按现有 `smart` / `switch` / `retry` 策略分类失败终态。
6. 在生成模型自己的策略上，有界地重试同一目标或切到下一个目标。
7. 只向 Pi 返回一个兼容的最终 assistant 流/消息，并把生成模型身份和目标诊断放入不会进入模型上下文的元数据。

每次目标尝试在成功终态前都保持缓冲。失败尝试的文本和工具调用全部丢弃，再尝试下一个目标，从而避免重复文本、重复工具调用和破损 partial assistant 消息。

用户 abort 必须立即取消当前真实目标，并终止整条链，不能继续 fallback。

### 4.8 可用性与更新生命周期

- `models.json` 持久保存所有结构合法且启用的生成模型。
- 供应商可用性过滤器只在链中至少存在一个已认证静态目标时，才向 Pi 暴露该生成模型。
- Pi/供应商 refresh 同时刷新私有真实目标运行时；恢复认证后，不用编辑链即可重新出现。
- 每次供应商调用使用一份配置快照。TUI 修改不改变或取消进行中的请求，只影响下一次请求。
- 空链、同步时未知目标、过时引用和目录写入失败，必须在 `/failover` 显示明确诊断，不能静默使用其他模型。
- 旧全局 `paused` 和“手动选择模型后暂停自动化”行为被移除。每个生成模型的 `enabled` 控制是否进入目录；Restore 只清理运行时恢复状态。

## 5. UI 与用户流程

重做 `/failover`，用于管理生成模型：

1. 列出生成模型的显示名、稳定 ID、启用状态和链摘要。
2. 新建、重命名、删除、排序生成模型。
3. 编辑单个生成模型的真实回退链；候选仅来自已认证的 Pi 内置模型和 `models.json` 模型，并排除 `failover/*` 防止递归。
4. 编辑该生成模型的 cooldown、错误模式、重试次数、no-progress timeout、reasoning 档位和请求参数开关。
5. 显示真实目标的 cooldown/manual-recovery 状态，以及最近尝试/exhaustion 原因；不能顺带选择或替换 Pi 当前模型。
6. 每次业务配置成功持久化后，同步 `models.json`。

Pi 原生 `/model`、footer、子代理选模、CLI `--model` 和其他扩展，都必须通过常规模型注册表看到生成模型。

`/failover` 只编辑配置，不能把模型选择作为副作用。

## 6. 迁移

用户批准方案后，引入新的配置版本：

- 把现有 v5 有序链迁移到 `failover/default`，显示名为 `Default Failover`，保留链顺序和全部策略。
- 把 v5 `enabled` 迁移到 `failover/default.enabled`；丢弃 v5 `paused`，因为不再直接切换 Pi 模型。
- 把全局/真实模型级 reasoning 与请求参数开关转换为生成模型策略和真实目标 overrides。
- `default` 和 `Default Failover` 只用于 v5 自动迁移；以后新建模型必须显式填写稳定 ID 和显示名。
- 不得删除或改写 `models.json` 中无关供应商。
- 如果迁移或 `models.json` 同步被阻止，源文件必须保持原样，只禁用新供应商路由，并在 `/failover` 给出可执行的修复提示。

## 7. 批准后的实施阶段

### Phase A——契约实验

- 用最小隔离测试/供应商验证：原生供应商注册、`models.json` 合并顺序、扩展自管的虚拟认证、私有 `ModelRuntime` 真实目标委托、可用性过滤和子会话行为。
- 确定生成模型的具体元数据编码和最终流 identity 细节。

### Phase B——schema 与持久化

- 添加已批准的生成模型配置和 v5 迁移。
- 添加 `models.json` 读取、合并、冲突安全写入。
- 添加稳定 ID 校验、可编辑显示名、显式 ID 迁移、禁用模型目录过滤、严格校验和过时条目清理。

### Phase C——供应商路由

- 抽取可复用的请求、缓存、reasoning 映射和失败分类 helper，完整覆盖第 4.5 节缓存优化契约。
- 添加使用 `onPayload`、`transformHeaders`、`onResponse` 的真实目标尝试 adapter，而不是依赖外层模型生命周期 hook。
- 在供应商 stream seam 后实现按生成模型隔离的尝试状态和真实目标路由。
- 删除直接 `setModel` 和 continuation 回退路径。
- 添加 abort、partial、工具调用、cooldown、认证、缓存协商和 exhaustion 处理。
- 保留 Pi native retry 顺序，并将供应商额外 retry 预算与真实目标 runtime 的 native retry 分开。

### Phase D——TUI 与模型注册表

- 把全局链编辑器替换为生成模型编辑器和真实链编辑器；候选仅来自已认证的 Pi 内置模型和 `models.json` 模型。
- 在足够早的启动阶段注册生成模型，使 `/model`、CLI、子会话和其他扩展能够使用。
- 保证 reload/new/resume 和配置冲突保持安全。

### Phase E——迁移、文档与验证

- 更新 README、DESIGN 和迁移说明。
- 运行聚焦测试、全量测试、TypeScript、diff 检查、诊断、Pi `--list-models`、原生 `/model`、子代理选模和真实供应商冒烟测试。
- 审查最终 diff，并验证不存在直接改变 Pi 当前模型的路径。

## 8. 验收标准

- 用户可以创建两个稳定 ID、显示名和真实回退链都不同的生成模型。
- 当至少有一个配置的静态目标已认证时，两个模型都以 `failover/<id>` 出现在 `models.json`、Pi `/model`、CLI 模型列表，以及另一个扩展的 `ctx.modelRegistry` 中。
- 通过 Pi 原生功能选择生成模型后，整个会话始终保持选择该生成模型；failover 不调用 `pi.setModel()`，也不发送隐藏 continuation。
- 目标 A 失败后，按该生成模型自己的 retry/cooldown/error 策略转到目标 B；另一个生成模型的状态不受影响。
- 关闭的 cache/reasoning/session 参数对真实目标保持被动语义，不覆盖 Pi/供应商已有字段。
- 缓存 key 哈希、24 小时 retention、affinity header 替换、结构化字段协商、按目标能力记忆和不消耗普通 retry 预算，必须完整符合第 4.5 节。
- Pi 原生 thinking/settings 变化不改变扩展发送的真实 reasoning 值。
- 子会话和供应商调用使用生成模型自己的扩展 reasoning 配置。
- partial 和 tool-call 缓冲、用户 abort、认证错误、cooldown 恢复、缓存协商、配置冲突、空链和非法链都有明确测试行为。
- 只由其他扩展动态注册的供应商不会出现在真实回退链候选中。
- 现有 v5 配置迁移到 `failover/default` 后，不丢失链顺序和真实目标设置；旧 `paused` 不迁移。
- 禁用的生成模型从托管目录中移除；已使用该模型的旧会话在下一次请求时收到明确供应商错误。
- `models.json` 中全部无关供应商和值（包括凭据）保持不变。
- 失败尝试 usage/cost 的精确聚合不是首期验收项；供应商路由验证稳定后再作为明确后续任务实现。

## 9. 未来的实时 Web UI（计划项）

用户还希望：输入设置指令时生成一个 URL，指向实时 Web UI，用于管理本扩展设置。这是计划中的后续阶段，不应导致业务逻辑重复或凭据泄露。建议先完成供应商核心，再在共享配置 seam 稳定后实施 Web UI。

### 9.1 Web UI 不变量

- 设置动作（建议 `/failover web`，或 `/failover` 内的 `Web UI` 操作）启动或复用一个“当前会话级”设置服务器，并显示 URL。
- 页面管理与 TUI 完全相同的生成模型、稳定 ID/名称、真实回退链、策略值、目标覆盖、缓存/reasoning 开关和恢复/状态信息。
- HTTP handler 必须调用与 TUI 相同的深层配置/领域模块，不能复制一套 persistence、迁移、校验、models.json 同步或 failover 策略。
- 修改复用现有锁/CAS/原子写入和 `models.json` 同步规则。终端和 Web 并发编辑时必须显式报告冲突，不能静默覆盖较新的数据。
- 页面是实时的：页面、TUI、Pi refresh 或供应商运行时产生的更新，在不完整刷新页面的情况下同步显示；具体使用有界轮询还是 server-push 由契约实验决定。
- 页面采用 mobile-first 和触控优化：窄屏响应式布局、易读控件、大点击区域、不依赖终端宽度、适配安全区域、键盘可访问、竖屏可滚动。桌面支持，但不是首要约束。
- Web UI 绝不显示或返回 API key、OAuth token、原始 auth header、Session 明文 ID，或可能包含秘密的任意原始供应商错误 payload。
- URL 使用高熵、可过期 token 保护。服务器必须有明确 bind 策略，拒绝未认证请求，限制 origin 暴露，并在 session shutdown、显式关闭或过期时停止；不能无提示地把 Pi/PRoot listener 暴露到局域网。
- Web UI 只编辑配置，不能调用 `pi.setModel()`，也不能以副作用改变 Pi 当前模型。

### 9.2 Web UI 实施阶段

在供应商路由和共享配置 seam 稳定后增加 Phase F：

1. 用契约实验确定 URL 可达性、bind 地址、token 校验、生命周期和实时更新传输。
2. 抽取或完善 TUI 与 HTTP 共用的配置/领域模块。
3. 除非契约实验证明需要依赖，否则使用 Node 标准库 HTTP server 和静态 mobile-first HTML/CSS/JS。
4. 添加响应式设置页、生成模型链编辑、校验/错误页面、冲突恢复和实时状态。
5. 测试手机宽度渲染/交互、触控等价操作、token 过期、LAN 暴露、并发编辑、关闭、reload 和秘密脱敏。

以下 Web UI 决策已经确认：

1. **访问范围：** 默认仅绑定 localhost；首版 Web UI 不提供 LAN bind。支持同一设备上的手机浏览器访问；需要从其他设备访问时，由用户自行提供安全 tunnel。
2. **URL 交付：** 在终端显示 URL；系统剪贴板能力可用时自动复制。首版不增加二维码依赖。
3. **实时传输：** 使用约每秒一次的有界轮询；页面隐藏、关闭、token 过期或服务器停止时暂停/结束轮询。
4. **交付范围：** Phase F 在供应商核心验收后作为独立后续变更，复用已稳定的共享配置 seam。

具体 token TTL、指令名称、剪贴板 bridge 和页面 route 属于实施级契约实验决策，但不能违反以上安全不变量。

## 10. 计划审批

全部产品决策已经记录。请审阅本文档，提出修订意见，或明确批准进入开发。

## 11. 审批门

未经用户明确批准核心供应商计划和独立 Phase F Web UI 方向，不开始源代码实现。用户回复 `按这个计划开始开发` 或同等明确表述即可；实施从 Phase A 开始，不从 Phase F 开始。
