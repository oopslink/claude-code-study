# Task 04：Agent 核心循环深度精读

> 精读日期：2026-03-31
> 精读文件：query.ts / QueryEngine.ts / services/api/claude.ts / utils/messages.ts / cost-tracker.ts

---

## 一、问题逐一解答

### Q1：`query()` 的完整签名与返回类型

```typescript
// src/query.ts L219-238
export async function* query(
  params: QueryParams,
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
>
```

`QueryParams`（L181-199）包含以下字段：

| 参数 | 类型 | 说明 |
|------|------|------|
| `messages` | `Message[]` | 当前对话历史 |
| `systemPrompt` | `SystemPrompt` | 系统提示词 |
| `userContext` | `{[k: string]: string}` | 用户侧上下文 KV |
| `systemContext` | `{[k: string]: string}` | 系统侧上下文 KV |
| `canUseTool` | `CanUseToolFn` | 工具权限检查函数 |
| `toolUseContext` | `ToolUseContext` | 工具使用上下文（含 tools、model、options 等） |
| `fallbackModel?` | `string` | 模型降级目标 |
| `querySource` | `QuerySource` | 请求来源标识（用于分析和缓存策略） |
| `maxOutputTokensOverride?` | `number` | 覆盖最大输出 token 数 |
| `maxTurns?` | `number` | 最大轮次限制 |
| `skipCacheWrite?` | `boolean` | 跳过缓存写入 |
| `taskBudget?` | `{ total: number }` | API 级 token 预算 |
| `deps?` | `QueryDeps` | 可注入的依赖（测试用） |

返回类型是 **`AsyncGenerator`**（不是 Promise），通过 `yield*` 委托给内部的 `queryLoop()` 异步生成器，返回值（`Terminal`）表示退出原因。

---

### Q2：tool use 循环的代码结构

核心在 `queryLoop()` 函数（L241 起），采用 **`while (true)` + 状态机迭代** 模式，而非递归。每次迭代对应一个 API 请求轮次。

伪代码描述：

```
// 外层是一个无限循环（L307）
while (true) {
  // === 1. 准备工作 ===
  messagesForQuery = getMessagesAfterCompactBoundary(messages)
  // 应用 snip / microcompact / contextCollapse / autocompact
  // 构造 fullSystemPrompt

  // === 2. 流式调用 API（L659 for await）===
  for await (message of deps.callModel({ messages, ... })) {
    if (message.type === 'assistant') {
      assistantMessages.push(message)
      // 检测 tool_use blocks
      if (msgToolUseBlocks.length > 0) {
        toolUseBlocks.push(...msgToolUseBlocks)
        needsFollowUp = true  // <-- 关键标志
      }
    }
    yield message  // 转发给上层消费者
  }

  // === 3. 判断是否需要工具调用后续 ===
  if (!needsFollowUp) {
    // 执行 stop hooks、token budget 检查等
    return { reason: 'completed' }  // <-- 正常退出
  }

  // === 4. 执行工具（L1380-1408）===
  const toolUpdates = streamingToolExecutor
    ? streamingToolExecutor.getRemainingResults()
    : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

  for await (const update of toolUpdates) {
    yield update.message        // 产出工具执行进度
    toolResults.push(update.message)  // 收集工具结果
  }

  // === 5. 检查中止、附件注入、maxTurns 检查 ===
  if (aborted) return { reason: 'aborted_tools' }
  if (maxTurns && nextTurnCount > maxTurns) return { reason: 'max_turns' }

  // === 6. continue 下一轮（L1715-1728）===
  state = {
    messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
    turnCount: nextTurnCount,
    // ... 其他状态重置
    transition: { reason: 'next_turn' },
  }
  // 回到 while (true) 顶部，toolUseBlocks / toolResults 在下一轮迭代开头重置
}
```

**关键设计**：`assistantMessages`、`toolResults`、`toolUseBlocks`、`needsFollowUp` 在每次迭代开头声明为局部变量（L551-558），作用域天然隔离，无需手动清空。

---

### Q3：循环终止条件

`queryLoop()` 通过 `return { reason: ... }` 退出 `while (true)` 循环，共有以下退出点：

