---
---
# Task 05：工具系统精读

> 精读范围：`Tool.ts`、`tools.ts`、`FileReadTool/`、`AgentTool/AgentTool.tsx`、`AgentTool/forkSubagent.ts`、`hooks/useCanUseTool.tsx`、`tools/shared/`

---

## 一、必答问题

### Q1：`call()` 方法的完整签名

```typescript
call(
  args: z.infer<Input>,                // Zod schema 推断出的输入类型
  context: ToolUseContext,             // 工具执行上下文（贯穿整个调用链）
  canUseTool: CanUseToolFn,            // 权限检查函数（由框架注入）
  parentMessage: AssistantMessage,     // 触发此工具调用的 assistant 消息
  onProgress?: ToolCallProgress<P>,   // 可选的进度回调
): Promise<ToolResult<Output>>
```

`ToolResult<T>` 的结构：

```typescript
type ToolResult<T> = {
  data: T                              // 工具执行的实际输出
  newMessages?: (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext  // 仅非并发安全工具可用
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}
```

---

### Q2：Tool 接口需要实现的全部方法和属性

**必须实现（非 Defaultable）：**

| 成员 | 类型 | 说明 |
|------|------|------|
| `name` | `readonly string` | 工具的唯一标识符 |
| `inputSchema` | `Input`（Zod schema） | 输入参数的校验与类型推断 |
| `maxResultSizeChars` | `number` | 结果超出此大小则持久化到磁盘 |
| `call(...)` | `Promise<ToolResult<Output>>` | 核心执行逻辑 |
| `prompt(...)` | `Promise<string>` | 向模型描述工具用途的 system prompt 片段 |
| `userFacingName(input)` | `string` | UI 显示名称（可随 input 变化） |
| `toAutoClassifierInput(input)` | `unknown` | 提供给安全分类器的表示 |
| `mapToolResultToToolResultBlockParam(...)` | `ToolResultBlockParam` | 将输出序列化为 API 格式 |
| `renderToolUseMessage(...)` | `React.ReactNode` | 渲染工具调用的 UI |

**有默认值的方法（可不实现，`buildTool()` 填入安全默认值）：**

| 方法 | 默认值 | 含义 |
|------|--------|------|
| `isEnabled()` | `true` | 是否启用 |
| `isConcurrencySafe(input)` | `false` | 假定不并发安全（保守） |
| `isReadOnly(input)` | `false` | 假定会写入（保守） |
| `isDestructive(input)` | `false` | 假定非破坏性 |
| `checkPermissions(input, ctx)` | `{behavior: 'allow'}` | 默认允许，交由通用权限系统 |
| `toAutoClassifierInput(input)` | `''` | 不参与分类器（安全相关工具须覆盖） |
| `userFacingName(input)` | `tool.name` | 等同于工具名 |

**可选扩展方法（按需实现）：**

- `description(input, opts)` — 异步描述字符串（用于权限提示文案）
- `validateInput(input, ctx)` — 输入校验，在权限检查前运行
- `preparePermissionMatcher(input)` — 为 hook `if` 条件准备模式匹配器
- `isSearchOrReadCommand(input)` — 控制 UI 折叠展示
- `isOpenWorld(input)` — 是否开放世界操作
- `interruptBehavior()` — 新消息到来时工具行为：`'cancel'` | `'block'`
- `inputsEquivalent(a, b)` — 两个输入是否等价（用于去重）
- `backfillObservableInput(input)` — 在钩子/权限系统看到 input 前填充遗留字段
- `getPath(input)` — 提取文件路径（供权限系统使用）
- `getToolUseSummary(input)` — 紧凑视图的摘要文本
- `getActivityDescription(input)` — Spinner 显示的活动描述
- `extractSearchText(output)` — 供 transcript 搜索索引的文本
- `isResultTruncated(output)` — 是否截断（控制点击展开行为）
- `renderToolResultMessage(...)` — 渲染工具结果的 UI
- `renderToolUseProgressMessage(...)` — 渲染进度 UI
- `renderToolUseRejectedMessage(...)` — 渲染拒绝 UI
- `renderToolUseErrorMessage(...)` — 渲染错误 UI
- `renderGroupedToolUse(...)` — 渲染多个并行调用的组 UI
- `renderToolUseTag(input)` — 工具调用旁边的附加标签
- `renderToolUseQueuedMessage()` — 排队等待时的 UI

