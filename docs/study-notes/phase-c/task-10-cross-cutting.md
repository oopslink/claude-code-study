---
---
# Task 10：横切关注点分析

> 分析日期：2026-03-31
> 覆盖源文件：`services/api/errors.ts`（全文）、`hooks/useCanUseTool.tsx`（全文）
> 参考笔记：phase-b task-04 至 task-09

---

## 一、错误处理模式

### 错误分类

`errors.ts` 通过 `createAssistantAPIErrorMessage({ error: <type> })` 中的 `error` 字段进行分类：

| 错误类型 | 典型错误（常量/触发条件） | 处理策略 | 用户可见性 |
|---------|------------------------|---------|-----------|
| `rate_limit` | `REPEATED_529_ERROR_MESSAGE`、429（quota 耗尽）、`CUSTOM_OFF_SWITCH_MESSAGE`（Opus 容量关闭） | 展示等待时间/切换建议；`NO_RESPONSE_REQUESTED` 表示静默降级（Opus→Sonnet fallback） | 高；有专属 UI 展示限额信息 |
| `invalid_request` | `PROMPT_TOO_LONG_ERROR_MESSAGE`（400/413）、PDF 页数超限、image 尺寸超限、tool_use/tool_result 序列错误、无效模型名 | 终止本次请求；reactive compact 使用 `errorDetails` 决定是否压缩重试 | 高；含具体操作指引（/rewind、/model、pdftotext 等） |
| `authentication_failed` | `INVALID_API_KEY_ERROR_MESSAGE`（x-api-key 错误）、`TOKEN_REVOKED_ERROR_MESSAGE`（403 OAuth revoked）、401/403 通用 | 提示 `/login`；CCR 模式下展示"可能是临时网络问题"（不建议重新登录） | 高；强引导登录流程 |
| `billing_error` | `CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE`（余额不足） | 终止请求，引导充值 | 高 |
| `unknown` | `APIConnectionError`（非超时）、`APIConnectionTimeoutError`、通用 `Error` | 展示原始错误消息 | 中；显示 `API Error: <message>` |

**注意**：`error` 字段仅用于内部分类和分析（`classifyAPIError()` 对应 Datadog tag）。`content` 字段才是最终展示给用户的人类可读文本，且会根据 `isNonInteractiveSession()` 调整措辞（SDK 模式省略 `/esc esc` 等 TUI 操作提示）。

### 工具错误格式化

**给模型的格式**（`toolExecution.ts` L1030-1036）：

```
tool_result block:
{
  type: 'tool_result',
  tool_use_id: '<toolUseID>',
  content: '<错误文本，纯字符串>',
  is_error: true
}
```

工具执行被权限拒绝时，`content` 是拒绝原因文本（如 `"Execution stopped by PreToolUse hook: ..."`）。工具执行抛出异常时，模型看到的是工具自身的异常信息。**不使用 `<tool_error>` XML 标签**，使用的是 API 协议原生的 `is_error: true` 字段标记工具结果块。

**给用户的格式**（UI 层）：

- `UserToolErrorMessage` 组件（`components/messages/UserToolResultMessage/UserToolErrorMessage.tsx`）渲染工具错误
- 展示内容包含工具名、可选的进度消息、错误内容
- 用 `is_error === true` 分支进入错误渲染路径（`UserToolResultMessage.tsx L74`）

**核心差异**：给模型的是纯文本 `content` 字段 + `is_error: true` 布尔标志（结构化），给用户的是 React 组件渲染（视觉化）。两者使用同一条 `tool_result` 消息对象，但消费方不同。

### HTTP 状态码处理策略