| 退出原因 | 位置（行号） | 触发条件 |
|---------|-------------|---------|
| `blocking_limit` | L647 | 上下文超过硬性限制且未开启自动压缩 |
| `model_error` | L996 | API 调用抛出未处理异常 |
| `aborted_streaming` | L1051 | 流式接收时用户取消（abort 信号触发） |
| `image_error` | L1175 | 图片/媒体大小错误且恢复失败 |
| `prompt_too_long` | L1182 | 413 错误且压缩恢复失败 |
| `completed` | L1264 | 最后消息是 API 错误（限流、认证失败等） |
| `stop_hook_prevented` | L1279 | stop hook 主动阻止继续 |
| `aborted_tools` | L1515 | 工具执行过程中用户取消 |
| `hook_stopped` | L1520 | hook 指示停止 |
| `max_turns` | L1711 | 达到 `maxTurns` 限制 |
| `completed` | L1357 | 正常完成（`!needsFollowUp` 且 stop hooks 通过） |

**注意**：`needsFollowUp === false` 本身不直接 return，要经过 stop hook 处理、token budget 检查后才真正 return `completed`。

---

### Q4：流式响应在 query.ts 中的消费方式

使用 **`for await...of`** 迭代 `deps.callModel(...)` 返回的 AsyncGenerator（L659）：

```typescript
// L659-708
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  thinkingConfig: ...,
  tools: ...,
  signal: toolUseContext.abortController.signal,
  options: { model, querySource, ... },
})) {
  // 处理每个 yielded message
  if (message.type === 'assistant') {
    assistantMessages.push(message)
    // 检测 tool_use blocks
  }
  yield yieldMessage  // 向外层转发
}
```

`deps.callModel` 默认指向 `queryModelWithStreaming`（`src/services/api/claude.ts`），它内部对 Anthropic SDK 的 SSE 流进行 `for await...of`（claude.ts L1940）。

整个数据流是一条 **AsyncGenerator 链**：
```
claude.ts SSE stream
  → queryModel() AsyncGenerator
    → queryModelWithStreaming() AsyncGenerator
      → query() 的 for await
        → yield 给外层消费者（UI/SDK）
```

---

### Q5：abort 信号的传入与检测点

**传入路径**：
1. 外部通过 `QueryEngine.config.abortController` 传入（`QueryEngine.ts L203`）
2. `QueryEngine.interrupt()` 调用 `this.abortController.abort()`（`QueryEngine.ts L1158`）
3. `signal` 通过 `toolUseContext.abortController.signal` 传入 `query()`
4. `query()` 将 `signal` 传给 `deps.callModel()` 的 `options.signal`
5. `claude.ts` 中将 `signal` 传给 SDK API 调用（L1825）

**检测点**（多层防御）：
1. `withRetry.ts L190`：每次重试前检查 `options.signal?.aborted`
2. `claude.ts L2434`：`for await (const part of stream)` 退出后检查，若是 `APIUserAbortError` 且 `signal.aborted` 则为真实用户取消
3. `query.ts L1015`：流式循环结束后检查 `abortController.signal.aborted`，处理正在执行的 tool results
4. `query.ts L1485`：工具执行完成后再次检查

---

### Q6：`QueryEngine` 构造函数接收的依赖

```typescript
// QueryEngine.ts L184-207
export class QueryEngine {
  private config: QueryEngineConfig
  private mutableMessages: Message[]
  private abortController: AbortController
  private permissionDenials: SDKPermissionDenial[]
  private totalUsage: NonNullableUsage
  private readFileState: FileStateCache
  private discoveredSkillNames = new Set<string>()
  private loadedNestedMemoryPaths = new Set<string>()

  constructor(config: QueryEngineConfig) {
    this.config = config
    this.mutableMessages = config.initialMessages ?? []
    this.abortController = config.abortController ?? createAbortController()
    this.permissionDenials = []
    this.readFileState = config.readFileCache
    this.totalUsage = EMPTY_USAGE
  }
}
```

`QueryEngineConfig`（L130-173）注入的主要依赖：

