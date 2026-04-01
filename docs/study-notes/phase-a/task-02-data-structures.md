---
---
# Task 2：核心数据结构

> 研究日期：2026-03-31
> 研究范围：消息类型体系、权限模型、Tool 抽象接口、系统上下文
>
> **重要说明**：`src/types/message.ts` 和 `src/types/tools.ts`（进度数据类型）
> 两个文件**未包含在开源版本**中。本笔记依据以下文件进行逆向重建：
> - `src/Tool.ts`（完整，包含 Tool/ToolUseContext 定义）
> - `src/types/permissions.ts`（完整）
> - `src/context.ts`（完整）
> - `src/utils/messages.ts`（工厂函数 + 类型使用推断消息结构）
> - `src/utils/messagePredicates.ts`（辨别式推断）

---

## 消息类型体系

### Message 类型 Union

`Message` 是一个 discriminated union，通过 `type` 字段区分成员。
根据 `messages.ts` 中 switch/filter 分支与 `isSystemLocalCommandMessage` 等谓词函数推断，完整成员如下：

```typescript
// 推断自 src/utils/messages.ts 的使用模式
// 实际定义在（缺失的）src/types/message.ts

type Message =
  | UserMessage               // type: 'user'
  | AssistantMessage          // type: 'assistant'
  | ProgressMessage           // type: 'progress'
  | AttachmentMessage         // type: 'attachment'
  | SystemMessage             // type: 'system'（多子类型）
  | TombstoneMessage          // type: 'tombstone'
  | ToolUseSummaryMessage     // type: 'tool_use_summary'（SDK-only）
  | StreamEvent               // type: 'stream_event'（流式中间态）
  | RequestStartEvent         // type: 'stream_request_start'（流式请求开始）
```

### 各消息类型关键字段

#### UserMessage（type: 'user'）

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'user'` | 辨别式 |
| `uuid` | `UUID` | 唯一标识 |
| `timestamp` | `string` | ISO 时间戳 |
| `message` | `{ role: 'user'; content: string \| ContentBlockParam[] }` | API 消息体 |
| `isMeta` | `true?` | 是否是元消息（不显示给用户的内部消息） |
| `isVisibleInTranscriptOnly` | `true?` | 仅在 transcript 模式显示 |
| `isVirtual` | `true?` | 虚拟消息（不发给 API） |
| `isCompactSummary` | `true?` | 压缩摘要消息 |
| `toolUseResult` | `unknown?` | 工具调用结果（`tool_result` 消息时存在） |
| `mcpMeta` | `{ _meta?; structuredContent? }?` | MCP 协议元数据（不发给模型） |
| `sourceToolAssistantUUID` | `UUID?` | 对应 `tool_use` 所在的 assistant 消息 UUID |
| `permissionMode` | `PermissionMode?` | 发送时的权限模式（用于 rewind 恢复） |
| `summarizeMetadata` | `{ messagesSummarized; userContext?; direction? }?` | 摘要元数据 |
| `origin` | `MessageOrigin?` | 来源（undefined = 用户键盘输入） |
| `imagePasteIds` | `number[]?` | 粘贴图片 ID 列表 |

**关键辨别**：`isHumanTurn(m)` = `m.type === 'user' && !m.isMeta && m.toolUseResult === undefined`
即 `UserMessage` 同时承担"人类对话轮次"和"工具结果回传"两种角色。

#### AssistantMessage（type: 'assistant'）

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'assistant'` | 辨别式 |
| `uuid` | `UUID` | 唯一标识 |
| `timestamp` | `string` | ISO 时间戳 |
| `message` | `BetaMessage` | API 响应消息体（含 content blocks、usage 等） |
| `message.content` | `BetaContentBlock[]` | 内容块数组（text、tool_use、thinking 等） |
| `message.usage` | `BetaUsage` | Token 用量 |
| `message.model` | `string` | 响应模型名 |
| `message.stop_reason` | `string` | 停止原因 |
| `requestId` | `string?` | API 请求 ID |
| `apiError` | （见 SDK 类型）? | API 错误信息 |
| `error` | `SDKAssistantMessageError?` | SDK 层错误 |
| `errorDetails` | `string?` | 错误详情文本 |
| `isApiErrorMessage` | `boolean` | 是否是 API 错误消息 |
| `isVirtual` | `true?` | 虚拟消息标记 |