| HTTP 状态码 | 触发场景 | 是否重试 | 处理路径 |
|------------|---------|---------|---------|
| 400 | 请求格式错误（prompt 太长、PDF 无效、tool_use 序列问题、无效模型） | 否（直接失败）；但 prompt_too_long 会触发 reactive compact 后重试 | `getAssistantMessageFromError()` 按子类型分别处理 |
| 401 | 认证失败（通用 401） | 否 | `authentication_failed` 类型；CCR 模式提示重试 |
| 403 | OAuth token 被撤销、OAuth 组织不允许、Bedrock 无模型权限 | 否 | `authentication_failed` 类型 |
| 404 | 模型不存在或无权限 | 否 | 引导 `/model` 切换 |
| 413 | 请求体超过 32MB 限制 | 否 | `invalid_request`；`getRequestTooLargeErrorMessage()` |
| 429 | 速率限制 / 配额耗尽 | 由 `withRetry.ts` 决定；quota 耗尽不重试，临时容量 429 可重试 | 解析 `anthropic-ratelimit-*` headers 判断类型 |
| 529 | 服务器过载（Anthropic 自定义） | 是（`withRetry.ts` 处理）；累计 N 次后抛 `REPEATED_529_ERROR_MESSAGE` | 重试后若超限则展示 `repeated_529` |
| 5xx | 服务器错误 | 是（`withRetry.ts` 指数退避重试） | `classifyAPIError()` 返回 `server_error` |
| 连接/超时 | `APIConnectionError`、`APIConnectionTimeoutError` | 是（`withRetry.ts` 处理） | 超时展示 `API_TIMEOUT_ERROR_MESSAGE` |

**重试决策层**：`withRetry.ts` 负责底层重试（检查 `signal.aborted`，指数退避），`errors.ts` 负责将不可重试错误转换为 `AssistantMessage` 终止当前对话轮次，两层职责分离。

---

## 二、权限模型一致性

### 检查时机

权限检查发生在**工具调用前**（pre-call），不在调用中。

流程：

```
模型生成 tool_use block
  ↓
toolExecution.ts: runToolUse()
  ↓
  1. tool.validateInput()（输入合法性检查，在权限前）
  2. tool.checkPermissions()（工具自身的权限前置检查）
  3. canUseTool()（通用权限系统，含 hasPermissionsToUseTool + 用户确认 UI）
  ↓ allow → tool.call()（实际执行）
  ↓ deny  → 生成 is_error=true 的 tool_result，模型看到拒绝原因
```

**含义**：
1. 工具不会在执行到一半时被打断（原子性保证）
2. 模型通过 `is_error` tool_result 收到拒绝信号，可以决定是否重试或采用备选方案
3. 用户交互（权限确认 UI）发生在执行前，避免「已经发生破坏性操作后才问用户」的问题
4. `validateInput()` 在权限检查前运行，允许工具在「不合规输入」和「权限不足」两个维度分别给出不同错误

### 「记住此选择」的存储机制

存储 key 格式：`ToolName(ruleContent)` ，由 `permissionRuleValueToString()` 生成（`utils/permissions/permissionRuleParser.ts L144-152`）：

```typescript
// 示例
permissionRuleValueToString({ toolName: 'Bash' })
  // => 'Bash'（整个工具允许，无具体命令限制）

permissionRuleValueToString({ toolName: 'Bash', ruleContent: 'npm install' })
  // => 'Bash(npm install)'（仅允许此具体命令）

permissionRuleValueToString({ toolName: 'Bash', ruleContent: 'python -c "print(1)"' })
  // => 'Bash(python -c "print\\(1\\)")'（括号被转义）
```

**存储位置分层**：

| 范围 | 字段 | 持久化位置 | 生命周期 |
|------|------|-----------|---------|
| Session | `alwaysAllowRules.session[]` | 仅内存（AppState） | 会话结束即清除 |
| Project | `alwaysAllowRules.project[]` | `.claude/settings.json` | 项目级永久 |
| User | `alwaysAllowRules.user[]` | `~/.claude/settings.json` | 用户级永久 |
| Policy | `alwaysAllowRules.policy[]` | 企业策略文件 | 只读，管理员控制 |

**key 的精度**：`ruleContent` 是命令前缀匹配（而非完整命令哈希），设计为「允许整个命令族」而非「允许某次精确执行」。这是安全与易用性的权衡——过于精确会让用户频繁确认，过于宽松则存在权限蔓延风险。

---

## 三、三对核心抽象的精确边界

### Tool vs Task

