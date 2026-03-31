# Task 3：六大子系统速览与边界图

## 各子系统速览

### 子系统 1：Agent 核心循环

**query() 函数签名**（`src/query.ts` 第 219 行）：

```typescript
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

- 输入：`QueryParams`（含消息历史、工具列表、系统提示等）
- 输出：异步生成器，每次 yield 一个流事件或消息，最终 return `Terminal`（终止状态）
- 内部委托给 `queryLoop()` 私有函数，`query()` 本身只做命令生命周期通知的包装

**QueryEngine 结构**（`src/QueryEngine.ts`）：

- 是一个**类**（`export class QueryEngine`），不是函数
- 配置类型：`QueryEngineConfig`（含 `cwd`、`tools`、`commands`、`mcpClients`、`agents`、`canUseTool`、`getAppState/setAppState`、`maxTurns`、`maxBudgetUsd` 等）
- 主要公开方法：
  - `async *submitMessage(prompt, options?)` — 核心方法，接受用户输入，返回 `AsyncGenerator<SDKMessage>`
  - `getMessages(): readonly Message[]` — 读取当前消息历史
  - `getReadFileState(): FileStateCache` — 读取文件缓存状态
  - `getSessionId(): string` — 读取会话 ID
- 私有状态：`mutableMessages`、`abortController`、`permissionDenials`、`readFileState`、`discoveredSkillNames`、`loadedNestedMemoryPaths`
- `QueryEngine` 是 SDK 模式下的入口，CLI 模式下直接使用 `query()` 函数

---

### 子系统 2：工具系统

**getTools() 签名**（`src/tools.ts` 第 271 行）：

```typescript
export const getTools = (permissionContext: ToolPermissionContext): Tools => { ... }
```

- 返回类型：`Tools`（即 `Tool[]`，定义在 `src/Tool.ts`）
- 底层调用 `getAllBaseTools()` 获取全量工具列表，再按权限上下文过滤

**工具注册方式**：混合模式——静态列表 + 特性标志动态裁剪

`getAllBaseTools()` 中的注册方式分三层：
1. **静态导入**（始终加载）：`AgentTool`、`BashTool`、`FileReadTool`、`FileEditTool`、`FileWriteTool`、`GlobTool`、`GrepTool`、`SkillTool`、`WebFetchTool`、`TodoWriteTool`、`WebSearchTool` 等核心工具
2. **环境变量条件**（`process.env.USER_TYPE === 'ant'`）：`REPLTool`、`SuggestBackgroundPRTool`、`ConfigTool`、`TungstenTool`
3. **特性标志条件**（`feature('XXX')`）：`SleepTool`（PROACTIVE/KAIROS）、`CronCreateTool/CronDeleteTool/CronListTool`（AGENT_TRIGGERS）、`RemoteTriggerTool`、`MonitorTool`、`WorkflowTool` 等

`tools/shared/` 目录下共享工具（`gitOperationTracking.ts`、`spawnMultiAgent.ts`）供多个工具使用。

---

### 子系统 3：多智能体

**Task 具体类型**（来自 `src/Task.ts` + `src/tasks/types.ts` + 目录结构）：

| TaskType 字面量 | ID 前缀 | 对应实现 |
|---|---|---|
| `local_bash` | `b` | `LocalShellTask/`（目录）|
| `local_agent` | `a` | `LocalAgentTask/`（目录）|
| `remote_agent` | `r` | `RemoteAgentTask/`（目录）|
| `in_process_teammate` | `t` | `InProcessTeammateTask/`（目录）|
| `local_workflow` | `w` | `LocalWorkflowTask/`（目录，在 types.ts 引用）|
| `monitor_mcp` | `m` | `MonitorMcpTask/`（目录，在 types.ts 引用）|
| `dream` | `d` | `DreamTask/`（目录）|

还有一个特殊文件 `LocalMainSessionTask.ts`，对应主会话自身（不在 TaskType 枚举中）。

**TaskStatus**：`pending | running | completed | failed | killed`

`tasks/` 目录完整结构：
```
src/tasks/
  DreamTask/
  InProcessTeammateTask/
  LocalAgentTask/
  LocalMainSessionTask.ts
  LocalShellTask/
  RemoteAgentTask/
  pillLabel.ts
  stopTask.ts
  types.ts