**ToolUseBlock**（`BetaToolUseBlock`，来自 Anthropic SDK）：

| 字段 | 说明 |
|------|------|
| `type: 'tool_use'` | 辨别式 |
| `id` | 工具调用 ID（与 tool_result 配对） |
| `name` | 工具名称 |
| `input` | 工具输入参数（JSON 对象） |

**ToolResultBlock**（`ToolResultBlockParam`，来自 Anthropic SDK）：

| 字段 | 说明 |
|------|------|
| `type: 'tool_result'` | 辨别式 |
| `tool_use_id` | 对应的 tool_use ID |
| `content` | 结果内容（字符串或内容块数组） |
| `is_error` | 是否是错误结果 |

#### ProgressMessage（type: 'progress'）

```typescript
// 推断自 createProgressMessage 工厂函数
type ProgressMessage<P extends Progress = Progress> = {
  type: 'progress'
  uuid: UUID
  timestamp: string
  toolUseID: string        // 所属工具调用 ID
  parentToolUseID: string  // 父工具调用 ID（用于嵌套 Agent）
  data: P                  // 进度数据（ToolProgressData | HookProgress）
}
```

#### SystemMessage（type: 'system'）

有多个 `subtype` 子类型：

| subtype | 类型名 | 用途 |
|---------|--------|------|
| `'informational'` | `SystemInformationalMessage` | 通用信息提示 |
| `'local_command'` | `SystemLocalCommandMessage` | 本地命令输出 |
| `'api_error'` | `SystemAPIErrorMessage` | API 错误展示 |
| `'permission_retry'` | `SystemPermissionRetryMessage` | 权限重试提示 |
| `'bridge_status'` | `SystemBridgeStatusMessage` | 远程桥接状态 |
| `'scheduled_task_fire'` | `SystemScheduledTaskFireMessage` | 定时任务触发 |
| `'stop_hook_summary'` | `SystemStopHookSummaryMessage` | Stop Hook 执行摘要 |
| `'compact_boundary'` | `SystemCompactBoundaryMessage` | 对话压缩边界标记 |
| `'microcompact_boundary'` | `SystemMicrocompactBoundaryMessage` | 微压缩边界标记 |
| `'api_metrics'` | `SystemApiMetricsMessage` | API 性能指标 |
| `'agents_killed'` | `SystemAgentsKilledMessage` | Agent 终止通知 |
| `'away_summary'` | `SystemAwaySummaryMessage` | 离开摘要 |
| `'memory_saved'` | `SystemMemorySavedMessage` | 记忆保存通知 |
| `'turn_duration'` | `SystemTurnDurationMessage` | 轮次耗时统计 |

所有 SystemMessage 共有字段：`type: 'system'`、`subtype`、`uuid`、`timestamp`、`content`、`isMeta`、`level`（部分子类型）。

### ProgressMessage vs AssistantMessage

| 维度 | ProgressMessage | AssistantMessage |
|------|----------------|------------------|
| **发送方** | 工具执行过程（内部） | Anthropic API 响应 |
| **是否进入 API** | 否，`normalizeMessagesForAPI` 过滤掉 | 是，直接对应 API 的 assistant 角色消息 |
| **存储位置** | 与所属 tool_use 关联，通过 `toolUseID` 索引 | 主消息列表 |
| **用途** | 工具执行实时进度展示（流式 UI） | 模型文本/工具调用结果永久记录 |
| **生命周期** | 工具运行期间，完成后可聚合 | 持久化到 transcript |
| **data 字段** | `ToolProgressData \| HookProgress` | 无，内容在 `message.content` |

**ProgressMessage 何时产生**：工具执行期间，通过 `onProgress?: ToolCallProgress<P>` 回调发射。
典型场景：AgentTool 的子 Agent 进度、BashTool 的实时输出、MCP 工具的流式响应等。

### SystemLocalCommandMessage 是什么？

```typescript
// 推断自 createCommandInputMessage 工厂函数
type SystemLocalCommandMessage = {
  type: 'system'
  subtype: 'local_command'
  content: string      // 命令输出文本
  level: 'info'
  timestamp: string
  uuid: UUID
  isMeta: false
}
```