**特殊标志字段：**

- `aliases?: string[]` — 兼容旧工具名
- `searchHint?: string` — ToolSearch 关键词提示（3-10 词）
- `shouldDefer?: boolean` — 是否延迟加载（需 ToolSearch 后才能调用）
- `alwaysLoad?: boolean` — 始终出现在初始 prompt 中（不延迟）
- `isMcp?: boolean` — 是否 MCP 工具
- `isLsp?: boolean` — 是否 LSP 工具
- `strict?: boolean` — 是否启用 API 严格模式
- `outputSchema?: z.ZodType` — 输出 schema（可选）

---

### Q3：`ToolUseContext` 中最常用的 3-5 个字段

| 字段 | 类型 | 用途 |
|------|------|------|
| `options.tools` | `Tools` | 当前会话可用的完整工具列表（工具需要知道其他工具存在，如权限提示） |
| `getAppState()` | `() => AppState` | 读取全局应用状态，包括权限上下文、MCP 状态、任务列表 |
| `setAppState(f)` | `(prev: AppState) => AppState` | 更新全局状态（如注册后台任务、更新权限规则） |
| `abortController` | `AbortController` | 取消信号，工具执行时通过此信号响应用户中断 |
| `messages` | `Message[]` | 当前会话的完整消息历史（fork subagent 用来继承父 agent 上下文） |
| `readFileState` | `FileStateCache` | 文件读取状态缓存（FileReadTool 用来去重重复读取） |
| `setToolJSX` | `SetToolJSXFn \| undefined` | 向 UI 注入 React 节点（如 AgentTool 注入 BackgroundHint 进度提示） |

其中 `getAppState()` + `setAppState()` 是最核心的一对，几乎所有有状态操作都经过它们。`abortController` 是安全取消的统一入口。

---

### Q4：`getTools()` vs `getAllBaseTools()` 的区别

**`getAllBaseTools()`（信息来源，`tools.ts:193`）：**
- 返回当前环境下**理论上可能存在**的所有工具的完整列表
- 包含所有 feature-gated 工具（按 `process.env`、`feature()` 标志决定）
- 不考虑权限规则，不考虑 `isEnabled()` 状态
- 用于：system prompt 缓存稳定性计算、工具搜索阈值计算、preset 列表

**`getTools(permissionContext)`（会话工具集，`tools.ts:271`）：**
- 这是**决定本次会话有哪些工具**的核心函数
- 执行流程：
  1. 若 `CLAUDE_CODE_SIMPLE=true`，仅返回 `[BashTool, FileReadTool, FileEditTool]`（或 REPLTool）
  2. 从 `getAllBaseTools()` 过滤掉特殊工具（MCP 相关等）
  3. 调用 `filterToolsByDenyRules()` 过滤被 deny 规则整体禁止的工具
  4. 若 REPL 模式启用，过滤掉 `REPL_ONLY_TOOLS`（基础原语被 REPL 包装）
  5. 调用每个工具的 `isEnabled()` 过滤掉自报不可用的工具

**完整的工具池组装由 `assembleToolPool()` 完成**，它在 `getTools()` 基础上合并 MCP 工具，并对两个分区分别排序以保证 prompt cache 稳定性。

---

### Q5：条件工具（环境感知启用）的处理方式

**具体例子：REPLTool（仅 ant 内部员工可用）**

```typescript
// tools.ts:16-19
const REPLTool =
  process.env.USER_TYPE === 'ant'
    ? require('./tools/REPLTool/REPLTool.js').REPLTool
    : null
```

在 `getAllBaseTools()` 中：
```typescript
...(process.env.USER_TYPE === 'ant' && REPLTool ? [REPLTool] : []),
```

**其他条件工具的模式：**

| 模式 | 示例 | 机制 |
|------|------|------|
| `process.env.USER_TYPE === 'ant'` | REPLTool, ConfigTool, TungstenTool | 仅 Anthropic 内部员工构建 |
| `feature('PROACTIVE')` | SleepTool | GrowthBook 功能标志（编译时 bun:bundle dead-code-elimination） |
| `feature('AGENT_TRIGGERS')` | CronCreateTool, CronDeleteTool | 代理触发器特性 |
| `process.env.NODE_ENV === 'test'` | TestingPermissionTool | 测试环境专用 |
| `isToolSearchEnabledOptimistic()` | ToolSearchTool | 运行时功能检测 |
| `isPowerShellToolEnabled()` | PowerShellTool | 平台能力检测（Windows）|