| 字段 | 类型 | 说明 |
|------|------|------|
| `cwd` | `string` | 工作目录 |
| `tools` | `Tools` | 工具列表 |
| `commands` | `Command[]` | 斜杠命令列表 |
| `mcpClients` | `MCPServerConnection[]` | MCP 服务器连接 |
| `agents` | `AgentDefinition[]` | 子 Agent 定义 |
| `canUseTool` | `CanUseToolFn` | 权限检查函数 |
| `getAppState / setAppState` | 函数 | 应用状态读写 |
| `readFileCache` | `FileStateCache` | 文件状态缓存 |
| `abortController?` | `AbortController` | 外部注入的取消控制器 |
| `snipReplay?` | 函数 | HISTORY_SNIP 功能的回调（feature-gated） |

---

### Q7：`submitMessage()` 内部调用 `query()` 的方式

```typescript
// QueryEngine.ts L675-686
for await (const message of query({
  messages,
  systemPrompt,
  userContext,
  systemContext,
  canUseTool: wrappedCanUseTool,
  toolUseContext: processUserInputContext,
  fallbackModel,
  querySource: 'sdk',
  maxTurns,
  taskBudget,
})) {
  // 处理每个 message
}
```

额外封装逻辑：
1. **权限追踪**：`canUseTool` 被包装为 `wrappedCanUseTool`，在每次工具调用被拒绝时记录到 `this.permissionDenials`（L244-271）
2. **消息持久化**：assistant/user/compact_boundary 消息被 `recordTranscript()` 写入会话文件（L717-732）
3. **usage 累积**：`stream_event` 类型消息中的 token 用量通过 `accumulateUsage` 累积到 `this.totalUsage`（L812-815）
4. **maxBudgetUsd 检查**：每个消息处理后检查总成本是否超限（L972-1002）
5. **结果生成**：循环结束后，构造 `SDKMessage` 类型的 `result` 消息并 yield 给外部调用方（L1135-1155）

---

### Q8：重试逻辑

重试在 `withRetry.ts` 中实现，被 `queryModel()` 调用（claude.ts L1778）。

**触发重试的错误类型**（`shouldRetry()` 函数）：
- `429`（Rate Limit / 请求过多）
- `500`（Internal Server Error）
- `529`（Overloaded，服务器过载）
- 网络错误（ECONNRESET、EPIPE、超时等）
- Auth 错误（401、403）会刷新 token 后重试
- `413`（Context overflow）通过调整 `max_tokens` 重试

**不触发重试的错误**：
- 用户取消（`APIUserAbortError`）
- `400`（Bad Request，除 context overflow 外）
- 4xx 业务错误

**重试次数与退避策略**：
- 默认 `maxRetries`（由 `getDefaultMaxRetries()` 决定，通常为 10）
- 退避使用指数策略：`getRetryDelay(attempt, retryAfter)`，含 jitter
- `529` 连续超过阈值（`MAX_529_RETRIES`）后，若有 `fallbackModel` 则抛出 `FallbackTriggeredError`，触发模型降级（L346-351）
- **持久重试模式**（`isPersistentRetryEnabled()`）：对 429/529 无限重试，延迟上限 `PERSISTENT_RESET_CAP_MS`

重试时向外层 yield `SystemAPIErrorMessage`（`{type: 'system', subtype: 'api_error'}`），`QueryEngine` 将其转换为 `SDKMessage{type: 'system', subtype: 'api_retry'}`（L943-954）。

---

### Q9：`QueryEngine` 如何维护多轮对话历史

**消息存储位置**：`this.mutableMessages: Message[]`（QueryEngine 实例字段，L186）

**追加方式**：
1. 用户输入处理后：`this.mutableMessages.push(...messagesFromUserInput)`（L431）
2. `query()` 循环内，每个 `assistant` / `user` / `system(compact_boundary)` 消息：
   ```typescript
   // L716
   messages.push(message)          // 本轮局部副本
   this.mutableMessages.push(message)  // L768-786，永久存储
   ```

**多轮对话跨 `submitMessage()` 的连续性**：
- 每次 `submitMessage()` 调用时，从 `this.mutableMessages` 读取历史：
  ```typescript
  // L434
  const messages = [...this.mutableMessages]
  ```
