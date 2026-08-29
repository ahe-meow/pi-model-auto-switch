# 开发报告：Pi Model Failover v8 可靠性、共享协调与文档对齐

日期：2026-08-25

范围：Pi `0.84.x` 扩展实现、v8 配置/共享状态迁移、故障路由、TUI、请求参数边界与验证

## 1. 结论

本轮实现已完成并通过最终完整的自定义 TypeScript loader 测试套件：`208/208`。`git diff --check` 通过；primary LSP diagnostics 在 7 个核心文件中报告 0 findings。`node ./node_modules/typescript/lib/tsc.js --noEmit --pretty false` 通过。本次 isolated `failover/orc-peon` live smoke 也通过了真实 Pi/provider authentication：exit code 为 0，stdout 包含精确 marker `REAL_FAILOVER_SMOKE_OK`，stderr 为空，且没有出现 401、403 或 model unavailable。该 smoke 没有强制 first target 失败，也没有验证自动 target switch。v8 的核心边界已经稳定：生成配置只保存链身份、顺序和启用状态；固定共享状态保存精确真实目标的运行协调信息，以及按生成链隔离的策略 scope 和 target override。

首轮启动写入的是空 v8 配置。系统不会自动把当前模型写入授权链，用户必须先创建生成链，再显式添加真实目标。配置、迁移、共享状态或协调写入无法验证时，系统采取 fail-closed 行为：保留原始字节，阻止路由和写操作，不使用未经持久化确认的本地降级状态继续运行。

运行时请求仍由 Pi 的 provider/adapter 处理。扩展在 Pi 让请求达到 settled 结果后，按请求开始时取得的有效 scope 策略决定重试、冷却或切换。Pi 自己的工具执行不属于扩展的 provider failure 分类；历史 `toolResult` 只作为下一次真实目标请求上下文保留，不会被扩展推断成新的终止失败。

## 2. 需求与验收边界

本次文档和实现核对覆盖以下要求：

1. 将生成配置和共享运行状态彻底分离，避免把运行时故障、租约、凭据或策略写入 v8 生成文件。
2. 支持 v1-v7 到 v8 的 shared-first 迁移；任何共享注册、写入、校验、重载或 CAS 冲突都必须阻止不安全的迁移完成。
3. 让父会话、子会话/子代理以及同一用户的独立 Pi 进程共享精确 `provider/model` 目标的启用状态和运行协调信息。
4. 让每条生成链拥有独立 scope；scope 以第一个真实目标的策略初始化，每个目标 override 默认所有字段为 `inherit`。
5. 让每次请求使用稳定的有效策略快照，并允许多个 Pi session/adapter 并发尝试同一真实目标；共享状态写入通过 CAS/file lock 协调。
6. 修复自动失败重试预算隔离、租约释放、文件协调、TUI 快速按键、请求凭据边界和历史工具结果误判。
7. 保留 Pi 的原生 provider retry 归属，不替换其计数或退避；扩展只处理 Pi settled 之后的额外目标级策略。
8. 保证 Footer 和当前 session 的 failover history 能提供可审计的切换信息，同时不添加未实现的消息通知或原生 thinking 同步能力。
9. 对凭据、Session ID、控制字符、恶意历史条目和 provider 错误文本执行最小化持久化和输出清理。
10. 用完整测试、TypeScript 检查、Markdown 栅栏/空白检查和过时机制 grep 证明文档与实现一致。

明确不在本轮范围内的内容：强制 first-target failure/switch 场景、改变 Pi 原生 retry、修改 `models.json`、复制 API key/token、保证工具副作用零重复，以及恢复操作前发送探测请求。真实 provider authentication 路径已通过 isolated smoke 验证；完整 provider 故障切换矩阵仍由本地 doubles 覆盖。

## 3. Bug-first 时间线

### 3.1 先修正持久化边界

最先暴露的问题是 v8 生成配置仍然承载了旧版本的策略字段。旧结构把 reasoning、error behavior、retry count、timeout、parameter toggles、manual recovery 混在生成模型中，导致以下风险：

- 同一个真实目标出现在不同生成链时，链内策略无法真正隔离。
- 全局运行状态和链级策略的所有权不清晰。
- 迁移时容易把旧模型顺序、第一目标策略和目标 override 混为同一层。
- 生成配置不再只是用户授权链，文档也容易误导用户以为配置文件是全部运行时真相。