**关键设计**：用 `require()` 而非 `import` 配合三元运算符，实现 Bun 的 dead code elimination——对于 `feature('X') ? require(...) : null`，Bun 在编译时可以完全剔除未启用的代码路径，缩小最终二进制大小。

---

### Q6：FileReadTool 的 `call()` 核心逻辑和返回格式

**核心逻辑（`FileReadTool.ts:496-651`）：**

1. **读取限制配置**：从 `context.fileReadingLimits` 获取 `maxTokens`、`maxSizeBytes`（支持调用方覆盖默认值）
2. **路径规范化**：`expandPath(file_path)` 展开 `~`、清理空白、统一路径分隔符
3. **去重检查（dedup）**：查询 `readFileState` 缓存——若文件范围完全匹配且 mtime 未变，直接返回 `{type: 'file_unchanged'}` stub，避免重复发送相同内容给模型（节省 cache_creation tokens）
4. **技能发现（副作用）**：`discoverSkillDirsForPaths()` 火后不等——读文件时顺带激活相关 skill 目录
5. **委托 `callInner()`**：实际读取，根据文件类型分支：
   - `.ipynb` → notebook 解析
   - 图片扩展名 → base64 编码 + 尺寸压缩
   - PDF → `readPDF()` 或 `extractPDFPages()`
   - 其他 → 文本读取，支持 `offset`/`limit` 行范围
6. **ENOENT 回退**：macOS 截图文件可能用细空格（U+202F），尝试替换后重试

**返回值格式（`ToolResult<Output>` 的 data 部分）：**

```typescript
// 文本文件
{ type: 'text', file: { filePath, content, numLines, startLine, totalLines } }

// 图片
{ type: 'image', file: { base64, type, originalSize, dimensions? } }

// Jupyter Notebook
{ type: 'notebook', file: { filePath, cells } }

// PDF（inline 模式）
{ type: 'pdf', file: { filePath, base64, originalSize } }

// PDF（提取为图片页面）
{ type: 'parts', file: { filePath, originalSize, count, outputDir } }

// 去重命中（文件未变化）
{ type: 'file_unchanged', file: { filePath } }
```

`mapToolResultToToolResultBlockParam()` 将上述格式转换为 API `tool_result` 块。文本文件追加行号前缀和内存鲜度提示；图片以 base64 块发送；`file_unchanged` 发送一个常量 stub 文本（`FILE_UNCHANGED_STUB`）。

---

### Q7：FileReadTool 的进度上报（onProgress）

FileReadTool **不使用 `onProgress`**。其 `call()` 签名接收 `_canUseTool?` 和 `parentMessage?` 但 `onProgress` 未被接收（签名中省略了第五个参数）：

```typescript
async call(
  { file_path, offset = 1, limit = undefined, pages },
  context,
  _canUseTool?,   // 不使用
  parentMessage?, // 用于 callInner 的 message ID
  // onProgress 未声明——FileReadTool 没有中间进度
)
```

**原因**：文件读取是原子操作，没有中间状态可以上报。UI 反馈通过以下方式实现：
- `getActivityDescription(input)` 返回 `"Reading {filePath}"`，供 Spinner 显示
- `renderToolUseMessage()` 立即渲染文件路径（流式渲染，input 流入时就显示）
- 完成后 `renderToolResultMessage()` 显示 "Read N lines" 摘要

**有 `onProgress` 上报的工具**：AgentTool（上报子 agent 的每条消息）、BashTool（上报命令输出流）、WebSearchTool（上报搜索进度）。

---

### Q8：AgentTool 的 `call()` 如何启动子 agent

**调用链（正常同步路径）：**