- `query()` 收到的 `messages` 是带完整历史的快照
- `query()` 内部通过 `getMessagesAfterCompactBoundary(messages)` 裁剪到压缩边界之后（不修改原始数组）

---

### Q10：流式响应如何拼装成 AssistantMessage

在 `queryModel()` 函数中（`claude.ts L1017`），对 Anthropic SDK 返回的原始 SSE 流做 `for await (const part of stream)`（L1940），按事件类型处理：

**状态机处理流程**：

| SSE 事件 | 处理动作 |
|---------|---------|
| `message_start` | 初始化 `partialMessage`，记录初始 `usage`（仅 input tokens） |
| `content_block_start` | 在 `contentBlocks[index]` 初始化对应类型的 block（`text/tool_use/thinking/server_tool_use`），`input` 初始化为空字符串 |
| `content_block_delta` | 按 delta 类型追加内容：`text_delta` → `contentBlock.text +=`，`input_json_delta` → `contentBlock.input +=`（工具参数 JSON 流式拼接），`thinking_delta` → `contentBlock.thinking +=` |
| `content_block_stop` | **组装 `AssistantMessage` 并 yield**（L2192-2211）。此时 `usage.output_tokens` 还是 0 |
| `message_delta` | 写回最终 `usage`（含 output tokens）和 `stop_reason` 到已 yield 的 `lastMsg`（直接 mutation，L2244-2248），计算并上报成本（L2252-2256） |
| `message_stop` | 无特殊处理 |

**关键设计**：每个 `content_block` 对应一条独立的 `AssistantMessage`。`message_delta` 通过**直接属性 mutation**更新已 yield 消息的 `usage` 和 `stop_reason`（绕过对象替换，避免破坏 transcript 写队列持有的引用）。

**Chunk 类型总结**：
- `text`：普通文本回复
- `tool_use`：客户端工具调用（input 是 JSON 字符串，在 `content_block_stop` 时被 `normalizeContentFromAPI` 解析为对象）
- `thinking` / `redacted_thinking`：扩展思考内容
- `server_tool_use`：服务端工具（如 advisor）
- `connector_text`：连接器文本（feature-gated）

---

### Q11：token usage 的提取与上报

**提取位置**：`claude.ts` 的 `message_delta` 处理（L2214-2256）

```typescript
// claude.ts L2214
case 'message_delta': {
  usage = updateUsage(usage, part.usage)  // 累积 output tokens
  // ...
  // 写回已 yield 的 message
  lastMsg.message.usage = usage
  lastMsg.message.stop_reason = stopReason

  // 成本计算
  const costUSDForPart = calculateUSDCost(resolvedModel, usage)
  costUSD += addToTotalSessionCost(costUSDForPart, usage, options.model)
}
```

**`addToTotalSessionCost()` 做的事**（`cost-tracker.ts L278`）：
1. 调用 `addToTotalModelUsage()` 更新按模型分类的用量统计
2. 调用 `addToTotalCostState()` 更新全局累计费用
3. 通过 `getCostCounter()` / `getTokenCounter()` 写入 OpenTelemetry 指标（如果已配置）
4. 递归处理 advisor 工具的用量（若有）

**QueryEngine 侧的二次累积**（L789-815）：
```typescript
if (message.event.type === 'message_stop') {
  this.totalUsage = accumulateUsage(this.totalUsage, currentMessageUsage)
}
```
`this.totalUsage` 在最终 `result` 消息中对外暴露（L1148）。

---

### Q12：`normalizeMessagesForAPI()` 做了什么

**位置**：`utils/messages.ts L1989-2300+`

**为什么需要"normalize"**：应用内部维护的 `Message[]` 包含大量 UI 专用字段（`isMeta`、`isVirtual`、`isVisibleInTranscriptOnly` 等）和多种消息类型（`system`、`progress`、`attachment` 等），这些不能直接发给 API。

**主要处理步骤**：

1. **附件重排序**（`reorderAttachmentsForAPI`）：将 attachment 消息气泡到它们所属的 tool result 之后（attachment 本质上是补充上下文）

2. **过滤虚拟消息**：`.filter(m => !(m.isVirtual))`，虚拟消息是 REPL 内部展示用的（如子 Agent 的工具调用展示）