```

`src/Task.ts` 定义 `Task` 接口（只含 `name`、`type`、`kill()` 方法），是多态分派的最小接口。

---

### 子系统 4：插件/技能系统

**Plugin 目录**：`src/services/plugins/`
```
src/services/plugins/
  pluginCliCommands.ts
  PluginInstallationManager.ts
  pluginOperations.ts
```
加载入口：`src/utils/plugins/pluginLoader.ts`（被 `QueryEngine.ts` 的 `loadAllPluginsCacheOnly()` 调用）

**Skill 目录**：`src/skills/`
```
src/skills/
  bundled/         （内置 skills 资源）
  bundledSkills.ts （内置 skills 注册）
  loadSkillsDir.ts （从目录加载 skills）
  mcpSkillBuilders.ts（MCP 协议的 skill 构建器）
```

**SkillTool 目录**：`src/tools/SkillTool/`
```
src/tools/SkillTool/
  constants.ts
  prompt.ts
  SkillTool.ts   （工具实现主文件）
  UI.tsx
```

`SkillTool.ts` 前 30 行显示它从 `src/commands.js`、`src/Tool.js` 等导入，是 Skill 子系统与工具系统的桥接点。Plugin 负责外部扩展的安装管理，Skill 负责具体能力的加载与执行，SkillTool 是 AI 模型调用 Skill 的工具接口。

---

### 子系统 5：上下文与内存管理

**memdir.ts 管理的内存类型**：

`src/memdir/memdir.ts` 管理的是**持久化文件内存**（磁盘上的 `MEMORY.md`）：
- 入口文件名：`MEMORY.md`（常量 `ENTRYPOINT_NAME`）
- 最大行数限制：200 行（`MAX_ENTRYPOINT_LINES`）
- 最大字节限制：25,000 字节（`MAX_ENTRYPOINT_BYTES`）
- 提供 `loadMemoryPrompt()`（被 `QueryEngine.ts` 调用）将记忆内容注入系统提示
- 支持自动记忆路径（`isAutoMemoryEnabled()`）和团队记忆（feature `TEAMMEM`）

**与 SessionStorage 的对比**：
- `memdir`：跨会话持久化，写入磁盘文件，人类可读，用于长期知识积累
- `sessionStorage`（`src/utils/sessionStorage.ts`）：单会话内持久化，存储对话记录（transcript），会话结束后可供回溯，但不是跨会话记忆

**SessionMemory 目录**（`src/services/SessionMemory/`）：
```
src/services/SessionMemory/
  prompts.ts
  sessionMemory.ts
  sessionMemoryUtils.ts
```
SessionMemory 负责会话内的摘要/压缩记忆（autoCompact 调用 `setLastSummarizedMessageId`），是 compact 操作的记录层。

**autoCompact 主函数**（`src/services/compact/autoCompact.ts`）：

关键函数：
```typescript
export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
}

export function isAutoCompactEnabled(): boolean

export function getAutoCompactThreshold(model: string): number
```

`calculateTokenWarningState` 被 `src/query.ts` 导入，在每次 query 循环中检查 token 使用量是否触发自动压缩阈值。触发条件：`tokenUsage >= autoCompactThreshold`（默认为 contextWindow - 20,000 - 13,000 的保留 tokens）。

---

### 子系统 6：安全与沙箱

**BashTool 目录分层**（`src/tools/BashTool/`）：
```
src/tools/BashTool/
  BashTool.tsx              [执行层] 工具主入口，协调验证和执行
  bashCommandHelpers.ts     [执行层] 命令辅助函数
  utils.ts                  [执行层] 通用工具函数
  commandSemantics.ts       [验证层] 命令语义分析
  commentLabel.ts           [验证层] 命令注释标签处理
  destructiveCommandWarning.ts [安全层] 破坏性命令警告
  modeValidation.ts         [验证层] 模式验证（只读/读写等）
  pathValidation.ts         [安全层] 路径安全验证
  readOnlyValidation.ts     [验证层] 只读模式验证
  sedEditParser.ts          [验证层] sed 命令解析
  sedValidation.ts          [安全层] sed 命令安全验证
  bashPermissions.ts        [安全层] 权限检查入口
  bashSecurity.ts           [安全层] 安全策略核心
  shouldUseSandbox.ts       [安全层] 沙箱决策
  BashToolResultMessage.tsx [UI 层] 结果展示
  UI.tsx                    [UI 层] 工具 UI 组件
  prompt.ts                 [配置层] 提示词定义
  toolName.ts               [配置层] 工具名称常量