**使用场景**：当用户在 REPL 中执行本地斜杠命令（slash command）时，命令的 stdout 被包装为 `SystemLocalCommandMessage`。

**特殊之处**：它是 `SystemMessage` 的子类型，但在 `normalizeMessagesForAPI` 时被特殊处理——转为 `UserMessage` 发给模型，使模型能引用命令输出。因此 `appendSystemMessage` 类型上排除了它（`Exclude<SystemMessage, SystemLocalCommandMessage>`），需要走单独路径注入。

---

## 权限模型

### PermissionMode 取值

来源：`src/types/permissions.ts`

```typescript
export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits',        // 自动接受文件编辑，仍询问其他操作
  'bypassPermissions',  // 跳过所有权限检查（危险）
  'default',            // 标准交互模式，询问用户
  'dontAsk',            // 自动拒绝所有需要许可的操作
  'plan',               // 计划模式，只输出计划不执行
] as const

// 内部模式（用户可寻址）= 外部模式 + 条件特性
type InternalPermissionMode = ExternalPermissionMode | 'auto' | 'bubble'
type PermissionMode = InternalPermissionMode
```

| 模式 | 策略描述 |
|------|---------|
| `default` | 标准模式，每次危险操作询问用户 |
| `acceptEdits` | 自动接受文件编辑类操作，其他仍询问 |
| `bypassPermissions` | 绕过所有权限检查，直接执行（危险，需特权）|
| `dontAsk` | 自动拒绝需要许可的操作，不询问用户 |
| `plan` | 计划模式，仅描述将要做什么，不实际执行 |
| `auto` | 自动模式，由 classifier 决策（feature flag 控制） |
| `bubble` | 内部使用，权限决策向上冒泡 |

`PERMISSION_MODES`（运行时用户可设置集合）= `INTERNAL_PERMISSION_MODES`，不含 `bubble`。

### PermissionResult 结构

```typescript
// src/types/permissions.ts

// 基础行为决策
type PermissionBehavior = 'allow' | 'deny' | 'ask'

// 完整决策类型
type PermissionDecision<Input> =
  | PermissionAllowDecision<Input>   // behavior: 'allow'
  | PermissionAskDecision<Input>     // behavior: 'ask'
  | PermissionDenyDecision           // behavior: 'deny'

// 最终结果（Decision + passthrough）
type PermissionResult<Input> =
  | PermissionDecision<Input>
  | { behavior: 'passthrough'; message: string; ... }
```

四种决策结果详解：

| 行为 | 类型名 | 关键字段 |
|------|--------|---------|
| `allow` | `PermissionAllowDecision` | `updatedInput?`（修改后的输入）、`userModified?`、`acceptFeedback?`、`contentBlocks?` |
| `ask` | `PermissionAskDecision` | `message`（提示用户的文本）、`suggestions?`（建议的规则更新）、`blockedPath?`、`pendingClassifierCheck?`（异步 classifier） |
| `deny` | `PermissionDenyDecision` | `message`（拒绝原因）、`decisionReason`（必填，`PermissionDecisionReason`） |
| `passthrough` | （inline） | `message`、`suggestions?`、`pendingClassifierCheck?`（透传给上层处理） |

**PermissionDecisionReason** 的 type 取值：
`rule`、`mode`、`subcommandResults`、`permissionPromptTool`、`hook`、`asyncAgent`、`sandboxOverride`、`classifier`、`workingDir`、`safetyCheck`、`other`

### AdditionalWorkingDirectory 是什么？

```typescript
// src/types/permissions.ts
type AdditionalWorkingDirectory = {
  path: string
  source: WorkingDirectorySource  // 与 PermissionRuleSource 同义
}
```

**作用**：扩展权限检查的"工作目录范围"。当工具操作（如文件读写）的路径位于 cwd 之外时，通过 `additionalWorkingDirectories` 声明额外允许的目录，避免误报越权。

**出现在** `ToolPermissionContext.additionalWorkingDirectories: ReadonlyMap<string, AdditionalWorkingDirectory>`，key 为路径字符串。

---

## Tool 抽象接口

### Tool 完整字段定义

来源：`src/Tool.ts`