3. **过滤 progress / 非 local_command system 消息**：这些仅用于 UI 展示

4. **过滤合成 API 错误消息**（`isSyntheticApiErrorMessage`）：这类消息是 Claude Code 自己生成的错误展示，不应发给 API

5. **system local_command → user message 转换**：本地命令输出需要作为 user message 发给 API

6. **连续 user messages 合并**（`mergeUserMessages`）：Bedrock 不支持连续多条 user 消息

7. **tool_reference blocks 处理**：若 tool search 未启用，则从 tool_result content 中剥离 tool_reference blocks

8. **工具不可用 media 块剥离**：之前因 PDF/图片过大导致的错误，需要从源 user message 中删除对应的 document/image block

9. **assistant message 工具输入 normalize**：调用 `normalizeToolInputForAPI` 清理工具特定字段（如 ExitPlanMode 的 `plan` 字段）

10. **剥离 'caller' 字段**：若 tool search 未启用，从 tool_use blocks 中移除 `caller` 字段

---

## 二、完整调用链图

```
用户输入（prompt: string | ContentBlockParam[]）
  │
  ▼
QueryEngine.submitMessage()                         [QueryEngine.ts L209]
  │ 1. processUserInput() → 处理斜杠命令、附件等
  │ 2. this.mutableMessages.push(...messagesFromUserInput)
  │ 3. fetchSystemPromptParts() → 构建系统提示词
  │ 4. buildSystemInitMessage() → yield SDK 系统初始化消息
  │ 5. wrappedCanUseTool → 权限追踪包装
  │
  ▼
for await (message of query({ messages, systemPrompt, ... }))   [QueryEngine.ts L675]
  │
  ▼
query()                                             [query.ts L219]
  │ → yield* queryLoop()
  │
  ▼
queryLoop() —— while (true) ——                     [query.ts L241]
  │
  ├─▶ 每轮开始：
  │   │ applyToolResultBudget()       截断超大 tool result
  │   │ snipCompactIfNeeded()         HISTORY_SNIP 压缩
  │   │ microcompact()                微压缩（缓存级）
  │   │ applyCollapsesIfNeeded()      上下文折叠
  │   │ autocompact()                 自动压缩（大上下文）
  │   │ yield stream_request_start
  │   │
  │   ▼
  │  for await (message of deps.callModel(...))      [query.ts L659]
  │   │   ↓
  │   │  queryModelWithStreaming()                   [claude.ts L752]
  │   │   │   ↓
  │   │  queryModel()                               [claude.ts L1017]
  │   │   │   ↓
  │   │  withRetry() ── 重试循环                    [withRetry.ts L170]
  │   │   │   ↓ 每次尝试
  │   │   │  anthropic.beta.messages.create({ stream: true })
  │   │   │   ↓ 获取 Stream<BetaRawMessageStreamEvent>
  │   │   │  for await (const part of stream)       [claude.ts L1940]
  │   │   │   ├─ message_start → 初始化 partialMessage、usage
  │   │   │   ├─ content_block_start → 初始化 contentBlocks[i]
  │   │   │   ├─ content_block_delta → 追加文本/JSON/thinking
  │   │   │   ├─ content_block_stop → 组装 AssistantMessage，yield
  │   │   │   ├─ message_delta → 写回 usage/stop_reason，上报成本
  │   │   │   └─ message_stop → 无操作
  │   │   │  yield 每个 StreamEvent
  │   │
  │   ├─ message.type === 'assistant'：
  │   │   assistantMessages.push(message)
  │   │   if (tool_use blocks) → needsFollowUp = true
  │   │
  │   └─ yield message 给 QueryEngine
  │
  ├─▶ 如果 !needsFollowUp：
  │   │ handleStopHooks() → stop hook 检查
  │   │ checkTokenBudget() → token budget 检查
  │   └─ return { reason: 'completed' }           ← 正常退出
  │
  └─▶ 如果 needsFollowUp：
      │
      ▼
    工具执行阶段                                   [query.ts L1380]
      │ runTools() 或 streamingToolExecutor.getRemainingResults()
      │   ↓
      │  for await (update of toolUpdates)
      │   yield update.message                     ← 工具进度/结果
      │   toolResults.push(update.message)
      │
      ├─ 检查 aborted → return { reason: 'aborted_tools' }
      ├─ 检查 maxTurns → return { reason: 'max_turns' }
      │
      ▼
    state = {
      messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
      turnCount: nextTurnCount,
      transition: { reason: 'next_turn' },
    }
    ── continue 到 while (true) 下一轮 ──         [query.ts L1715-1728]


QueryEngine 消费层（for await 内）               [QueryEngine.ts L686+]
  │ assistant → this.mutableMessages.push() + recordTranscript() + yield SDK message
  │ user → this.mutableMessages.push() + yield SDK message
  │ stream_event(message_stop) → accumulateUsage() 到 this.totalUsage
  │ attachment(max_turns_reached) → yield result{subtype:'error_max_turns'}
  │ system(api_error) → yield SDK api_retry 消息
  │ 检查 maxBudgetUsd → 超限则 yield result{subtype:'error_max_budget_usd'}
  │
  ▼
循环结束后：
  isResultSuccessful() 检查 → 失败则 yield error_during_execution
  成功则 yield result{ subtype: 'success', result: textResult, ... }
```