```
AgentTool.call()
  ├── 验证 & 路由（teammate spawn / fork / normal）
  ├── 解析 selectedAgent（AgentDefinition）
  ├── 构建 system prompt（fork 路径继承父 prompt，普通路径构建 agent 自己的）
  ├── 构建 promptMessages（fork: buildForkedMessages()，普通: createUserMessage()）
  ├── assembleToolPool() → worker 专属工具池
  ├── 可选: createAgentWorktree() → worktree 隔离
  ├── 构建 runAgentParams
  └── shouldRunAsync ?
      ├── [异步] registerAsyncAgent() → 注册后台任务
      │           void runWithAgentContext(() => runAsyncAgentLifecycle({
      │             makeStream: () => runAgent(runAgentParams)
      │             ...
      │           }))
      │           return { status: 'async_launched', agentId, outputFile }
      └── [同步] runAgent(runAgentParams) → AsyncIterator
                  while (true) {
                    const { result } = await Promise.race([
                      agentIterator.next(),
                      backgroundPromise  // 可能被 background
                    ])
                    onProgress(result)   // 上报每条消息
                  }
                  return { status: 'completed', result }
```

**`runAgent()` 是核心**（`AgentTool/runAgent.ts`），它返回 `AsyncGenerator`，逐条 yield 子 agent 产生的消息（包括工具调用、工具结果、文本等）。

---

### Q9：`forkSubagent.ts` 中，子 agent 继承 vs 隔离了什么

**Fork 子 agent 的核心设计思想**：最大化 prompt cache 命中率，让所有并行 fork 共享相同的 API 请求前缀。

**继承（子 agent 获得）：**

| 继承内容 | 实现机制 |
|---------|---------|
| 完整对话历史 | `forkContextMessages: toolUseContext.messages`，传给 `runAgent` |
| 父 agent 的 system prompt（字节级精确） | `toolUseContext.renderedSystemPrompt`（避免 GrowthBook 状态漂移重新计算） |
| 父 agent 的完整工具池 | `availableTools: toolUseContext.options.tools`（`useExactTools: true`） |
| 父 agent 的 thinking 配置 | 通过 `useExactTools` 从 runAgent 继承 `thinkingConfig` |
| 父 assistant 消息的所有 tool_use 块 | `buildForkedMessages()` 克隆整个 assistant message |

**隔离（子 agent 独立）：**

| 隔离内容 | 实现机制 |
|---------|---------|
| 子任务指令（directive） | 每个 fork 的 `prompt` 不同，作为最后一个 user message 块 |
| AbortController | 每个 fork 有独立的 abort 控制器 |
| 工作目录（可选） | `isolation: 'worktree'` 时创建独立 git worktree |
| agentId | 每个 fork 生成唯一 ID |
| 进度跟踪 | 独立的 `ProgressTracker` |

**Prompt Cache 最大化技巧**（`forkSubagent.ts:107-168`）：
- 所有 fork 子 agent 共享同一 assistant message（包含所有 tool_use 块）
- 所有 fork 的 tool_result placeholder 文本完全相同（`'Fork started — processing in background'`）
- 只有最后一个 text block（per-child directive）不同，所以 cache 命中率极高

---

### Q10：父 agent 如何等待子 agent 完成

**同步子 agent（`shouldRunAsync = false`）：**

使用 **AsyncGenerator + Promise.race**：

```typescript
// AgentTool.tsx:846-892
const agentIterator = runAgent({...})[Symbol.asyncIterator]()

while (true) {
  const nextMessagePromise = agentIterator.next()
  const raceResult = backgroundPromise
    ? await Promise.race([
        nextMessagePromise.then(r => ({ type: 'message', result: r })),
        backgroundPromise   // 可能随时变成 background
      ])
    : { type: 'message', result: await nextMessagePromise }

  if (raceResult.type === 'background') {
    // 转入后台继续执行，当前调用立即返回 async_launched
    void runAsyncAgentLifecycle(...)
    wasBackgrounded = true
    break
  }
  // 正常消息：调用 onProgress 上报给父 agent 的 UI
  onProgress({ toolUseID, data: { type: 'agent_progress', message: ... } })
  if (raceResult.result.done) break
}
```

- **模式**：AsyncGenerator 迭代（Pull-based，每次 `next()` 拉取一条消息）
- **可中断**：通过 `Promise.race([nextMessage, backgroundSignal])` 实现"随时转后台"
- **进度回调**：每个 yielded 消息通过 `onProgress` 上报（不是轮询，不是事件发射器）

**异步子 agent（`shouldRunAsync = true`）：**

```typescript
// AgentTool.tsx:686-764
registerAsyncAgent({...})  // 注册后台任务状态
void runWithAgentContext(() => runAsyncAgentLifecycle({
  makeStream: () => runAgent(runAgentParams),
  ...
}))
// 立即返回
return { data: { status: 'async_launched', agentId, outputFile } }
```