根因是数据模型没有按照“生成链身份”和“真实目标运行状态”划分所有权。修复后，v8 生成配置只保留 `id`、`name`、`enabled` 和有序真实目标 `chain`。共享状态文件保存全局 target records、registrations、chain scopes 和 target overrides。

scope key 使用编码后的绝对 agent directory 加生成模型 id，形式为 `encodeURIComponent(agent directory):model id`。真实目标仍以精确 `provider/model` 为全局 key。这样，同一真实目标可以被多个 scope 引用，但每个 scope 的 policy override 仍然独立。

### 3.2 修正迁移顺序和失败语义

旧迁移路径的问题不是单一字段转换错误，而是“先写配置、后确认共享状态”会产生半完成状态：生成文件可能已经变成 v8，但共享目标注册、scope 创建或运行状态迁移没有成功。此时继续路由会绕过跨进程协调。

根因是迁移被当成普通配置转换，而不是一个需要共享状态先行确认的事务边界。修复后的顺序是：

1. 读取并保留源文件的原始 revision 和字节。
2. 在内存中解析 v1-v7，生成 v8 chain projection 和 legacy target candidates。
3. 先向共享状态注册真实目标和 scope，并验证返回的 coordination status 为 `shared`。
4. 只有共享注册成功，才用锁、revision check、临时文件 flush 和 atomic rename 写 v8。
5. 写入后重新读取权威 v8 文件，并再次 reconcile/refresh 共享注册。
6. 任一步失败都保留源字节、阻止 provider routing 和编辑入口。

旧配置中的多个目标候选会按生成模型顺序和链位置进入 shared-first 的 first-wins 解析。scope 的策略取该 scope 注册链的第一个真实目标策略；目标 override 不再把旧模型级策略复制成显式值，而是初始化成全字段 `inherit`。这使当前链的公共策略和单目标差异可被独立验证。

### 3.3 修复首轮自动授权误读

早期文档把首轮行为写成“自动授权当前模型”。实现验收确认首轮其实创建空 v8 文件，随后用户通过 TUI 创建生成模型并显式添加目标。自动把当前模型放进链会绕过用户授权边界，也会在认证快照不完整时产生错误的可用性假设。

修复内容：首轮配置为空；catalog discovery 只提供 Add 候选；发现结果不能新增、删除、排序或重写已保存授权链。`models.json` 始终由 Pi 管理，扩展只通过自有 `ModelRuntime` 读取模型和认证状态。

### 3.4 修复共享状态“本地继续运行”的安全问题

共享文件 malformed、invalid、unreadable、future-version、write-failed 或 CAS exhausted 时，旧的降级思路可能让进程使用 local projection 继续发起 target attempt 或写 TUI。这会破坏父子进程间的单一协调事实，也可能让两个进程同时认为同一个目标可用。

根因是把“能够显示最后一次快照”和“能够安全执行新协调操作”混成一个能力。修复后：

- 快照可显示最后一个安全文档，但 coordination status 标记为 degraded。
- degraded 时，target attempt、settlement、settings、override、reset、registration 等变更都返回协调失败。
- provider routing 在共享状态无法确认时终止，不转入未经共享状态验证的进程内路由。
- TUI 写操作被阻止，并显示修复共享状态的指引。
- 只有重新读取并完成写探针/CAS 验证后，coordination 才恢复为 shared。
- 已存在的外部 lock 不会被自动删除。

共享状态的诊断细节不会把路径、原始异常、私有字段或 raw JSON 直接暴露给用户界面。

### 3.5 修复 TUI receiver binding 和 action queue

TUI 通过可选的 shared-state 方法更新 scope 和 target override。直接取出方法再调用会丢失 adapter 的 `this`，在 file-backed adapter 或 degraded adapter 上表现为设置更新失败或状态不同步。

修复使用带 receiver 的调用方式，并把 scope/override 更新统一放入现有串行 action queue。与此同时，快速重复的 reorder、target enable 和 parameter toggle 不再并发修改同一个旧快照：后一个 action 等待前一个完成，并基于最新值计算下一状态。

交互契约最终固定为：