```

**utils/bash/ 目录**（低层 bash 解析与分析）：
```
src/utils/bash/
  ast.ts              bash AST 节点定义
  bashParser.ts       bash 解析器主文件
  bashPipeCommand.ts  管道命令解析
  commands.ts         命令注册表
  heredoc.ts          heredoc 解析
  ParsedCommand.ts    解析结果类型
  parser.ts           底层 parser
  prefix.ts           命令前缀处理
  registry.ts         命令语义注册
  shellCompletion.ts  shell 补全
  shellPrefix.ts      shell 前缀检测
  shellQuote.ts       shell 引号处理
  shellQuoting.ts     引号策略
  ShellSnapshot.ts    shell 状态快照
  specs/              命令规范定义
  treeSitterAnalysis.ts tree-sitter AST 分析
```

**utils/permissions/ 目录**（权限规则引擎）：
```
src/utils/permissions/
  autoModeState.ts       自动模式状态管理
  bashClassifier.ts      bash 命令分类器
  bypassPermissionsKillswitch.ts  权限绕过开关
  classifierDecision.ts  分类决策
  classifierShared.ts    分类共享逻辑
  dangerousPatterns.ts   危险模式匹配
  denialTracking.ts      拒绝记录追踪
  filesystem.ts          文件系统权限
  getNextPermissionMode.ts  模式切换逻辑
  pathValidation.ts      路径验证
  permissionExplainer.ts 权限解释（用户提示）
  PermissionMode.ts      权限模式枚举
  PermissionPromptToolResultSchema.ts  权限提示协议
  PermissionResult.ts    权限结果类型
  PermissionRule.ts      规则类型定义
  permissionRuleParser.ts  规则解析
  permissions.ts         权限检查主入口
  permissionSetup.ts     权限初始化
  permissionsLoader.ts   权限配置加载
  PermissionUpdate.ts    权限更新事件
  PermissionUpdateSchema.ts  更新协议
  shadowedRuleDetection.ts  规则遮蔽检测
  shellRuleMatching.ts   shell 规则匹配
  yoloClassifier.ts      YOLO 模式分类器
```

---

## 系统边界图

```
[子系统 1：Agent 核心循环]
  ├── 直接依赖 → [子系统 2：工具系统]（执行 tool_use 块）
  ├── 直接依赖 → [子系统 5：上下文/内存管理]（注入 memdir、触发 autoCompact）
  ├── 直接依赖 → [子系统 6：安全/沙箱]（通过 canUseTool 检查权限）
  ├── 直接依赖 → [子系统 3：多智能体]（AgentTool 产生子任务）
  ├── 提供给 → CLI 入口（query() 函数）/ SDK 入口（QueryEngine.submitMessage()）
  └── 数据流：UserMessage → [LLM API] → StreamEvent/ToolUse → Message → Terminal

[子系统 2：工具系统]
  ├── 直接依赖 → [子系统 6：安全/沙箱]（BashTool 调用 bashPermissions/bashSecurity）
  ├── 直接依赖 → [子系统 4：插件/技能系统]（SkillTool 调用 skill 加载器）
  ├── 直接依赖 → [子系统 3：多智能体]（AgentTool 生成 LocalAgentTask）
  ├── 提供给 → [子系统 1：Agent 核心循环]（工具执行结果作为 ToolResult 返回）
  └── 数据流：ToolUseBlock → [工具实现] → ToolResultBlockParam

[子系统 3：多智能体]
  ├── 直接依赖 → [子系统 1：Agent 核心循环]（LocalAgentTask 内部运行 query()）
  ├── 直接依赖 → [子系统 2：工具系统]（TaskStopTool、TaskOutputTool 等）
  ├── 提供给 → [子系统 1：Agent 核心循环]（AgentTool 的调用结果）
  └── 数据流：AgentTool 调用 → TaskState(pending) → TaskState(running) → TaskState(completed/failed)