| 维度 | Tool | Task |
|------|------|------|
| **接口核心字段** | `name`, `inputSchema`（Zod）, `call()`, `checkPermissions()`, `prompt()`, `mapToolResultToToolResultBlockParam()` | `name`, `type`（TaskType enum）, `kill(taskId, setAppState)` |
| **调用方** | 模型（LLM 在 assistant message 中生成 `tool_use` 块） | 框架代码 / 父 agent（`AgentTool.call()` 或任务调度代码） |
| **执行模型** | 同步或短暂异步，单次调用即完成 | 长期运行，有完整状态机（`pending → running → completed/failed/killed`） |
| **状态持久化** | 无持久状态；执行结果通过 `ToolResult<T>` 返回 | 状态保存在 `AppState.tasks`（`TaskStateBase` 及子类），可 `--resume` 恢复 |
| **返回值类型** | `Promise<ToolResult<Output>>`（含 `data`, `newMessages?`, `contextModifier?`） | 无直接返回值；结果通过消息队列（`enqueuePendingNotification`）以 XML user 消息注入父对话 |
| **取消机制** | 无显式取消（通过 abort signal 传播） | 必须实现 `kill()`，可精确中止 |
| **生命周期管理** | 调用前/后有 hooks（`runPreToolUseHooks` / `runPostToolUseHooks`） | `evictAfter` 到期后由系统清理输出文件 |
| **UI 呈现** | 实现 `renderToolUseMessage()` 等一系列 render 方法 | 在 TaskPanel 中展示状态、进度、输出流 |
| **典型实例** | BashTool、FileReadTool、AgentTool | LocalAgentTask、RemoteAgentTask、InProcessTeammateTask |

**精确边界**：`AgentTool` 是一个 Tool（被模型调用），它启动后会创建一个 `Task`（框架管理的长期任务）。工具调用是模型层的「函数调用协议」，任务是框架层的「并发执行单元」。

### Plugin vs Skill

| 维度 | Plugin | Skill |
|------|--------|-------|
| **本质定义** | 文件系统包（目录 + 可选 plugin.json），声明式配置 | 行为注入单元，命令式执行 |
| **内容格式** | 目录结构：`commands/`（Markdown）、`agents/`（Markdown）、`hooks/hooks.json`（JSON）、MCP bundle（`.mcpb`/`.dxt`）、`settings.json` | `getPromptForCommand(args)` 函数返回 `ContentBlockParam[]`（`{type:'text', text: string}[]`）；disk skill 用 YAML frontmatter + Markdown 正文（含 `$ARGUMENTS` 占位符） |
| **注册机制** | 安装时由 `loadAllPlugins()` 扫描 `enabledPlugins` 配置；`createPluginFromPath()` 解析目录结构；结果 memoize 缓存 | 三种来源：bundled（TypeScript 函数直接注册）、disk（`.claude/skills/` 目录，`loadSkillsDir()` 扫描）、MCP（从 MCP 服务器加载） |
| **运行时行为** | 不主动运行；提供给系统使用的 commands、agents、hooks 定义；hooks 在工具调用时触发执行 | 被 `SkillTool` 以 `tool_use` 方式调用；`getPromptForCommand()` 返回的文本以 **user 消息** 注入对话，驱动模型按指令行动 |
| **可执行代码** | 不能包含任意可执行 JS/TS；只能配置已有功能 | bundled skill 是 TypeScript 函数，可访问文件系统（如 `debug.ts` 读取 debug 日志） |
| **包含关系** | Plugin 的 `commands/` 目录内容可以作为 Skill 注册 | Skill 不依赖 Plugin 机制，可独立存在 |
| **失败隔离** | `Promise.allSettled`，单插件失败不影响系统；错误展示在 `/plugin` UI | Skill 执行失败返回 tool error；通过 contextModifier 更新 `allowedTools` 时的错误会回滚 |
| **安全模型** | 路径遍历防护 + marketplace 名称保护 + 企业策略 allowlist/blocklist | bundled skill 受 Claude Code 权限控制；disk skill 内容由用户自行编写，执行时受工具权限约束 |

### Memory vs Context