- chain detail 中 `Enter` 打开选中真实目标的 `Target Settings`。
- `t` 打开独立的 `Chain Settings`。
- `p` 不执行动作。
- detail 中 `e` 修改全局真实目标 enabled。
- 主列表中 `e` 修改生成链 enabled。
- target override 的策略字段和四个参数开关都支持 `inherit`。

### 3.6 修复历史工具结果误判

重复出现的 `Tool execution failure.` 根因是扩展曾经从请求上下文尾部推断历史 `toolResult`，把历史工具错误当成当前 provider request 的 terminal failure。这个推断绕过了真实请求结果，也把 Pi 所有的工具执行责任错误归入扩展 provider 分类。

修复删除了历史 `hasTrailingToolExecutionError` 检查、dead `toolError`/tool-failure settlement 分支和 synthetic `Tool execution failure.` 路径。历史 `toolResult` 保持在传给真实目标的 request context 中；真实 provider 返回成功后，后续工具执行仍由 Pi 处理。扩展只根据当前 provider/delegate/transport/timeout/settlement 结果分类。

### 3.7 修复外层虚拟请求凭据穿透

虚拟 failover provider 接收到的外层 options 可能包含 `apiKey`、`env`、headers 和 `transformHeaders`。如果这些字段原样传给目标 provider，外层虚拟凭据和 header transform 可能覆盖真实目标的认证边界。

修复在每次真实目标 attempt 前明确丢弃 outer `apiKey`、`env`、`headers`、外层 signal、outer timeout 和 `transformHeaders`。外层 `onPayload`、`onResponse` 仍按请求生命周期参与，但真实 target auth 和目标原生 header 由目标 `ModelRuntime` 提供。测试覆盖跨 provider 尝试，确认虚拟凭据、外层敏感 header 和 transform 不会进入真实目标 options。

### 3.8 修复重试 off-by-one 和共享预算混淆

旧的“one continuation”描述不能表达当前实现。它既掩盖了 `maxRetries` 的确切定义，也容易让读者以为一个 chain traversal 共享一个 continuation budget。

当前定义是：`maxRetries=N` 表示初始 attempt 之后，对同一个精确真实目标最多再尝试 N 次。每次目标的失败计数、`nextEligibleAt` 和 cooldown 都按精确 `provider/model` 隔离。多个 Pi session/adapter 可以并发尝试同一真实目标；CAS/file lock 只协调共享状态写入，不分配目标所有权。以 `maxRetries=1` 为例，A 失败后可得到 A 的一次同目标 retry；A 再次失败后 A 进入 cooldown，路由继续到 B。B 成功时，B 的状态保持干净，未触及的 C 也保持不变。

如果一次链遍历中每个真实目标都确实失败，那么每个目标分别进入自己的 cooldown 是正确结果。这不是共享 chain budget 被一次性消费，而是精确 target coordination 的逐目标结算。

### 3.9 清理过时的目标占用语义

旧文档曾把共享状态描述成分配目标使用权，并把过时的请求占用生命周期当作当前机制。这与当前机制不符：多个 Pi session/adapter 可以并发使用同一真实 target，CAS/file lock 只负责跨进程写协调，不会锁定目标使用权。

当前保留的是 user-global exact-target 状态：`enabled`、consecutive failures、`nextEligibleAt`、cooldown、cumulative cooldown 和 manual recovery。取消只终止当前请求，不改变共享 target 状态。旧 runtime 数据中的 `lease` 字段只作为兼容输入读取，并在下一次写入时剥离。文件配置写入仍使用 filesystem lock；其 `releaseOwnedLock` 清理的是本次写入持有的文件锁。

### 3.10 修复 session history 的生命周期和输入边界

transition callback 需要在 provider 注册之前就稳定存在，因为子会话可能在没有 `session_start` 的情况下发起请求。另一方面，history 不能因为 extension reload 或 session resume 而丢失，也不能把未经验证的 custom entry 直接显示到终端。

修复后，稳定 callback 在 provider registration 前安装。每个扩展实例有自己的 `ModelRuntime`。`session_start` 会先 reload 并 apply 权威 v8 chain configuration，再恢复当前 session 的 namespaced custom history、设置 Footer/UI context 和决定是否允许 append；它不是 provider routing 的前置条件。配置 malformed、missing、future-version 或 registration degraded 时，provider routing 和编辑器 fail closed；恢复有效配置后才重新应用链和 revision。`/failover` 非 history 打开也会刷新权威配置；已经打开的 editor 不 live-watch 外部 revision，需要关闭重开，或触发 session refresh。