父 agent 不等待；子 agent 在 void 中独立运行，结果写到 `outputFile`（`{taskId}.output`），父 agent 可通过 FileReadTool 读取进度文件轮询。

---

### Q11：`useCanUseTool` 的完整决策流程

`canUseTool` 是通过 `hasPermissionsToUseTool`（核心权限引擎）+ UI 层（交互式提示）组合实现的。

**`hasPermissionsToUseTool` 的流水线（`permissions.ts:473+`）：**

```
Step 0: abortController 已触发? → reject AbortError

Step 1a: getDenyRuleForTool() → 整个工具被 deny 规则禁止?
         是 → 返回 {behavior: 'deny', source: 'rule'}

Step 1b: getAskRuleForTool() → 整个工具有 ask 规则?
         是（且不能 sandbox auto-allow）→ 返回 {behavior: 'ask'}

Step 1c: tool.checkPermissions(parsedInput, context)
         → 工具自定义权限检查（如 BashTool 检查具体命令是否匹配 allow/deny 规则）

Step 1d: tool.checkPermissions 返回 deny? → 透传 deny

Step 1e: tool.requiresUserInteraction()? → 直接返回 ask（无法 bypass）

Step 1f: checkPermissions 返回 content-level ask rule? → 透传 ask

Step 1g: safetyCheck（.git/, .claude/, shell config 等保护路径）→ 强制 ask

Step 2a: getToolAlwaysAllowRule() → 有 always-allow 规则?
         是 → 返回 {behavior: 'allow'}

Step 2b: bypassPermissions 模式? → 跳到 allow（除 safetyCheck）

Step 2c: PermissionRequest hooks（PreToolUse hooks）→ hook 返回 allow/deny?

Step 2d: acceptEdits 模式（只读工具）? → allow

Step 3: 以上都未决定 → 返回 {behavior: 'ask'}（需要用户交互）
```

**`useCanUseTool` 中 UI 层的后续处理（`useCanUseTool.tsx`）：**

```
hasPermissionsToUseTool() 返回 allow → 直接 resolve，记录 decision('accept', 'config')

hasPermissionsToUseTool() 返回 deny → resolve deny，记录 decision('reject', 'config')
  - auto 模式: 追加 UI 通知（"denied by auto mode"）

hasPermissionsToUseTool() 返回 ask:
  ├── awaitAutomatedChecksBeforeDialog? → handleCoordinatorPermission()（等 classifier）
  ├── handleSwarmWorkerPermission()（swarm worker 向 coordinator 请求批准）
  └── handleInteractivePermission()
      → 将确认请求放入 setToolUseConfirmQueue
      → 等待用户在 PermissionRequest UI 中点击
      → 用户选择后：
          - "Allow once"  → allow（不保存）
          - "Always allow" → allow + persistPermissionUpdates({destination: 'projectSettings', behavior: 'allow'})
          - "Deny"         → deny（不保存）
          - "Always deny"  → deny + persistPermissionUpdates({destination: 'projectSettings', behavior: 'deny'})
```

**PermissionMode 对流程的影响：**

| Mode | 行为 |
|------|------|
| `default` | 正常流程，ask 时弹框 |
| `acceptEdits` | 只读工具自动允许，写操作仍 ask |
| `dontAsk` | 所有 ask 自动转 deny |
| `bypassPermissions` | 跳过大多数 ask（保留 safetyCheck） |
| `auto` | 用 AI 分类器决策（不弹框） |
| `plan` | 类似 default，但模型只能读不能写 |

---

### Q12：「记住此选择」的数据存储位置

**存储结构：** `ToolPermissionRulesBySource`（按来源分层）

```typescript
type ToolPermissionRulesBySource = {
  userSettings?: PermissionRuleValue[]      // ~/.claude/settings.json
  projectSettings?: PermissionRuleValue[]   // {projectRoot}/.claude/settings.json
  localSettings?: PermissionRuleValue[]     // {projectRoot}/.claude/settings.local.json
  policySettings?: PermissionRuleValue[]    // 组织策略（MDM 管理）
  cliArg?: PermissionRuleValue[]            // --allow-tools 命令行参数
  command?: PermissionRuleValue[]           // /permissions 命令临时添加
  session?: PermissionRuleValue[]           // 本次会话内存中（不持久化）
}
```

