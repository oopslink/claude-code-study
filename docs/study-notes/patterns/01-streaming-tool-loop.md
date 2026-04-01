# 模式卡片 #1：流式响应 + 工具调用循环

**来源子系统**：Agent 核心循环（query loop）
**Claude Code 关键文件**：`src/query.ts`（L241-1729），`src/claude.ts`（L1940-2304）

---

## 问题

如何在流式输出中处理工具调用并维持多轮对话？在 LLM 流式响应尚未完成时，如何高效地执行工具并将结果注入下一轮上下文？

## 方案

基于 AsyncGenerator 链 + 状态机循环的设计：

- `query.ts L241-1729`：外层 `while (true)` 循环，状态机 `State` 对象驱动迭代
- `query.ts L659-863`：`for await (message of deps.callModel(...))` 消费流，检测 `tool_use` blocks
- `claude.ts L1940-2304`：原始 SSE 流处理，`content_block_stop` 时组装并 yield `AssistantMessage`
- `query.ts L1380-1408`：工具执行，`runTools()` 或 `StreamingToolExecutor`
- `query.ts L1715-1728`：`state = {...}` 更新，注入 `toolResults` 到下一轮 `messages`

工具调用结果重注入机制：工具执行后，结果作为 `UserMessage`（包含 `tool_result` content block）被推入 `toolResults` 数组。循环底部将 `state.messages` 更新为 `[...messagesForQuery, ...assistantMessages, ...toolResults]`，发送 API 前通过 `normalizeMessagesForAPI()` 转为标准格式。

## 关键设计决策

1. **`query()` 与 `QueryEngine` 分离**：`query()` 是纯粹的"一次 agent 轮次执行"原语，只关心消息流转和工具循环；`QueryEngine` 是"会话管理者"，负责持久化历史、跨轮 usage 累积、权限追踪等基础设施关切。分离使 `query()` 可通过 `deps` 注入独立测试，`QueryEngine` 可被不同入口点复用。

2. **`query()` 是 AsyncGenerator 而非普通 async 函数**：多轮工具调用可能持续数分钟，UI 需要实时看到每步进度。返回 `Promise<FinalResult>` 会丢失所有中间状态。AsyncGenerator 实现"生产者-消费者"解耦，`return Terminal`（Generator 的 done 值）携带退出原因而不必在 yield 流中混入控制信号。

3. **`while(true)` 而非递归**：避免深调用栈（长 agentic session 可能有数百轮工具调用），`State` 对象包含所有跨迭代状态，便于在 continue 点看到完整快照。

4. **`content_block_stop` 时 yield AssistantMessage**：每个 content block 结束立即 yield，UI 可即时渲染；`StreamingToolExecutor` 可在模型还在生成其他 block 时就开始执行工具。代价是 `usage` 和 `stop_reason` 需通过 `message_delta` 事件后补（属性 mutation）。

## 适用条件

- 需要"模型 → 工具 → 模型 → 工具 → ..."这类多轮 agentic 循环的系统
- 需要对外提供实时进度流的场景（流式 UI、SDK streaming）
- 工具执行时间不可预测（文件操作、bash 命令、网络请求）

## 权衡

**优点：**
- 流式输出用户体验好，无感知延迟
- Generator 链天然支持背压（消费方 `for await` 控制拉取节奏）
- 循环迭代式（非递归）避免深调用栈，状态集中在 `State` 对象便于调试
- `deps` 注入使单元测试可替换 `callModel`，无需 mock HTTP
- 多层错误恢复（压缩恢复、max_output_tokens 恢复、fallback model）在循环内透明处理

**缺点/局限：**
- 代码复杂度高：`queryLoop` 单函数约 1500 行，状态机有 11 个不同退出条件
- `content_block_stop` 时 yield message，但 `message_delta` 才有完整的 usage/stop_reason，依赖直接属性 mutation 补丁，有时序耦合
- 流式执行工具（`StreamingToolExecutor`）在 fallback 时需要 `discard()` 重置，增加了状态管理复杂度
- `normalizeMessagesForAPI` 在每轮迭代都运行，对长会话有一定 CPU 开销

---

## 在自己项目中的应用思考

**这个问题在我的项目中存在吗？**
（待填写）

**可以直接用吗？还是需要简化/调整？**
（待填写）

**可以省略的复杂度：**
（待填写）