[子系统 4：插件/技能系统]
  ├── 直接依赖 → [子系统 2：工具系统]（SkillTool 是技能的工具接口）
  ├── 提供给 → [子系统 1：Agent 核心循环]（QueryEngine 预加载插件缓存）
  └── 数据流：Plugin 安装/配置 → Skill 目录加载 → SkillTool 暴露给 LLM

[子系统 5：上下文与内存管理]
  ├── 直接依赖 → [子系统 1：Agent 核心循环]（memdir 注入系统提示，compact 裁剪消息历史）
  ├── 提供给 → [子系统 1：Agent 核心循环]（内存提示内容、压缩后消息列表）
  └── 数据流：MEMORY.md → loadMemoryPrompt() → SystemPrompt 注入
              消息历史 token 超限 → autoCompact() → 压缩后历史 + SessionMemory 记录

[子系统 6：安全与沙箱]
  ├── 直接依赖 → 无（叶子节点，不依赖其他子系统）
  ├── 提供给 → [子系统 2：工具系统]（BashTool 的安全检查）
  ├── 提供给 → [子系统 1：Agent 核心循环]（canUseTool 权限拦截）
  └── 数据流：ToolUse 请求 → PermissionRule 匹配 → Allow/Deny/AskUser
```

---

## 核心节点分析

**核心枢纽（被多个系统依赖）**：

1. **子系统 1：Agent 核心循环** — 最核心的枢纽。所有其他子系统最终都服务于它：工具系统提供执行能力，内存管理提供上下文，安全沙箱提供护栏，多智能体在其内部嵌套运行，插件/技能通过 SkillTool 接入。`query()` 是整个系统的生命线。

2. **子系统 2：工具系统** — 第二核心枢纽。作为 Agent 能力的载体，连接安全层（BashTool）、技能层（SkillTool）和多智能体层（AgentTool）。`getTools()` 是工具注册的单一真相来源。

**中间节点（双向依赖）**：

3. **子系统 3：多智能体** — 既依赖核心循环（子任务内部运行 query()），也被核心循环依赖（AgentTool 触发子任务）。形成递归结构。

4. **子系统 5：上下文与内存管理** — 为核心循环提供服务，autoCompact 的触发点在 query.ts 内部，形成单向依赖。

**叶子节点（只提供服务，不依赖其他子系统）**：

5. **子系统 6：安全与沙箱** — 纯粹的提供方。`utils/permissions/` 是独立的规则引擎，`utils/bash/` 是独立的解析层，不依赖任何业务子系统。这种设计让安全层可以独立测试和演进。

6. **子系统 4：插件/技能系统** — 接近叶子节点，主要是加载时依赖（Plugin 安装 → Skill 目录 → SkillTool），运行时被工具系统调用。

---

## 关键发现

1. **`query()` 是异步生成器，而非 Promise** — 这一设计使 UI 层能够实时流式渲染每个 token 和事件，而不是等待完整响应。`QueryEngine.submitMessage()` 也是异步生成器，SDK 模式下的流式输出依赖同一机制。

2. **工具注册是"静态列表 + 特性标志裁剪"的混合模式** — `getAllBaseTools()` 在模块加载时确定工具集（通过 `feature('XXX')` 和 `process.env` 判断），`getTools()` 在运行时按权限上下文过滤。没有运行时动态注册机制，扩展需要通过特性标志或 MCP 协议。

3. **多智能体形成递归结构** — `LocalAgentTask` 内部会启动一个新的 `query()` 循环，7 种 TaskType 对应 7 种不同的并发执行模型（本地 bash、本地 agent、远程 agent、进程内队友、工作流、MCP 监控、dream）。

4. **安全层是完全解耦的独立子系统** — `utils/permissions/` 有自己的规则解析器、分类器、路径验证等，`utils/bash/` 有完整的 bash AST 解析（基于 tree-sitter）。这两个模块不引用任何业务逻辑，是整个系统中内聚度最高的部分。

5. **memdir（MEMORY.md）和 SessionMemory 服务于不同时间尺度** — memdir 是跨会话的长期记忆（磁盘文件，人工维护），SessionMemory 是单会话内的压缩摘要（由 autoCompact 自动管理），两者共同构成分层记忆体系。autoCompact 的触发阈值设计（保留 33,000 tokens 的缓冲区）体现了对上下文窗口利用率的精细控制。