**用户"记住此选择"时的实际写入：**

- 用户点击 "Always Allow" / "Always Deny" → `persistPermissionUpdates([{type: 'addRules', destination: 'projectSettings', ...}])`
- 写入路径：`{projectRoot}/.claude/settings.json` 中的 `permissions.allow` 或 `permissions.deny` 数组
- 同时调用 `context.setAppState()` 更新内存中的 `toolPermissionContext.alwaysAllowRules`（即时生效，下次调用同工具无需再问）

**运行时位置：** `AppState.toolPermissionContext.alwaysAllowRules / alwaysDenyRules`（`Tool.ts:126`），类型为 `ToolPermissionRulesBySource`（DeepImmutable）。

**重要**：`session` 来源的规则只存在内存中，进程重启后消失；`projectSettings` 来源的规则持久化在项目根目录，是最常见的"记住此选择"目标。

---

## 二、核心产出

### 2.1 Tool 接口结构图（文字版）

```
Tool<Input, Output, Progress> {
  // ── 元数据 ──────────────────────────────────
  name: string                          // 唯一标识，用于工具查找和权限规则匹配
  aliases?: string[]                    // 向后兼容旧名称
  searchHint?: string                   // ToolSearch 关键词（3-10 词）
  maxResultSizeChars: number            // 超出后结果持久化到磁盘
  strict?: boolean                      // API 严格模式
  isMcp?: boolean                       // MCP 来源标志
  shouldDefer?: boolean                 // 延迟加载（需 ToolSearch 激活）
  alwaysLoad?: boolean                  // 始终出现在初始 prompt

  // ── Schema ──────────────────────────────────
  inputSchema: Input                    // Zod schema：输入校验 + 类型推断
  inputJSONSchema?: ToolInputJSONSchema // MCP 工具备用（非 Zod）
  outputSchema?: z.ZodType             // 输出 schema（可选）

  // ── 动态描述 ────────────────────────────────
  description(input, opts) → Promise<string>  // 权限提示文案
  prompt(opts) → Promise<string>              // System prompt 贡献
  userFacingName(input) → string             // UI 显示名称
  getToolUseSummary(input) → string | null   // 紧凑视图摘要
  getActivityDescription(input) → string | null // Spinner 文案

  // ── 核心执行 ────────────────────────────────
  call(args, ctx, canUseTool, parentMsg, onProgress?) → Promise<ToolResult<Output>>

  // ── 能力声明 ────────────────────────────────
  isEnabled() → boolean                 // 是否在当前环境可用
  isConcurrencySafe(input) → boolean   // 是否可与其他工具并发执行
  isReadOnly(input) → boolean          // 是否只读（影响权限检查）
  isDestructive(input?) → boolean      // 是否不可逆（删除/覆盖/发送）
  isSearchOrReadCommand(input) → {...}  // UI 折叠提示
  isOpenWorld(input) → boolean         // 是否开放世界操作
  requiresUserInteraction?() → boolean // 必须用户交互（无法 bypass）
  interruptBehavior?() → 'cancel'|'block' // 新消息到来时行为

  // ── 权限 ─────────────────────────────────────
  validateInput(input, ctx) → Promise<ValidationResult>  // 输入合法性（在权限前）
  checkPermissions(input, ctx) → Promise<PermissionResult> // 工具级权限检查
  preparePermissionMatcher(input) → Promise<(pattern) => bool> // Hook if 条件
  backfillObservableInput(input) → void // 钩子/权限系统看到 input 前预处理

  // ── API 序列化 ───────────────────────────────
  mapToolResultToToolResultBlockParam(output, toolUseID) → ToolResultBlockParam
  toAutoClassifierInput(input) → unknown  // 安全分类器输入
  extractSearchText(output) → string      // Transcript 搜索索引文本
  isResultTruncated(output) → boolean     // 是否可展开

  // ── UI 渲染 ──────────────────────────────────
  renderToolUseMessage(input, opts) → ReactNode          // 工具调用时的 UI
  renderToolResultMessage?(output, progress, opts) → ReactNode  // 结果 UI
  renderToolUseProgressMessage?(progress, opts) → ReactNode     // 进度 UI
  renderToolUseRejectedMessage?(input, opts) → ReactNode        // 拒绝 UI
  renderToolUseErrorMessage?(result, opts) → ReactNode          // 错误 UI
  renderGroupedToolUse?(toolUses, opts) → ReactNode | null      // 批量 UI
  renderToolUseTag?(input) → ReactNode   // 附加标签（模型名、超时等）
  renderToolUseQueuedMessage?() → ReactNode // 排队等待 UI

  // ── 路径信息 ─────────────────────────────────
  getPath?(input) → string             // 提取文件路径（供权限系统使用）
  inputsEquivalent?(a, b) → boolean    // 输入等价判断（去重）
}
```