| 维度 | Memory（记忆文件，memdir） | Context（会话上下文，sessionStorage + compact） |
|------|--------------------------|------------------------------------------------|
| **存储路径** | `~/.claude/projects/<sanitized-git-root>/memory/`（MEMORY.md + topic 文件）；CCR 时为 `CLAUDE_CODE_REMOTE_MEMORY_DIR` | `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`（每行一个 Message） |
| **数据格式** | YAML frontmatter（name/description/type）+ Markdown 正文；MEMORY.md 为索引文件 | JSONL，每行一个 `Message` 对象（含 `parentUuid` 形成链式结构） |
| **生命周期** | 跨会话持久；手动写入或 `extractMemories` 子代理异步提取；不自动过期 | 会话内持久；可 `--resume` 恢复；通过 compact 压缩后旧消息被摘要替代 |
| **注入模型的方式** | `loadMemoryPrompt()` → `systemPromptSection('memory', ...)` 注入 system prompt；MEMORY.md 内容（≤200 行/25KB）通过 `claudemd.ts` 的 user context 部分注入 | `getMessagesAfterCompactBoundary()` 从 compact boundary 后截取，构成 API 请求的 `messages` 数组；compact 摘要以 user message（`isCompactSummary=true`）形式开头 |
| **容量控制** | MEMORY.md 超过 200 行/25KB 时截断并附加警告；完整 topic 文件按需由模型 `Read` | autoCompactThreshold = effectiveContextWindow - 13,000 token；超限触发 compact 压缩 |
| **写入路径** | 两条：① 模型在对话中显式 Write/Edit；② `extractMemories` 后台子代理每轮结束异步触发 | 由 `recordTranscript()` 在每条 assistant/user 消息生成时追加写入 JSONL |
| **跨会话语义** | 长期知识（用户偏好、项目决策、feedback 规则），跨会话稳定，需人工管理 | 当前会话的完整对话历史，仅对当前会话有意义 |
| **典型内容** | "用户偏好使用 TypeScript strict 模式"、"项目正在迁移至新 API"（不可从代码推导的信息） | 当前任务的工具调用链、文件内容、错误信息、对话轮次 |

---

## 四、系统级设计模式

### AsyncGenerator 的使用

**关键使用位置**：

| 位置 | 函数签名 | 产出类型 | 使用原因 |
|------|---------|---------|---------|
| `query.ts` | `async function* query(params)` | `StreamEvent \| Message \| ToolUseSummaryMessage` | 主循环，需要边产出边消费（流式渲染） |
| `services/api/claude.ts` | `queryModelWithStreaming()` → `queryModel()` | SSE 流事件 → `Message` | 对接 Anthropic SDK 的 SSE 流 |
| `services/tools/toolExecution.ts` | `async function* runToolUse(...)` | `MessageUpdateLazy` | 工具执行过程中持续产出进度更新 |
| `services/tools/toolHooks.ts` | `async function* runPreToolUseHooks(...)` 等 | Hook 执行结果 | hook 可能有多个，结果需要流式处理 |
| `tools/AgentTool/runAgent.ts` | （内部使用 `query()`） | 复用 query 的产出 | 子 agent 复用主循环 |
| `services/tools/StreamingToolExecutor.ts` | 管理流式工具执行状态 | `tool_result` 块 | 并行工具执行的进度汇聚 |

**为什么偏好 AsyncGenerator 而非 Promise**：

1. **流式渲染需求**：UI 需要在 API 响应完成前就开始渲染文字（token 级别的流式输出）。Promise 只能在完成后 resolve 一个值，无法支持增量渲染。

2. **自然的背压控制**：AsyncGenerator 的 `yield` 点天然形成背压——消费方不调用 `next()`，产出方不继续执行。这避免了事件队列溢出问题，比 EventEmitter/回调更安全。

3. **组合性**：`yield*` 可以直接委托给另一个 AsyncGenerator（如 `query()` 内部 `yield* queryLoop()`），形成无摩擦的流式 pipeline。与 `for await...of` 配合，消费方代码与同步代码无异。

4. **终止值传递**：AsyncGenerator 的 `return` 语句可以携带最终值（`Terminal` 类型），而 `yield` 的每次产出是中间值。这允许 `query()` 同时流式产出消息和在最后返回退出原因。

5. **工具循环的自然表达**：agent loop 本质是「获取 N 条消息 → 执行工具 → 继续」的迭代，AsyncGenerator 的 `while(true)` + `yield` 比 Promise.then 链更直观，也避免了递归调用的栈溢出风险。

### 回调注入模式

**三个核心回调**及出现位置：

| 回调 | 注入位置 | 统一解决的问题 |
|------|---------|--------------|
| `canUseTool: CanUseToolFn` | `QueryParams.canUseTool` → `toolExecution.runToolUse()` → `tool.call(canUseTool, ...)` | 将「权限决策 UI」从工具实现解耦；工具不需要知道如何弹对话框，框架通过回调注入决策逻辑；测试时可注入 mock 实现 |
| `setAppState: SetAppState` | `QueryEngineConfig.setAppState` → `ToolUseContext.setAppState` → 工具内部 | 工具可以更新全局 UI 状态（注册后台任务、更新权限规则），而不需要持有 React state 引用；子 agent 使用 no-op 版本实现隔离 |
| `onProgress: ToolCallProgress<P>` | `tool.call(args, ctx, canUseTool, parentMsg, onProgress?)` | 工具向调用方上报中间进度（AgentTool 的子 agent 消息流、BashTool 的命令输出）；调用方决定如何处理进度（存储/渲染/转发） |