history 只接受固定 custom type、有限长度的模型引用/理由、合法时间戳、合法 reasoning 枚举，并拒绝 C0/C1 控制字符和 malformed data。重复条目去重，最多保留最新 100 条。持久 session 会 append custom entry，因此 reload 和 resume 可以恢复当前 session 历史；ephemeral session 只在内存中保留，不写 session 文件。

### 3.11 修复文档与实际通知面的偏差

实现通过 `onTarget`/`onTransition` 更新 Footer 和 history。没有独立的每次 transition popup，也没有调用消息注入接口，没有把 transition 写回模型上下文。文档因此改为描述两个实际可见面：Footer 当前目标/映射 reasoning，以及 `/failover history` 的 source、target、reason、local timestamp。

## 4. 当前架构

### 4.1 进程和运行时边界

每个 Pi extension instance 创建一个自有 target `ModelRuntime`，读取 `models.json` 和认证状态，且关闭网络 refresh。父会话、子会话/子代理和同用户独立进程不依赖子代理生命周期 patch；它们通过固定共享状态文件协调真实目标。

provider 在 extension 初始化期间完成 delegate、回调、config、metadata 和 shared adapter 设置后注册。这样，provider 在 session lifecycle hook 之前也可以处理请求。`session_start` 不是路由依赖，但除 session UI/history 生命周期外，也会 reload/apply 权威 v8 chain configuration；非 history `/failover` 打开执行同样的配置刷新。

### 4.2 配置层

`getAgentDir()/model-failover.json` 是 v8 生成配置的权威文件。其职责只有：

- 生成模型 id 和显示名；
- 生成链 enabled；
- 有序的真实 `provider/id` chain。

写入使用相邻独占 lock、源 revision 重读比较、同目录临时文件、flush 和 atomic rename。malformed、invalid、unreadable、future-version 和 revision conflict 都保留原始内容，不以默认值覆盖。

### 4.3 共享层

`~/.pi/agent/failover-state.json` 是固定用户级共享状态路径，不随 `PI_CODING_AGENT_DIR` 改变。其抽象包括：

- exact real target record：enabled、consecutive failures、`nextEligibleAt`、cooldown level/deadline、cumulative cooldown、manual recovery；legacy runtime `lease` 只作为兼容输入读取并在下一次写入时剥离；
- registration：agent directory 到 target/scope 引用的关系；
- chain scope：scope policy、scope targets、每个 target 的 inheritable override。

共享状态不保存凭据、消息或 raw Session ID。共享文件 adapter 对内存 transition 和 file CAS 使用同一套纯状态转换；file-backed 写失败后进入 degraded，并阻止后续协调操作。

### 4.4 策略解析

scope policy 包括 error handling mode、max retries、no-progress timeout、reasoning effort 和四个独立参数 toggle。target override 对这些字段使用 `inherit` 或显式值。每次 target attempt 先读取精确目标的 global enabled/runtime，再将 scope policy 与选中 target override 合并，形成一次请求的 effective settings。

global target enablement、manual recovery、cooldown、consecutive failures, `nextEligibleAt` 和 cumulative cooldown 不属于 scope override。一个 scope 修改策略不会改写另一个 scope 对同一真实目标的 override；但全局目标运行状态仍然共享。

### 4.5 请求参数边界

对 OpenAI Responses、Chat Completions、Azure Responses 和被识别为 OpenAI-compatible 的 OpenRouter 路径，Pi adapter 先构建原生 payload，再等待 outer async `onPayload`，扩展最后应用自己的 request parameter policy。Responses 使用 `reasoning.effort`，Chat Completions 使用 `reasoning_effort`。`off` 映射为目标支持的关闭值；不存在 reasoning 支持时，Footer 显示 `unsupported`。

prompt cache key 使用带命名空间的 SHA-256 摘要，输入包含固定前缀和 Pi Session ID，网络边界只出现 64 位小写 hex digest。session-affinity header 会替换为同一摘要并保留原 header spelling。`cacheRetention:none` 不发送 cache key、retention 或 affinity。