**工厂函数 `buildTool(def: ToolDef) → Tool`**：接受省略了 defaultable 方法的 `ToolDef`，填入安全默认值后返回完整 `Tool`。所有工具通过此函数构建，保证接口完整性。

---

### 2.2 模式卡片 #2：Tool 接口统一抽象

**问题：** 如何让能力差异极大的工具（文件读取、Bash 执行、网络请求、子 agent 启动、MCP 代理）被模型以完全统一的方式调用，且能在权限系统、UI、序列化各层次无缝处理？

**方案（基于代码的具体描述）：**

1. **单一 `Tool<Input, Output, Progress>` 泛型接口**（`Tool.ts:362`）——类型参数让每个工具的输入/输出/进度都有精确类型，但调用框架可以用 `Tool<AnyObject, unknown>` 统一持有。
2. **`buildTool()` + `ToolDef`**（`Tool.ts:783`）——工厂函数模式：工具只需声明自己的差异，安全默认值（fail-closed：`isConcurrencySafe=false`, `isReadOnly=false`, `checkPermissions=allow`）由框架统一填入，避免忘记实现关键方法。
3. **JSON Schema (`ToolInputJSONSchema`) 作为 API 边界**——MCP 工具可直接提供 JSON Schema，内置工具通过 Zod schema 自动转换。两种路径最终都生成标准的 JSON Schema 发给 API。
4. **`inputSchema` 用 Zod 而非纯 TypeScript 类型**——Zod 同时提供：运行时校验（`tool.inputSchema.parse(input)`）+ 类型推断（`z.infer<Input>`）+ JSON Schema 生成（发给 API）。纯 TS 类型只存在编译时，无法做到三者合一。
5. **`mapToolResultToToolResultBlockParam()`**——每个工具自己知道如何将结构化输出序列化为 API `tool_result`，文本/图片/notebook 各有实现，框架无需知道内部结构。

**关键设计决策：为什么 inputSchema 用 JSON Schema 而非 TypeScript 类型？**

JSON Schema 是唯一能同时满足三个需求的格式：
- **运行时校验**：`z.infer<Input>` 在 `call()` 前由框架调用 `tool.inputSchema.parse(input)` 验证模型输出的合法性
- **API 通信**：模型调用工具时，框架需要把工具定义发给 Anthropic API，格式必须是 JSON Schema
- **文档生成**：`description` 字段内嵌在 JSON Schema 中，模型从中理解每个参数的含义

TypeScript 类型在编译后全部擦除，无法在运行时读取，更无法序列化发给 API。

**适用条件：** 需要将异构能力（文件 I/O、进程执行、网络、子系统调用）统一暴露给模型/框架/UI 时。

**权衡：**
- 优：接口统一，框架代码（权限、序列化、UI）只需面对 `Tool` 接口，不关心实现
- 优：`buildTool()` 的默认值保证 fail-closed，新工具无法遗漏关键安全方法
- 劣：接口过大（~40 个成员），实现完整工具需要大量样板代码
- 劣：渲染方法（renderToolUseMessage 等）与执行逻辑耦合在同一接口，违反关注点分离

---

### 2.3 模式卡片 #3：进度上报与 UI 解耦

**问题：** 工具执行时（如 AgentTool 运行子 agent、BashTool 执行长命令），如何将中间进度实时推送到 UI，且工具逻辑不依赖任何 UI 框架（如 React/Ink）？

**方案（基于代码的具体描述）：**