```typescript
// 泛型参数：
// Input  = Zod schema 类型（工具输入）
// Output = 工具返回值类型
// P      = 进度数据类型（extends ToolProgressData）

type Tool<Input extends AnyObject, Output, P extends ToolProgressData> = {

  // ── 标识 ──────────────────────────────────────────────
  readonly name: string                    // 工具名，全局唯一
  aliases?: string[]                       // 历史名称兼容（改名时用）
  searchHint?: string                      // 关键词提示（deferred 工具的搜索辅助）

  // ── Schema ────────────────────────────────────────────
  readonly inputSchema: Input              // Zod schema（定义输入结构）
  readonly inputJSONSchema?: ToolInputJSONSchema  // MCP 工具的原始 JSON Schema
  outputSchema?: z.ZodType<unknown>        // 输出 schema（可选）

  // ── 核心执行 ──────────────────────────────────────────
  call(
    args: z.infer<Input>,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: ToolCallProgress<P>,
  ): Promise<ToolResult<Output>>

  // ── 权限 ──────────────────────────────────────────────
  checkPermissions(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<PermissionResult>

  validateInput?(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<ValidationResult>

  // ── 能力描述（用于系统提示） ───────────────────────────
  description(
    input: z.infer<Input>,
    options: { isNonInteractiveSession: boolean; toolPermissionContext; tools },
  ): Promise<string>

  prompt(options: {
    getToolPermissionContext: () => Promise<ToolPermissionContext>
    tools: Tools
    agents: AgentDefinition[]
    allowedAgentTypes?: string[]
  }): Promise<string>

  // ── 状态查询 ──────────────────────────────────────────
  isEnabled(): boolean
  isConcurrencySafe(input: z.infer<Input>): boolean
  isReadOnly(input: z.infer<Input>): boolean
  isDestructive?(input: z.infer<Input>): boolean
  isOpenWorld?(input: z.infer<Input>): boolean
  requiresUserInteraction?(): boolean

  // ── 分类 / 元数据 ─────────────────────────────────────
  readonly maxResultSizeChars: number       // 结果超过此大小持久化到磁盘
  readonly strict?: boolean                 // 启用严格 schema 验证
  readonly shouldDefer?: boolean            // 是否延迟加载（需先 ToolSearch）
  readonly alwaysLoad?: boolean             // 始终在初始 prompt 中加载
  isMcp?: boolean                          // 是否是 MCP 工具
  isLsp?: boolean                          // 是否是 LSP 工具
  mcpInfo?: { serverName: string; toolName: string }  // MCP 服务器信息

  // ── 输入处理 ──────────────────────────────────────────
  inputsEquivalent?(a: z.infer<Input>, b: z.infer<Input>): boolean
  backfillObservableInput?(input: Record<string, unknown>): void
  getPath?(input: z.infer<Input>): string
  preparePermissionMatcher?(
    input: z.infer<Input>,
  ): Promise<(pattern: string) => boolean>

  // ── 中断行为 ──────────────────────────────────────────
  interruptBehavior?(): 'cancel' | 'block'

  // ── 分类器输入 ────────────────────────────────────────
  toAutoClassifierInput(input: z.infer<Input>): unknown

  // ── 序列化 ────────────────────────────────────────────
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam

  extractSearchText?(out: Output): string

  // ── UI 渲染（React） ───────────────────────────────────
  userFacingName(input: Partial<z.infer<Input>> | undefined): string
  userFacingNameBackgroundColor?(input: ...): keyof Theme | undefined
  renderToolUseMessage(input: Partial<z.infer<Input>>, options): React.ReactNode
  renderToolResultMessage?(content, progressMessages, options): React.ReactNode
  renderToolUseProgressMessage?(progressMessages, options): React.ReactNode
  renderToolUseQueuedMessage?(): React.ReactNode
  renderToolUseRejectedMessage?(input, options): React.ReactNode
  renderToolUseErrorMessage?(result, options): React.ReactNode
  renderGroupedToolUse?(toolUses, options): React.ReactNode | null
  renderToolUseTag?(input: ...): React.ReactNode

  // ── 搜索 / 折叠显示 ────────────────────────────────────
  isSearchOrReadCommand?(input: ...): { isSearch: boolean; isRead: boolean; isList?: boolean }
  isResultTruncated?(output: Output): boolean
  isTransparentWrapper?(): boolean
  getToolUseSummary?(input: ...): string | null
  getActivityDescription?(input: ...): string | null
}
```