结构化 HTTP 400/422 如果明确拒绝 `prompt_cache_key` 或 `prompt_cache_retention`，扩展只为精确 target/API 记忆被拒绝字段，并进行有界的 compatibility retry。该 retry 不消费普通 maxRetries；重复拒绝已删除字段时回到正常失败策略。disabled toggle 不进入 negotiation。

## 5. 迁移与持久化设计

### 5.1 v1-v7 到 v8

支持版本 v1-v7 的输入解析。v8 projection 去除旧策略字段，但不会丢弃它们：这些字段先转成 legacy candidates，交由 shared-state 的 first-wins reconciliation 初始化真实目标和 scope。

迁移必须满足以下条件才可提交：

- legacy 配置完整可解析；
- 真实目标引用合法且没有 unsafe map key；
- shared registration 和 scope registration 成功；
- shared coordination status 为 shared；
- v8 写入 CAS 成功；
- 写入后 v8 reload 成功；
- reload 后再次 reconcile/refresh 成功。

任何条件失败都保持原始配置字节，provider config 置为空或保持 blocked 状态，TUI 编辑入口不允许继续写。报告不包含受保护的原始配置、模型名称或旧 manual recovery 原因。

### 5.2 共享状态恢复

共享状态读取失败时，扩展可以保留最后安全快照用于诊断显示，但不能用该快照执行新的 target attempt 或写操作。恢复流程必须重新读取 canonical document，并在 degraded 状态通过写探针和 revision verification。成功后 status 回到 shared，才能恢复 routing/TUI mutation。

### 5.3 已验证的受保护状态不变量

本轮只记录经过 sanitize 的统计结论，不复制共享文件内容：

- 生成模型数量：5；
- scope 数量：5；
- target reference 总数：29；
- 缺失 scope：0；
- 所有 target override 字段均为 `inherit`；
- 所有 scope settings 与各自当前第一目标 settings 一致；
- global enabled、活动协调、cooldown、failure tracking 和 manual recovery 保持在 scope 之外，具体值未披露。

没有在报告中写入模型名称、raw JSON、provider 错误原文或 manual recovery 原因等受保护运行时内容。

## 6. 重试、冷却和租约行为

### 6.1 Pi 原生 retry 与扩展 retry 的边界

Pi 仍然负责它能识别的 transient provider retry、计数和 backoff。扩展等待 settled 结果，不创建第二套竞争性的 Pi native retry loop。扩展的 maxRetries 是独立的同目标重试预算，默认新建值为 5，合法范围由实现校验。

- `smart`：持久错误进入 manual recovery 并切换；其他 automatic failure 是否重试由有效策略和预算决定。
- `switch`：不做同目标重试，直接进入目标结算和链推进。
- `retry`：对 automatic failure 按有效预算重试，退避为 1s、2s、4s，之后指数增长并封顶 60s。

### 6.2 精确目标预算

每次真实目标 attempt 都按精确目标维护自己的失败计数和 cooldown 状态。`maxRetries=N` 的计数从初始 attempt 之后开始，最多允许 N 次同目标 retry；预算耗尽后才进入 cooldown 或推进。多个 request/adapter 可并发执行，CAS/file lock 协调共享状态写入。

验证过的 A,A,B 场景为：A 首次失败、A 按 `maxRetries=1` 重试、A 再失败并进入自己的 cooldown、B 成功。B 的运行状态保持成功前的干净状态，C 等未触及目标保持不变。另有测试验证共享预算可以跨不同 request/adapter 观察到同一精确目标的状态，但不会跨目标混用。

### 6.3 冷却 ladder

cooldown ladder 为 10、20、40、60、90、180、360 分钟，最后一档封顶。retry-eligible automatic failure 在同目标预算耗尽后进入 ladder；同目标 retry 阶段不会提前推进 ladder。成功或 reset 清除 active coordination 和 cumulative cooldown。另一个目标的 failure 不会改变当前目标的 ladder。

如果一个 chain 中所有真实目标都真实失败，那么多个目标在同一 traversal 中分别进入 cooldown，属于正确的逐目标结果。被 `nextEligibleAt`、cooldown 或 manual recovery 阻塞的目标会被跳过，不消耗普通 retry budget。

### 6.4 并发与取消