**统一解决的架构问题**：

这三个回调共同实现了**依赖倒置**原则——具体工具实现（低层模块）不依赖 UI 框架（高层模块），而是通过回调接口依赖。具体体现：

1. **可测试性**：测试中注入 mock 回调，无需启动 React 渲染树或真实 API
2. **子 agent 隔离**：`createSubagentContext()` 通过替换 `setAppState`（改为 no-op）、`canUseTool`（强制跳过确认）实现子 agent 在后台静默运行
3. **多运行模式适配**：同一套工具代码，在 TUI 模式注入 Ink 渲染回调，在 SDK 模式注入无 UI 回调，在测试模式注入 mock 回调

额外的回调注入点：`getAppState`（读取当前应用状态）、`setToolJSX`（向 UI 注入 React 节点）、`addNotification`（追加通知消息），这些构成了工具与框架通信的完整回调接口。

---

## 五、关键设计洞察

**洞察 1：错误不跨层传播，而是在边界处转换**

从 `errors.ts` 可以观察到一个贯穿全系统的设计原则：底层错误（`APIError`、`ImageSizeError`、`APIConnectionTimeoutError`）在 API 层被捕获后，立即转换为 `AssistantMessage`（内部系统消息），而不是向上抛出异常。这意味着错误作为「消息」进入对话历史，与普通 API 响应走同一条路径。错误处理不打断控制流，而是作为对话的一部分被处理——agent loop 在收到 `isApiErrorMessage === true` 的消息后可以决定是否重试、压缩上下文或退出。

**洞察 2：AsyncGenerator 是整个系统的「主干神经」**

整个 Claude Code 的核心数据流是一条 AsyncGenerator 链（`SSE stream → queryModel → query → queryLoop → runToolUse → UI/SDK`）。这不是偶然的设计选择，而是流式 AI 响应的本质决定的——当输出是无限流时，Promise 是错误的抽象。AsyncGenerator 使得「实时渲染 + 工具执行 + 多轮循环」可以用线性的命令式代码表达，而不需要复杂的状态机或 Observable 订阅图。

**洞察 3：权限系统是「调用前守门员」，而非「调用中监控者」**

`useCanUseTool.tsx` 展示的权限模型将所有安全决策前移到工具调用前。这个设计的深层含义是：系统认为工具执行本身是不可回滚的副作用，因此决不应该在执行中途中断。`is_error: true` 的 tool_result 让模型知道权限被拒，但工具从未开始运行，因此没有需要回滚的状态。`allowsAllowRules` 的分层存储（session/project/user/policy）则允许「记住选择」在不同生命周期内有效，精度达到命令前缀级别（`Bash(npm install)`），而非工具名级别（`Bash`）或命令哈希级别。

**洞察 4：子 agent 隔离通过「克隆 + no-op 替换」而非「沙箱」实现**

`createSubagentContext()` 的设计揭示了 Claude Code 的多 agent 隔离哲学：不使用 OS 级沙箱（进程隔离），而是在同一 JS 运行时内通过精心设计的对象克隆和回调替换实现记忆隔离。`setAppState` 改为 no-op（后台子 agent 不更新 UI），`abortController` 新建子控制器（子 abort 不影响父），`readFileState` 克隆（子 agent 文件缓存不污染父）。这是一种「信任但隔离」的设计——子 agent 代码与父 agent 完全相同，但通过依赖注入的回调决定其行为边界。

**洞察 5：Memory 和 Context 服务于不同的时间维度，注入点也不同**

系统实际上有三层「让模型知道事情」的机制，按时间维度分：长期（Memory，跨会话，注入 system prompt）、中期（compact 摘要，注入当前轮 messages 的开头 user 消息）、短期（session messages，注入 messages 数组的完整历史）。三者对应不同的存储后端和注入 API 字段（system 字段 vs messages 数组头部 vs messages 数组），各司其职。特别有意思的是 compact 摘要以 `user` role 消息（而非 system）注入——这是因为 Anthropic API 要求 messages 数组必须以 user 消息开始，compact boundary 后的摘要必须满足这个格式约束。这个实现细节暴露了 API 协议约束如何反向影响架构设计。