**buildTool 默认值**（`TOOL_DEFAULTS`）：
- `isEnabled` → `true`
- `isConcurrencySafe` → `false`（保守默认：不安全）
- `isReadOnly` → `false`（保守默认：写操作）
- `isDestructive` → `false`
- `checkPermissions` → `{ behavior: 'allow', updatedInput }` （委托给通用权限系统）
- `toAutoClassifierInput` → `''`（跳过 classifier，安全相关工具须覆盖）
- `userFacingName` → `name`

### ToolUseContext 关键字段

来源：`src/Tool.ts`，`ToolUseContext` 是工具执行时获得的完整运行时上下文：

```typescript
type ToolUseContext = {
  // 选项配置（启动时确定）
  options: {
    commands: Command[]
    debug: boolean
    mainLoopModel: string
    tools: Tools
    verbose: boolean
    thinkingConfig: ThinkingConfig
    mcpClients: MCPServerConnection[]
    mcpResources: Record<string, ServerResource[]>
    isNonInteractiveSession: boolean
    agentDefinitions: AgentDefinitionsResult
    maxBudgetUsd?: number
    customSystemPrompt?: string
    appendSystemPrompt?: string
    querySource?: QuerySource
    refreshTools?: () => Tools
  }

  // 核心运行时状态
  abortController: AbortController   // 中止信号
  messages: Message[]                // 完整对话历史
  readFileState: FileStateCache       // 文件读取缓存

  // 应用状态管理
  getAppState(): AppState
  setAppState(f: (prev: AppState) => AppState): void
  setAppStateForTasks?: (f: (prev: AppState) => AppState) => void

  // UI 回调
  setToolJSX?: SetToolJSXFn
  addNotification?: (notif: Notification) => void
  appendSystemMessage?: (msg: Exclude<SystemMessage, SystemLocalCommandMessage>) => void
  sendOSNotification?: (opts: { message: string; notificationType: string }) => void

  // 工具执行追踪
  setInProgressToolUseIDs: (f: (prev: Set<string>) => Set<string>) => void
  setHasInterruptibleToolInProgress?: (v: boolean) => void
  setResponseLength: (f: (prev: number) => number) => void

  // Agent 标识（子 Agent 时有值）
  agentId?: AgentId
  agentType?: string

  // 权限与安全
  requireCanUseTool?: boolean
  localDenialTracking?: DenialTrackingState
  toolDecisions?: Map<string, { source; decision; timestamp }>

  // 资源限制
  fileReadingLimits?: { maxTokens?: number; maxSizeBytes?: number }
  globLimits?: { maxResults?: number }

  // 其他
  contentReplacementState?: ContentReplacementState
  renderedSystemPrompt?: SystemPrompt
  userModified?: boolean
  toolUseId?: string
  queryTracking?: QueryChainTracking
  requestPrompt?: (sourceName, toolInputSummary?) => (request) => Promise<PromptResponse>
  handleElicitation?: (serverName, params, signal) => Promise<ElicitResult>
  // ... 更多 UI/追踪字段
}
```

**最关键字段**（工具执行必须依赖的）：
1. `abortController` — 支持用户中断
2. `messages` — 读取对话历史上下文
3. `options.tools` — 工具列表（AgentTool 启动子 Agent 需要）
4. `setAppState` — 更新应用状态（TodoWrite 等工具写入结果）
5. `setInProgressToolUseIDs` — 追踪工具执行状态（UI 动画）

### Tools 类型（复数）和 Tool 的关系

```typescript
// src/Tool.ts
type Tools = readonly Tool[]
```

`Tools` 是 `Tool[]` 的只读版本，语义上代表"工具集合"。使用独立类型别名而非直接用 `Tool[]` 的目的：
- 明确标记工具集合在哪里被组装、传递、过滤
- `readonly` 防止运行时意外修改工具列表
- 便于在 codebase 中 grep 工具集合的流转路径

**工具集组装入口**：`assembleToolPool(permissionContext, mcpTools)` in `src/tools.ts`，返回内置工具 + MCP 工具的去重有序集合。

---

## 系统上下文

来源：`src/context.ts`

### getSystemContext()