多个 Pi session/adapter 可以并发使用同一真实 target。CAS/file lock 只协调跨进程共享状态写入；不存在目标占用、所有权、释放或续期生命周期。取消终止当前请求并停止路由，不修改目标运行状态。legacy persisted runtime 的 `lease` 字段仅兼容读取，下一次写入剥离。

## 7. 子代理与 provider 错误的诊断边界

历史日志中曾出现 subagent/provider warning，包括 provider API error。不能从这些历史 warning 单独证明每一次上游 API 错误都是扩展造成的；上游 provider 的确切原因可能来自认证、服务端、网络、模型能力或请求参数。

本轮能确定的是扩展侧存在并已修复的风险：

- outer virtual request 的 `apiKey`、`env`、headers 和 header transform 可能覆盖真实目标 auth；
- degraded coordination 可能被误当成可继续路由的本地状态；
- 旧实现/旧文档曾把请求并发控制描述为目标占用；
- 历史 tool result 可能被误推断成 terminal `Tool execution failure.`；
- retry count 可能存在 off-by-one 或被误写成共享 continuation budget；
- history/control/error surfaces 可能暴露原始敏感信息。

这些扩展侧原因现在分别由目标 ModelRuntime auth、fail-closed coordination、删除历史 tool-failure inference、精确 per-target retry settlement 和 sanitized output 处理。修复后的后续 failover/sunian workers 已成功完成，但这只能证明扩展侧回归路径已恢复，不能倒推历史每条 provider API warning 的上游根因。

## 8. 安全与受保护状态处理

### 8.1 凭据边界

扩展不编辑 `models.json`，不把 API key、token、auth header、env secret 写入生成配置或共享状态。虚拟 failover provider 的 outer credentials 不向真实目标转发；真实目标认证由它自己的 `ModelRuntime` 和 Pi 认证系统解析。

### 8.2 Session ID 与缓存 key

raw Session ID 不写入 shared state、history payload 或 failover header。cache key 使用固定命名空间 SHA-256 digest。当前 session history 只保存受限的模型引用、reasoning 元数据、理由和时间戳；不保存消息上下文。

### 8.3 输出清理

provider error、transition reason、manual recovery reason 和 history field 都经过长度限制、凭据模式 redaction 和控制字符过滤。C0/C1 字符、OSC/CSI 等 terminal injection 内容被剥离或拒绝。malformed custom entry、控制字符、错误类型、过长字段、非法 timestamp 和错误 custom type 不会进入 history panel。

### 8.4 文件安全

配置和共享状态写入使用独占 filesystem lock、CAS、同目录临时文件和 atomic rename。`releaseOwnedLock` 只清理当前写入操作持有的文件锁；外部 lock 不自动删除，临时文件只清理本 invocation 成功创建且归属明确的对象。shared write failure、CAS exhausted 和 revision conflict 均 fail closed，不以未验证的本地文档替代持久化事实。

## 9. TUI 与 session history

TUI 主列表和 detail target chain 保持 20 行 viewport 和可见范围；Add-target candidate 模型行数直接读取 Pi 的 `autocompleteMaxVisible`，说明文字不占用这部分模型行数。所有渲染行仍按可用宽度裁剪。快速按键通过 action queue 串行化，覆盖 reorder、target enabled 和 parameter override。

`/failover history` 显示当前 Pi session 的最近切换，包含 source、target、reasoning 映射、reason 和本地时间。历史最多 100 条，按最新优先。持久 session 使用 namespaced Pi custom entries 跨 extension reload/session resume 恢复；ephemeral session 只保留内存历史，不 append custom entry。history entry 不进入模型 context。

Footer 只显示扩展实际维护的状态，例如真实目标和当前映射 reasoning；不存在独立 transition popup，也不会改变 Pi 自己的 thinking setting。reasoning toggle 关闭时，扩展不发送或重写该参数，并显示 `inherited` 语义。

## 10. 测试与验证证据

### 10.1 必要命令

```bash
node --loader ./test/typescript-loader.mjs --test test/*.test.ts
node ./node_modules/typescript/lib/tsc.js --noEmit --pretty false
git diff --check -- README.md DESIGN.md docs/development-report-2026-08-25.md
```

观察结果：