---

## 三、错误/重试处理层次图

```
层次 1：query.ts 内层 try-catch（L652-997）
  ├─ FallbackTriggeredError → 切换模型，重置状态，continue 外层循环
  └─ 其他错误 → yield AssistantAPIErrorMessage，return { reason: 'model_error' }

层次 2：withRetry.ts（L170-800）
  ├─ 401/403(auth) → 刷新 token，重新创建 client，重试
  ├─ 429 / 529 → 指数退避重试，yield SystemAPIErrorMessage
  ├─ 529 连续过多 + fallbackModel → 抛 FallbackTriggeredError
  ├─ 413(context overflow) → 调整 max_tokens，重试
  └─ 其他不可重试错误 → 抛 CannotRetryError

层次 3：query.ts 上层恢复（不退出循环，而是 continue）
  ├─ 413 prompt_too_long → contextCollapse drain 或 reactiveCompact，continue
  ├─ max_output_tokens → escalate 到 64k 或注入 recovery message，continue
  └─ stop hook blocking error → 追加错误 message，continue
```

---

## 四、模式卡片草稿

## 模式卡片 #1：流式响应 + 工具调用循环

**问题**：如何在流式输出中处理工具调用并维持多轮对话？在 LLM 流式响应尚未完成时，如何高效地执行工具并将结果注入下一轮上下文？

**方案**：基于 AsyncGenerator 链 + 状态机循环的设计

核心文件与行号：
- `query.ts L241-1729`：外层 `while (true)` 循环，状态机 `State` 对象驱动迭代
- `query.ts L659-863`：`for await (message of deps.callModel(...))` 消费流，检测 `tool_use` blocks
- `claude.ts L1940-2304`：原始 SSE 流处理，`content_block_stop` 时组装并 yield `AssistantMessage`
- `query.ts L1380-1408`：工具执行，`runTools()` 或 `StreamingToolExecutor`
- `query.ts L1715-1728`：`state = {...}` 更新，注入 `toolResults` 到下一轮 `messages`

**关键设计决策**：

1. **为什么 query.ts 和 QueryEngine 要分离？**
   - `query()` 是纯粹的"一次 agent 轮次执行"原语，只关心消息流转和工具循环
   - `QueryEngine` 是"会话管理者"，负责持久化历史（`mutableMessages`）、跨轮 usage 累积、SDK 消息格式转换、权限追踪等"基础设施"关切
   - 这种分离使 `query()` 可独立测试（通过 `deps` 注入），`QueryEngine` 可被不同入口点复用（`ask()` 函数和直接使用 SDK 路径均通过 `QueryEngine`）

2. **为什么 `query()` 是 AsyncGenerator 而不是普通 async 函数？**
   - 多轮工具调用可能持续数分钟，UI 需要实时看到每步进度（文本 delta、工具执行状态、思考块）
   - 返回 `Promise<FinalResult>` 会丢失所有中间状态，导致 UI 无法显示进度
   - AsyncGenerator 允许"生产者-消费者"解耦：`queryLoop` 按需 yield，`QueryEngine` 按需消费并转发，UI 层（REPL / SDK）通过 `for await` 渲染
   - **`return Terminal`**（Generator 的 done 值）携带退出原因，不必在 yield 流中混入控制信号