```typescript
export const getSystemContext = memoize(async (): Promise<{ [k: string]: string }>) => {
  return {
    gitStatus,      // git 状态快照（branch、status、log、user）
    cacheBreaker,   // [仅 ant] 缓存破坏标记
  }
}
```

**内容**：
- `gitStatus`：当前 git 仓库状态（分支、修改文件、最近 5 次提交、git user）。当 `CLAUDE_CODE_REMOTE=true` 或 git 指令被禁用时跳过。
- `cacheBreaker`：Anthropic 内部 `BREAK_CACHE_COMMAND` feature 启用时的调试注入。

**用途**：注入系统提示的开头（system turn），向模型提供当前工程上下文。**memoize** 确保同一对话内只读取一次 git。

### getUserContext()

```typescript
export const getUserContext = memoize(async (): Promise<{ [k: string]: string }>) => {
  return {
    claudeMd,    // CLAUDE.md 内容（工程记忆文件）
    currentDate, // 今天的日期（ISO格式）
  }
}
```

**内容**：
- `claudeMd`：从项目目录和 `~/.claude/` 收集的所有 CLAUDE.md 文件内容，合并后注入。通过 `CLAUDE_CODE_DISABLE_CLAUDE_MDS` 或 `--bare` 模式可禁用。
- `currentDate`：`Today's date is YYYY-MM-DD.` 格式的当前日期字符串。

**用途**：注入用户轮次（user turn 开头），以 `<system-reminder>` 标签包裹。`claudeMd` 内容同时被缓存供 auto-mode classifier（yoloClassifier.ts）读取，避免循环依赖。

**两者区别**：

| | getSystemContext | getUserContext |
|--|----------------|---------------|
| 注入位置 | system turn | user turn（<system-reminder>标签） |
| 主要内容 | git 状态 | CLAUDE.md + 当前日期 |
| 刷新时机 | setSystemPromptInjection 调用时 | 同左 |
| 分类器读取 | 否 | claudeMd 被 yoloClassifier 读取 |

---

## 关键发现

### 1. types/message.ts 和 types/tools.ts 是有意剥离的私有文件

这两个关键类型文件未包含在开源版本中，但被 180+ 个文件引用。推测原因：这些类型文件与 Anthropic 内部业务逻辑（消息结构演化、SDK 版本适配、内部扩展字段）紧密绑定，对外开源会带来接口承诺风险。开发者可通过 factory functions（`createUserMessage`、`createAssistantMessage` 等）理解实际结构。

### 2. UserMessage 承担双重角色——人类输入 AND 工具结果

`UserMessage`（`type: 'user'`）同时用于：
- 人类对话轮次（`isMeta = undefined, toolUseResult = undefined`）
- 工具结果回传（`toolUseResult !== undefined`，content 含 `tool_result` block）

这是 Anthropic API 设计决定的——API 层面 tool_result 必须在 user 角色消息中。Claude Code 在内部通过 `isHumanTurn()` 谓词区分两者，避免把工具结果当成用户输入。

### 3. ProgressMessage 是纯 UI 临时消息，永远不进入 API

`type: 'progress'` 消息在 `normalizeMessagesForAPI` 时被完全过滤，仅用于实时进度展示。这种设计让工具的进度报告与 API 调用解耦：工具可以任意频率发射进度，不影响 token 消耗和 API 请求的稳定性。

### 4. Tool 接口混合了执行逻辑与 UI 渲染——有意为之的全栈设计

`Tool` 接口中包含 15+ 个 `render*` 方法（React 组件返回）和 `call()` 执行方法。这种将渲染逻辑内聚到工具对象的设计，使得每个工具完全自治——无需外部分发表来决定如何渲染。代价是 Tool 接口极重（~70个字段），但 `buildTool()` 工厂函数通过 `TOOL_DEFAULTS` 填充安全默认值，保证工具作者只需关注差异化实现。

### 5. 权限系统采用分层决策，passthrough 是关键的透传语义

`PermissionResult` 的四种行为（allow/ask/deny/passthrough）中，`passthrough` 是一个专门的"我不决定，让上层决定"的元结果，与 `ask` 不同——`ask` 会产生 UI 提示，而 `passthrough` 是工具链中间层向上冒泡权限问题的机制，体现了多层工具嵌套（如 AgentTool 包含 BashTool）时的权限委托设计。