1. **`onProgress?: ToolCallProgress<P>` 回调注入**（`Tool.ts:384`）——框架在调用 `tool.call()` 时注入进度回调，工具内部调用 `onProgress({ toolUseID, data: P })` 上报进度。工具不持有任何 UI 引用。
2. **`ProgressMessage` 中间格式**——`onProgress` 的数据先存入消息历史（`ProgressMessage<ToolProgressData>`），UI 组件从消息历史中读取，实现数据与视图的时序解耦。
3. **`renderToolUseProgressMessage(progressMessages, opts) → ReactNode`**——每个工具自定义如何将进度消息渲染为 React 节点。进度数据是纯数据，渲染逻辑封装在工具的渲染方法中。
4. **AgentTool 的具体实现**：子 agent 每产出一条消息，`runAgent` generator yield 该消息，AgentTool 的 while 循环收到后调用 `onProgress({ data: { type: 'agent_progress', message } })`，UI 的 `renderToolUseProgressMessage` 将其渲染为可折叠的消息列表。

**关键设计决策：onProgress 回调 vs 事件发射器 vs 响应式流？**

| 方案 | 分析 |
|------|------|
| **onProgress 回调（现方案）** | 函数注入，工具不持有框架引用；类型参数 `P` 限定进度类型；无需额外基础设施；与 async/await 自然组合 |
| EventEmitter | 工具需 `import EventEmitter`，或继承 EventEmitter 类；事件名是字符串（类型不安全）；需要手动清理监听器（内存泄漏风险） |
| RxJS Observable | 强大但是重量级依赖；学习曲线陡；与现有 async/await 代码混用摩擦大 |
| AsyncGenerator（直接） | `runAgent` 内部用了 AsyncGenerator；但在工具接口层用 Generator 会破坏 `call()` 返回 `Promise<ToolResult>` 的统一签名 |

onProgress 回调是最轻量的解耦方案：工具代码保持纯函数风格，框架通过闭包注入 UI 更新逻辑，双方通过 `ToolProgressData` 类型契约通信。

**适用条件：** 执行时间超过秒级的工具；有自然的中间状态（每条命令输出、每条子 agent 消息）；工具逻辑希望与 UI 框架完全解耦。

**权衡：**
- 优：工具本身无 UI 依赖，可在非 UI 上下文（SDK、测试）中使用，进度回调直接 noop
- 优：类型安全——`P extends ToolProgressData` 让每个工具的进度格式有精确类型
- 劣：进度数据存入消息历史再读出，有一层间接性，增加调试复杂度
- 劣：onProgress 是可选的（`?`），工具无法强制框架提供进度通道

---

## 三、关键洞察总结

### 3.1 工具注册的三层过滤

```
所有可能工具（getAllBaseTools）
    ↓ 按 feature flag / env 条件导入
已启用工具（compile-time / runtime gating）
    ↓ filterToolsByDenyRules()
未被 deny 规则整体禁止的工具
    ↓ isEnabled() / REPL_ONLY_TOOLS 过滤
    ↓ assembleToolPool() + MCP 工具合并
本次会话的工具池（getTools + MCP）
```

### 3.2 权限系统的多层次

```
Layer 1: 工具级规则（allow/deny 整个工具）
Layer 2: 内容级规则（Bash(git *) / Read(~/.ssh/*)）
Layer 3: 工具 checkPermissions（工具自定义逻辑）
Layer 4: Safety checks（.git/, .claude/ 保护路径）
Layer 5: Hooks（PreToolUse，外部进程判断）
Layer 6: 用户交互（弹框确认 / always allow/deny → 持久化）
Layer 7: 模式 override（bypassPermissions / dontAsk / auto）
```

每层失败关闭（fail-closed）：不确定时 → ask，不是 allow。

### 3.3 子 agent 的状态边界

```
父 agent 传递给子 agent：
  ✓ 对话历史（messages）— fork 路径
  ✓ System prompt（byte-exact，避免 GrowthBook 漂移）— fork 路径
  ✓ 工具池（exact copy）— fork 路径
  ✗ AppState（子 agent 有自己的 setAppState，异步子 agent 的是 no-op）
  ✗ AbortController（后台子 agent 独立，不随父 ESC 取消）
  ✗ toolPermissionContext.mode（子 agent 用 selectedAgent.permissionMode）
```

这个设计使得子 agent 既能访问父 agent 的完整上下文（对话历史），又在执行环境上与父 agent 隔离（独立取消、独立权限模式）。

---

*精读完成，文件：`Task.ts`、`tools.ts`、`FileReadTool/`、`AgentTool/AgentTool.tsx`、`AgentTool/forkSubagent.ts`、`hooks/useCanUseTool.tsx`、`utils/permissions/permissions.ts`*