- 最终完整 custom-loader suite：`208/208` 通过；
- primary LSP diagnostics：7 个核心文件 0 findings；
- TypeScript：`node ./node_modules/typescript/lib/tsc.js --noEmit --pretty false` 通过；
- `git diff --check`：通过；
- Markdown fence/trailing-whitespace 检查：通过；
- 过时机制 grep：确认目标文档不再把目标使用描述为独占、可释放或可续期；同时确认保留 filesystem lock 与 `releaseOwnedLock` 语义。

本次 Add-target TUI 边界与直接搜索回归观察：主列表和 detail target chain 保持 20 行 viewport；候选模型行数直接读取 Pi 的 `autocompleteMaxVisible`，说明文字不占用这部分模型行数，所有渲染行仍按可用宽度裁剪。候选打开后直接输入按 `provider/model` 大小写不敏感过滤，Backspace 删除，Up/Down 滚动，Enter 添加，Esc 先清空搜索再关闭；无匹配时显示提示且禁止添加。

Node 测试运行期间可能出现预期的 experimental loader warning；没有测试失败。

### 10.2 覆盖范围

| 领域 | 已验证行为 |
| --- | --- |
| v8 首轮 | 写入空配置，不改写 `models.json` |
| v1-v7 迁移 | shared-first、候选 first-wins、源字节保护、CAS conflict 阻断 |
| 共享状态 | strict schema、revision、CAS、lock、write failure、degraded recovery |
| 注册生命周期 | target union/canonicalization、scope 创建/删除、并发共享状态协调 |
| scope policy | 第一目标初始化、全字段 inherit、effective merge、跨链隔离 |
| request settlement | effective policy snapshot、retry、cooldown、manual recovery、cancellation |
| 重试隔离 | A,A,B、预算精确计数、不同 target 独立状态、不同 adapter 共享目标状态 |
| 请求参数 | async onPayload 顺序、cache negotiation、disabled passive toggles、非 OpenAI 保持不变 |
| 凭据安全 | outer virtual credential/header transform 隔离、authorization/token redaction |
| 工具边界 | 历史 toolResult 保留上下文，不合成工具失败，真实 Pi tool failure 不由 provider router 分类 |
| TUI | Enter/t/p/e 语义、viewport、rapid action queue、receiver binding |
| history | session restore、current-session persistence、100 条上限、去重、控制字符和坏数据拒绝 |

## 11. 接受矩阵

| 接受项 | 结果 | 证据/边界 |
| --- | --- | --- |
| 首轮为空 | 通过 | `index.test.ts` 首轮 empty v8 regression |
| v8 只保存链身份 | 通过 | generated-config v8 exact schema tests |
| 迁移 shared-first | 通过 | v5/v6/v7 migration tests；失败保留源字节 |
| 协调故障 fail closed | 通过 | malformed/write/lock/CAS/degraded routing and editor tests |
| 共享真实目标运行状态 | 通过 | shared-state and cross-adapter provider tests |
| scope 与 target override 隔离 | 通过 | scope seed/inherit/cross-chain tests |
| request-time policy snapshot | 通过 | scope update after request start uses the request's effective settings |
| 并发目标使用与取消 | 通过 | cross-adapter shared state、cancellation、legacy runtime-field compatibility tests |
| 精确 maxRetries | 通过 | max retry budget and A,A,B isolation tests |
| cooldown ladder | 通过 | all rungs、cap、success/reset tests |
| 历史 toolResult 不误判 | 通过 | provider tool-context regression |
| Pi tool failure 不归类 | 通过 | routing only classifies current provider/delegate result |
| outer auth 不穿透 | 通过 | cross-provider credential boundary tests |
| history 可恢复 | 通过 | namespaced custom entry restore/current session tests |
| history 安全 | 通过 | malformed/control/bad data/dedup/bound tests |
| TUI 键位和队列 | 通过 | Enter/t/p/e and rapid action tests |
| reasoning 边界 | 通过 | target request mapping；不修改 Pi 自己的 thinking setting |
| 文档验证 | 通过 | fence/trailing whitespace、diff check、stale grep |

## 12. 已知限制