3. **工具调用结果如何重新注入 messages？**
   - 工具执行后，结果作为 `UserMessage`（包含 `tool_result` content block）被推入 `toolResults` 数组
   - 循环底部（L1716）：`state.messages = [...messagesForQuery, ...assistantMessages, ...toolResults]`
   - 下一轮迭代顶部：`messagesForQuery = getMessagesAfterCompactBoundary(state.messages)` 获取最新历史
   - 发送给 API 前：`normalizeMessagesForAPI()` 将内部格式转换为 API 格式（合并连续 user messages、过滤 UI-only 消息等）

**适用条件**：
- 需要"模型 → 工具 → 模型 → 工具 → ..."这类多轮 agentic 循环的系统
- 需要对外提供实时进度流的场景（流式 UI、SDK streaming）
- 工具执行时间不可预测（文件操作、bash 命令、网络请求）

**权衡**：

- **优点**：
  - 流式输出用户体验好，无感知延迟
  - Generator 链天然支持背压（消费方 `for await` 控制拉取节奏）
  - 循环迭代式（非递归）避免深调用栈，状态集中在 `State` 对象便于调试
  - `deps` 注入使单元测试可替换 `callModel`，无需 mock HTTP
  - 多层错误恢复（压缩恢复、max_output_tokens 恢复、fallback model）在循环内透明处理

- **缺点/局限**：
  - 代码复杂度高：`queryLoop` 单函数约 1500 行，状态机有 11 个不同退出条件
  - `content_block_stop` 时 yield message，但 `message_delta` 才有完整的 usage/stop_reason，依赖直接属性 mutation 补丁，有时序耦合
  - 流式执行工具（`StreamingToolExecutor`）在 fallback 时需要 `discard()` 重置，增加了状态管理复杂度
  - `normalizeMessagesForAPI` 在每轮迭代都运行，对长会话有一定 CPU 开销

**我的项目如何应用**：（留空，供后续填写）

---

## 五、补充：关键设计细节

### 5.1 `while(true)` vs 递归

Claude Code 早期版本使用递归（代码注释中有"recursive call"字样），后重构为状态机循环（`state = next; continue`）。好处：
- 避免深递归导致的栈溢出（长 agentic session 可能有数百轮工具调用）
- `State` 对象包含所有跨迭代状态，便于在 continue 点看到完整快照

### 5.2 `content_block_stop` 时 yield AssistantMessage 的设计含义

每个 content block 对应一条独立的 `AssistantMessage`，而不是等整个 `message_stop` 后再 yield。这意味着：
- text 块结束立即 yield → UI 可以即时渲染文本结果
- tool_use 块结束立即 yield + 检测 → `StreamingToolExecutor` 可以**在模型还在生成其他 block 时**就开始执行工具
- 但代价是：`usage` 和 `stop_reason` 需要后补（`message_delta` 时 mutation）

### 5.3 Token Usage 的两层追踪

1. **全局累计**：`addToTotalSessionCost()`（`cost-tracker.ts`）——累计到全局 state，用于显示总费用
2. **对话级累计**：`QueryEngine.totalUsage`——仅本 `submitMessage()` 轮次的用量，用于 SDK result 消息

两者通过 `QueryEngine` 的 `stream_event(message_stop)` 处理（L810-815）连接：每个 message 完成时调用 `accumulateUsage(this.totalUsage, currentMessageUsage)`。

### 5.4 normalizeMessagesForAPI 的调用频率

`normalizeMessagesForAPI` 至少在每轮迭代被调用两次：
1. `claude.ts L1266`：构造 API 请求参数（完整规范化）
2. `query.ts L855,1398`：将工具结果 UserMessage 转换后追加到 `toolResults`（仅需 `type === 'user'` 的消息）

此函数约 300+ 行，对长会话有一定开销，但对正确性是必要的（每轮都可能有新的 tool_reference 或模型切换）。