1. Pi provider adapter 内部的 retry count/backoff 仍由 Pi 控制；扩展不替换该机制。
2. Pi tool execution 在 provider 成功返回后发生，因此其失败不进入扩展 provider classifier，也不会触发扩展目标切换。
3. 真实 provider 网络服务、服务端能力和上游 API warning 的确切根因无法仅由本地测试证明；本次 isolated `failover/orc-peon` smoke 已通过真实 Pi/provider authentication，但没有强制 first-target failure 或验证自动 target switch；本轮其余故障矩阵验证的是扩展侧边界和本地 doubles。
4. reasoning effort 只在真实 provider request boundary 映射；Pi 自己的 thinking setting 不由扩展修改。
5. ephemeral session 的 history 不会落盘；只有具有 session file 的当前 session 才 append namespaced custom entries。
6. 共享状态损坏或无法写入时，用户必须修复共享文件并重新打开 `/failover` 或重启；扩展不会绕过共享协调继续自动路由。
7. direct restore 不发送测试请求。

## 13. 文件清单

### 实现

- `src/generated-config.ts`：v8 chain-only schema、严格读取、v1-v7 projection、源 revision 保存。
- `src/shared-state.ts`：固定共享状态、target runtime、registrations、scope/override、request settlement、CAS/file lock、fail-closed degraded status 和 legacy runtime-field compatibility。
- `src/provider.ts`：真实目标选择、Pi settled 后的 provider failure 分类、精确目标重试/冷却、请求参数边界、credential drop 和 history tool-result 修复。
- `src/index.ts`：全局扩展注册、owned ModelRuntime、首轮空配置、迁移编排、scope key、Footer/history callback、共享状态刷新和 TUI action binding。
- `src/tui.ts`：chain/target settings 分离、Enter/t/p/e 键位、20 行 viewport、串行 action queue 和快速输入状态保护。
- `src/state.ts`：failure classification、retry delay、cooldown ladder 和请求级进度辅助函数。
- `src/request-params.ts`：OpenAI-compatible reasoning/cache/affinity 参数、Session ID digest 和字段 negotiation 辅助。
- `src/types.ts`、`src/config.ts`、`src/json-file.ts`、`src/models-catalog.ts`：共享类型、默认值、文件原子写和目标元数据边界。

### 测试

- `test/generated-config.test.ts`：v8 exact schema、旧版本转换和非法输入。
- `test/index.test.ts`：首轮、迁移、blocked/degraded、TUI integration、session history 和跨实例状态。
- `test/provider.test.ts`：provider classification、request boundary、credential isolation、retry/cooldown、tool context、concurrent target use 和 exhaustion。
- `test/shared-state.test.ts`：schema、CAS、file lock、registration、scope、effective policy snapshot、legacy runtime-field compatibility、retry/cooldown 和 fail-closed 行为。
- `test/tui.test.ts`：viewport、Enter/t/p/e、receiver/action queue 和 rapid input。
- `test/config.test.ts`、`test/request-params.test.ts`、`test/state.test.ts`、`test/models-catalog.test.ts`、`test/catalog.test.ts`：旧配置、请求参数、错误分类、目录读取和目标去重。

### 文档

- `README.md`：面向用户的安装、v8 配置、TUI、请求边界、失败策略和验证命令。
- `DESIGN.md`：架构、状态机、共享状态、持久化、安全边界、接受清单和已知限制。
- `docs/development-report-2026-08-25.md`：本次实现的 bug-first 记录、迁移、诊断边界、受保护状态处理和完整验收证据。

## 14. 文档决策与未决歧义

已作出的文档决策：

- 使用“真实目标”指代精确 `provider/model`，使用“生成链”指代 v8 generated model，避免把两种状态混称为 model。
- 使用“有效 scoped retry budget”描述所有 automatic failure 的同目标重试，不再使用 one continuation 或 one-shot 状态名。
- 将 Pi tool execution 明确放在 provider classifier 之外；历史 `toolResult` 只描述为 request context。
- 将 transition 的可见面限定为 Footer 和当前 session history，不声称 popup、消息注入或修改 Pi thinking setting。
- 对共享状态故障统一使用 fail-closed 表述，不公开 raw path、raw JSON、模型名或原始敏感 reason；legacy `lease` 仅作为兼容输入描述。

仍需保留的实际限制只有：上游历史 provider warning 的精确根因无法证明，本地测试不能替代真实 provider 网络 smoke test。除此之外，本次文档范围内没有需要人工选择的实现歧义。
