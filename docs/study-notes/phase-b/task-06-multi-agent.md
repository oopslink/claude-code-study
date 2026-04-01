---
---
# Task 06：多智能体架构精读

> 源码路径：`src/Task.ts`、`src/tasks/`、`src/utils/swarm/inProcessRunner.ts`、`src/coordinator/coordinatorMode.ts`
> 精读时间：2026-03-31

---

## 一、Task 基础抽象

### 1.1 Task 接口核心字段与方法

`Task` 接口（`src/Task.ts`）是一个**调度句柄**，极度精简：

```ts
export type Task = {
  name: string
  type: TaskType
  kill(taskId: string, setAppState: SetAppState): Promise<void>
}
```

它只做一件事：**持有类型标识，并知道如何终止自身**。注释说 spawn/render 曾经是多态调用但已移除（#22546），现在 `kill` 是唯一多态方法。

**与 Tool 的核心区别：**

| 维度 | Tool | Task |
|------|------|------|
| 调用方 | 模型（LLM 生成 tool_use 块） | 框架/父 agent（代码调度） |
| 执行模型 | 同步或异步，单次调用 | 异步、长期运行，有完整生命周期 |
| 状态 | 无持久状态 | 在 AppState.tasks 中持有完整状态 |
| 取消 | 无需取消 | 必须支持 kill |
| 上报 | 返回 tool_result 给模型 | 通过 enqueuePendingNotification 异步上报 |

真正的持久状态保存在 `TaskStateBase` 以及各子类的 `*TaskState` 中。

### 1.2 Task 状态机

```
pending → running → completed
                  → failed
                  → killed
```

状态定义：

```ts
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'
```

终态判断函数 `isTerminalTaskStatus()` 标记 `completed / failed / killed` 为不可再转移的终态。

**转换条件：**

- `pending → running`：任务被框架注册并开始执行（调用 `registerTask` 时通常直接写为 `running`）
- `running → completed`：子 agent 成功返回结果（`completeAgentTask`）或远程 session 归档（`archived`）
- `running → failed`：抛出未捕获异常（`failAgentTask`）或远程任务超时/错误
- `running → killed`：父 agent 调用 `kill()` / `killAsyncAgent()` / 用户 ESC 取消

终态后：`evictAfter` 字段被设置（`Date.now() + PANEL_GRACE_MS`），到期后输出文件被清理（`evictTaskOutput`）。

### 1.3 TaskType 七种类型

```ts
export type TaskType =
  | 'local_bash'         // b 前缀
  | 'local_agent'        // a 前缀
  | 'remote_agent'       // r 前缀
  | 'in_process_teammate'// t 前缀
  | 'local_workflow'     // w 前缀
  | 'monitor_mcp'        // m 前缀
  | 'dream'              // d 前缀
```

| 类型 | 典型使用场景 |
|------|------------|
| `local_bash` | 父 agent 调用 BashTool 执行的后台 shell 命令，需要独立进度跟踪 |
| `local_agent` | AgentTool 启动的异步后台子 agent（coordinator 的 worker） |
| `remote_agent` | ultraplan / ultrareview / autofix-pr 等在云端 CCR 环境运行的远程 agent |
| `in_process_teammate` | Swarm 模式下在同进程内运行的 teammate，通过 AsyncLocalStorage 隔离 |
| `local_workflow` | 本地工作流编排（多步顺序任务的容器） |
| `monitor_mcp` | 监控 MCP 服务器状态的长期轮询任务 |
| `dream` | 推测性预计算任务（后台猜测用户下一步输入） |

---

## 二、LocalAgentTask 精读

### 2.1 创建独立 QueryEngine 实例

LocalAgentTask 本身不直接创建 QueryEngine。它依赖 `runAgent()` 函数（`src/tools/AgentTool/runAgent.ts`），该函数调用 `createSubagentContext()` 创建隔离的 `ToolUseContext`，再调用 `query()` 运行 agent 循环。

`createSubagentContext()` 的关键配置（`src/utils/forkedAgent.ts`）：

```ts
const agentToolUseContext = createSubagentContext(toolUseContext, {
  options: agentOptions,       // 子 agent 的工具集、模型等
  agentId,                     // 新分配的 AgentId
  agentType: agentDefinition.agentType,
  messages: initialMessages,
  readFileState: agentReadFileState,
})
```

### 2.2 父子 agent 的上下文共享与隔离

由 `createSubagentContext()` 的 `SubagentContextOverrides` 明确控制：

**子 agent 从父继承（共享）的字段：**
- `setAppStateForTasks`：任务注册/终止必须写入根 Store，防止后台 bash 任务僵尸（注释：PPID=1 zombie）
- `contentReplacementState`（克隆而非共享）：克隆父状态，确保对相同 tool_use_id 做相同替换决策，保证 prompt cache 命中

**子 agent 独立（隔离）的字段：**
- `readFileState`：克隆父的文件缓存，防止子 agent 污染父的文件读取状态
- `abortController`：新建子控制器，链接父（父 abort 会传播给子，但子 abort 不影响父）
- `getAppState`：包装后强制设置 `shouldAvoidPermissionPrompts: true`，防止后台任务弹出权限确认 UI
- `setAppState`：默认为 no-op（`() => {}`），后台子 agent 不直接更新 UI 状态
- `setResponseLength`：no-op
- `setInProgressToolUseIDs`：no-op
- `localDenialTracking`：新建，避免父子 denial 计数器混用
- `nestedMemoryAttachmentTriggers`、`loadedNestedMemoryPaths`、`dynamicSkillDirTriggers`：新建空集合
- `toolDecisions`：undefined（新建）

**结论：子 agent 获得共享数据的快照（克隆），但写操作完全隔离。**

### 2.3 SubagentContextOverrides 完整定义与设计动机

`SubagentContextOverrides` 类型定义（`src/utils/forkedAgent.ts:260-304`）包含以下字段及其处理方式：

**覆盖字段（override）—— 显式控制子 agent 的配置：**

| 字段 | 类型 | 处理方式 | 设计动机 |
|------|------|---------|---------|
| `options` | `ToolUseContext['options']` | 直接用 override 或继承父 | 子 agent 可有不同的工具集/模型配置 |
| `agentId` | `AgentId` | override 或自动生成新 ID | 每个子 agent 需要独立的身份标识 |
| `agentType` | `string` | override 或不设置 | 子 agent 可指定专用 agent 类型 |
| `messages` | `Message[]` | override 或继承父 | 子 agent 可从特定消息状态开始 |
| `readFileState` | `ToolUseContext['readFileState']` | override 或克隆父 | 子 agent 读文件不污染父的缓存 |
| `abortController` | `AbortController` | override 或新建 | 子 agent 有独立的取消信号树 |
| `getAppState` | `ToolUseContext['getAppState']` | override 或包装后设置权限提示 | 后台子 agent 不弹权限 UI |
| `contentReplacementState` | `ContentReplacementState` | override 或克隆父 | 确保 prompt cache 稳定性 |
| `criticalSystemReminder_EXPERIMENTAL` | `string` | override 或不设置 | 实验性：每轮注入关键提示 |

**共享开关字段（shareXxx flags）—— 显式决定是否共享父的回调：**

| 字段 | 默认值 | 处理方式 | 为什么需要克隆或隔离 |
|------|-------|---------|---------------------|
| `shareSetAppState` | `false` | 如 true 则共享父的回调；否则 no-op | 后台子 agent（LocalAgentTask）不应该更新父的 UI 状态，防止竞态条件；交互式子 agent（InProcessTeammate）可选择共享 |
| `shareSetResponseLength` | `false` | 如 true 则共享父的回调；否则 no-op | 后台子 agent 的响应长度不应该累积到父的指标中；只有交互式 subagent 才需要 |
| `shareAbortController` | `false` | 如 true 则直接用父的 abortController；否则新建子控制器 | 默认隔离允许「ESC 取消当次工作但保持 teammate 存活」；非交互式 subagent 无需此能力 |

**其他字段：**

| 字段 | 处理方式 | 设计动机 |
|------|---------|---------|
| `requireCanUseTool` | 透传给子 agent | speculation（推测）等功能需要强制调用权限检查以支持文件路径重写 |

**克隆而非直接共享的关键原因：**

```
共享（直接引用同一对象）的问题：
  1. 父子 agent 并发修改同一状态 → 竞态条件（例如 contentReplacementState 被同时修改）
  2. 子 agent 的缓存污染父的缓存 → 下次查询时获得意外的缓存数据
  3. 替换决策不一致 → 同一 tool_use_id 在不同迭代做出不同决策 → wire prefix 变化 → prompt cache miss

克隆的优势：
  1. 每个 agent 有自己的状态副本，修改互不影响（记忆隔离）
  2. 子 agent 读文件时，缓存在子的 readFileState 中，父的缓存保持纯净
  3. contentReplacementState 克隆后，子 agent 看到父的历史决策，继续做出相同决策 → cache hit 稳定
  4. 子 agent 完成后，其副本自动释放，父的状态完全不受污染
```

**实际应用举例：**

```typescript
// LocalAgentTask（后台异步子 agent）：完全隔离
const ctx = createSubagentContext(parentContext, {
  options: workerOptions,
  agentId: newAgentId,
  messages: initialMessages,
  // 默认：readFileState 克隆、setAppState no-op、abortController 新建
})

// InProcessTeammate（交互式团队成员）：有选择地共享
const ctx = createSubagentContext(parentContext, {
  options: teamOptions,
  agentId: teamAgentId,
  shareSetAppState: true,           // 需要更新 UI（权限提示）
  shareSetResponseLength: true,      // 需要贡献响应长度指标
  shareAbortController: true,        // 需要与 leader 同步取消
})
```

### 2.4 子任务结果如何返回

结果返回通过**消息队列**（异步通知）机制，不是返回值：

1. 子 agent 完成时调用 `enqueueAgentNotification()`
2. 该函数调用 `enqueuePendingNotification()`，将 XML 格式通知推入队列
3. 通知格式：

```xml
<task-notification>
  <task-id>{taskId}</task-id>
  <tool-use-id>{toolUseId}</tool-use-id>
  <output-file>{path}</output-file>
  <status>completed|failed|killed</status>
  <summary>{description}</summary>
  <result>{finalMessage}</result>
  <usage><total_tokens>N</total_tokens>...</usage>
  <worktree>...</worktree>
</task-notification>
```

4. 父 agent 在下一个对话轮次从消息队列中接收这条 user-role 消息
5. 结果内容也写到磁盘输出文件（`outputFile`），通过 `outputOffset` 追踪读取进度

**核心设计：结果以 XML 消息注入父 agent 的对话流，父 agent 像处理普通用户消息一样处理子任务通知。**

### 2.5 父 agent 取消 LocalAgentTask

调用链：`Task.kill(taskId, setAppState)` → `killAsyncAgent(taskId, setAppState)`

`killAsyncAgent` 的步骤：
1. 检查 `task.status !== 'running'`，防止重复终止
2. 调用 `task.abortController?.abort()`，中断正在运行的 `query()` 循环
3. 调用 `task.unregisterCleanup?.()` 取消进程清理注册
4. 更新状态到 `killed`，设置 `endTime`
5. 若未 retain（UI 未持有），设置 `evictAfter = Date.now() + PANEL_GRACE_MS`
6. 调用 `evictTaskOutput(taskId)` 异步清理磁盘输出

批量取消（ESC in coordinator mode）：`killAllRunningAgentTasks()` 遍历所有 `local_agent` 类型的 running 任务。

---

## 三、RemoteAgentTask 精读

### 3.1 与 LocalAgentTask 的本质区别

| 维度 | LocalAgentTask | RemoteAgentTask |
|------|---------------|----------------|
| 执行位置 | 本地 Node.js 进程内 | Anthropic 云端 CCR 环境 |
| 通信方式 | 进程内函数调用，`query()` 直接运行 | HTTP 轮询（`pollRemoteSessionEvents`） |
| 状态获取 | AppState 实时更新 | 每秒拉取一次远程事件 |
| 持久化 | 不需要，进程生命周期内 | 写入 session sidecar（`--resume` 时恢复） |
| 中断 | `abortController.abort()` | 外部终止（`TaskStopTool`），session 留活 |
| 消息格式 | 结构化 AgentToolResult + 通知 XML | `SDKMessage[]` 日志 + 解析标签 |

**跨进程消息传递：**
本地客户端通过 `pollRemoteSessionEvents(sessionId, lastEventId)` 轮询 CCR API（间隔 1 秒），获取 `SDKMessage[]` 格式的增量事件。增量文本直接 `appendTaskOutput()` 写入磁盘，全量 log 累积在内存 `accumulatedLog` 中。

### 3.2 远程任务结果序列化格式

结果嵌入在 `SDKMessage[]` 的 `result` 类型消息中：

```ts
// accumulatedLog 中找最后一条 type === 'result' 的消息
const result = accumulatedLog.findLast(msg => msg.type === 'result')
// result.subtype === 'success' | 'error_max_tokens' | 'error_...'
```

特殊类型有专用标签提取：
- Ultraplan：`<ultraplan>...</ultraplan>` 从 assistant 消息文本提取
- Ultrareview（bughunter 路径）：`<remote-review>...</remote-review>` 从 `hook_progress` stdout 提取
- 进度心跳：`<remote-review-progress>{JSON}</remote-review-progress>` 解析为 `reviewProgress` 字段

通知统一为 XML 格式注入消息队列（与 LocalAgentTask 格式相同，含 `<task-type>remote_agent</task-type>`）。

---

## 四、InProcessTeammateTask 精读

### 4.1 与 LocalAgentTask 的区别

| 维度 | LocalAgentTask | InProcessTeammateTask |
|------|---------------|-----------------------|
| 生命周期 | 一次性：任务完成即终止 | 持续运行：idle 后等待新任务 |
| 身份 | 无团队身份，匿名 agent | 有团队身份 `agentName@teamName`，颜色标识 |
| 通信 | 父通过 pending messages 队列注入 | 文件系统 mailbox（同时也支持内存队列） |
| 权限申请 | 不弹权限确认 UI | 通过 leader 的 ToolUseConfirmQueue 展示权限 UI，有 worker badge |
| 任务发现 | 由父明确指定 prompt | 可主动从 team task list 认领任务 |
| 消息上限 | messages 无上限（LocalAgentTaskState） | `TEAMMATE_MESSAGES_UI_CAP = 50` 条（内存优化） |
| 计划模式 | 不支持 | 支持 `planModeRequired`，等待 leader 审批 |

**「进程内」的核心优势：**
1. **零序列化开销**：直接函数调用 `runAgent()`，不需要 IPC 或 HTTP
2. **共享记忆状态**：通过 `AsyncLocalStorage` 隔离上下文同时共享 `AppState` Store
3. **实时权限 UI**：可以接入 leader 的 `ToolUseConfirmQueue`，UI 中实时展示需要审批的操作
4. **上下文压缩**：`inProcessRunner` 在 token 超阈值时自动调用 `compactConversation()`

### 4.2 inProcessRunner.ts 核心逻辑

`runInProcessTeammate()` 是核心入口，实现了一个**持续运行的 agent 循环**：

```
启动
  ↓
构建 system prompt（base + TEAMMATE_SYSTEM_PROMPT_ADDENDUM + custom）
  ↓
注入核心团队工具（SendMessage, TeamCreate/Delete, TaskCreate/Get/List/Update）
  ↓
尝试从 team task list 认领任务（tryClaimNextTask）
  ↓
while (!aborted && !shouldExit):
  ├── 创建 per-turn abortController（允许 ESC 打断当前工作而不杀死 teammate）
  ├── 检查 token 数，超阈值则 compactConversation()
  ├── runAgent() 在 runWithTeammateContext() 包裹下执行（AsyncLocalStorage 注入）
  ├── 收集消息，更新 AppState（progress、messages）
  ├── 发送 idle 通知到 leader mailbox
  └── waitForNextPromptOrShutdown()：
        ├── 检查 pendingUserMessages 内存队列
        ├── 轮询文件系统 mailbox（500ms 间隔）
        │     ├── 优先处理 shutdown request
        │     ├── 优先处理 team-lead 消息
        │     └── 其次处理 peer 消息（FIFO）
        └── 检查 team task list 是否有未认领任务
```

**关键设计点：**
- **双 abort controller**：`abortController`（整个 teammate 生命周期）和 `currentWorkAbortController`（当前轮工作），支持 ESC 打断当前工作但保持 teammate 存活
- **mailbox 优先级**：shutdown > team-lead 消息 > peer 消息，防止 peer-to-peer 消息洪水饿死 leader 控制信号
- **contentReplacementState 跨迭代持久化**：防止同一 tool_use_id 在不同迭代做出不同替换决策导致 cache miss

---

## 五、Coordinator 模式精读

### 5.1 工具过滤逻辑

Coordinator 被允许的工具集（`src/constants/tools.ts`）：

```ts
export const COORDINATOR_MODE_ALLOWED_TOOLS = new Set([
  AGENT_TOOL_NAME,       // 派生 worker
  TASK_STOP_TOOL_NAME,   // 终止 worker
  SEND_MESSAGE_TOOL_NAME,// 向已有 worker 发送消息
  SYNTHETIC_OUTPUT_TOOL_NAME, // 结构化输出（内部）
])
```

此外 `coordinatorMode.ts` 中 `INTERNAL_WORKER_TOOLS` 在生成 `workerToolsContext` 时被过滤掉（不暴露给 coordinator 的提示词）：

```ts
const INTERNAL_WORKER_TOOLS = new Set([
  TEAM_CREATE_TOOL_NAME,
  TEAM_DELETE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
])
```

**被禁止使用的工具（coordinator 不能直接执行）：**
- `FileReadTool`、`FileEditTool`、`BashTool`：所有直接操作文件和 shell 的工具
- `AgentTool` 的递归能力（workers 不能再派生 workers，`ASYNC_AGENT_ALLOWED_TOOLS` 中不含 AgentTool）

**简洁模式（`CLAUDE_CODE_SIMPLE=1`）：** worker 只有 Bash + Read + Edit，适合简单并行任务。

### 5.2 设计动机

Coordinator 不允许直接执行工具，是**角色分离**原则的体现：

1. **防止 coordinator 分心**：如果 coordinator 能直接操作文件，它会在「做事」和「指挥」之间切换，难以保持全局视角
2. **强制并行化**：coordinator 的「超能力」是同时派发多个 worker，禁止直接工具调用迫使它把所有工作委派出去
3. **安全边界**：coordinator 不执行文件操作，降低了因 coordinator 自身 bug 导致的系统性破坏风险
4. **消息流清晰**：coordinator 只收发 `task-notification` XML 消息，worker 结果以 user-role 消息注入，形成清晰的单向数据流

Coordinator 的系统提示（`getCoordinatorSystemPrompt()`）明确其工作流：Research → Synthesis（coordinator 自己完成） → Implementation → Verification。Synthesis 阶段由 coordinator 亲自完成，禁止写「基于你的发现」这类懒性委派。

---

## 六、任务类型对比表

| 类型 | 执行位置 | 隔离程度 | 适用场景 | 选择标准 |
|------|---------|---------|---------|---------|
| `local_bash` | 本地进程内（子进程） | 进程隔离 | 单次 shell 命令，需要进度追踪 | 无 LLM 推理，纯命令执行 |
| `local_agent` | 本地进程内（同线程） | 记忆隔离（克隆上下文） | coordinator 模式的 worker；需要 LLM 完成任务 | 需要 LLM、可后台并行、结果异步通知 |
| `remote_agent` | Anthropic 云端 CCR | 进程隔离（不同机器） | ultraplan / ultrareview / autofix-pr | 任务耗时极长（>30min）、需要专用云环境 |
| `in_process_teammate` | 本地进程内（同 JS 运行时） | AsyncLocalStorage 上下文隔离 | Swarm 模式多 teammate 协作；长期持续运行的 agent | 需要团队协作、权限UI交互、任务列表、持续 idle |
| `local_workflow` | 本地进程内 | 依赖具体实现 | 多步骤顺序工作流编排 | 预定义流程，步骤之间有强依赖关系 |
| `monitor_mcp` | 本地进程内 | 进程内隔离 | 监控 MCP 服务器存活状态 | 需要长期轮询外部服务 |
| `dream` | 本地进程内 | 完全隔离（投机执行） | 后台预测下一步用户输入 | 推测性，可随时丢弃结果 |

---

## 七、模式卡片

---

### 模式卡片 #4：分层 Agent 编排

**问题：** 如何根据任务特征选择合适的 agent 执行模式（本地/远程/进程内），在性能、隔离性、协作能力之间取得平衡？

**方案（基于代码的具体实现）：**

**LocalAgentTask**（`src/tasks/LocalAgentTask/`）：
- 通过 `createSubagentContext()` 创建隔离的 `ToolUseContext`（克隆 readFileState，独立 AbortController，no-op setAppState）
- 调用 `runAgent()` → `query()` 在同一 JS 线程内运行完整的 agent 循环
- 结果通过 `enqueuePendingNotification()` 写入消息队列，以 XML user-role 消息形式注入父对话
- 取消：`abortController.abort()` 中断 query 循环，立即生效

**RemoteAgentTask**（`src/tasks/RemoteAgentTask/`）：
- 通过 teleport API 在 CCR 云端创建 session，本地只保存 `sessionId`
- 每秒通过 `pollRemoteSessionEvents()` 拉取增量 `SDKMessage[]`
- session metadata 写入磁盘 sidecar（`--resume` 时可恢复）
- 结果通过专用标签解析（`<remote-review>`、`<ultraplan>` 等）或 `result` 消息类型判断

**InProcessTeammateTask**（`src/tasks/InProcessTeammateTask/`）：
- 通过 `runWithTeammateContext()` 注入 `AsyncLocalStorage`，实现上下文隔离而非进程隔离
- `runInProcessTeammate()` 实现持续运行的 while 循环，idle 后等待 mailbox 消息
- 权限需求路由到 leader 的 `ToolUseConfirmQueue`，UI 显示 worker badge
- 双 AbortController：lifecycle（杀死整个 teammate）+ currentWork（打断当次工作）

**关键设计决策：为什么需要三种不同的 Task 类型而不是统一一种？**

三种类型解决的是**本质不同的问题**：
1. LocalAgentTask 是「即发即忘」后台任务，不需要长期存活，也不需要与其他 agent 协作
2. RemoteAgentTask 是「离线执行」任务，本地只是观察者；云端有独立的计算资源和网络隔离
3. InProcessTeammateTask 是「持续在场」的协作 agent，需要 idle 等待、接收 DM、请求权限审批、与团队其他成员共享任务列表

统一为一种会导致：
- LocalAgentTask 如果要支持 idle 等待，需要占用线程资源
- InProcessTeammateTask 如果用 LocalAgentTask 实现，无法接入 ToolUseConfirmQueue
- RemoteAgentTask 的轮询逻辑（`pollRemoteSessionEvents`）与本地运行逻辑完全不同，强行统一只会产生大量 if/else

**选择标准：**
- 单次、后台、无需交互 → `local_agent`
- 超长时间、云环境、需要 CCR → `remote_agent`
- 多 agent 团队、需要持续协作、需要权限 UI → `in_process_teammate`

**权衡：**

| | LocalAgent | RemoteAgent | InProcessTeammate |
|--|-----------|------------|-----------------|
| 启动开销 | 低（进程内） | 高（网络+云端启动） | 低（进程内） |
| 资源占用 | 低（任务完成即释放） | 很低（本地只轮询） | 高（线程持续占用） |
| 可靠性 | 依赖本地进程存活 | 本地崩溃不影响（可 resume） | 依赖本地进程存活 |
| 协作能力 | 无（单次通知） | 无（异步通知） | 强（mailbox、任务列表、权限 UI） |

---

### 模式卡片 #5：Coordinator-Worker 模式

**问题：** 如何将大任务分解给多个并行 agent 执行，并聚合结果，同时避免 coordinator 自身执行具体操作带来的混乱？

**方案（基于 coordinatorMode.ts 的具体实现）：**

Coordinator 通过环境变量 `CLAUDE_CODE_COORDINATOR_MODE=1` 激活，接收到专用 system prompt（`getCoordinatorSystemPrompt()`）：
- 工具集严格限定为 `{AgentTool, TaskStopTool, SendMessageTool, SyntheticOutputTool}`
- Worker 工具集通过 `getCoordinatorUserContext()` 注入到 coordinator 的 user context 中（`workerToolsContext` 字段）
- 工作流分为四个阶段：Research → Synthesis → Implementation → Verification

**消息流（完全异步）：**

```
Coordinator
    |
    |-- AgentTool(prompt) ──────────────────> Worker (LocalAgentTask)
    |                                              |
    |                                         runAgent()
    |                                              |
    |                                    enqueuePendingNotification()
    |                                              |
    |<── user-role <task-notification> XML ────────|
    |
    |-- SendMessageTool(to=agentId, msg) ─────> 同一 Worker（复用上下文）
```

**关键设计决策：工具过滤的目的是什么？**

1. **角色纯粹性**：coordinator 只能编排，不能执行。这强制它把所有文件操作、代码修改委托给 worker，自己专注于理解和合成（Synthesis 是 coordinator 最重要的工作）
2. **并行化倒逼**：没有直接工具，coordinator 必须通过 AgentTool 完成工作；多个独立的 AgentTool 调用可以在同一消息中并发发出，这是并行化的天然触发点
3. **安全隔离**：coordinator 无法直接修改文件系统，即使 coordinator 产生幻觉，也无法直接造成代码破坏
4. **系统提示告知**：coordinator 的 system prompt 明确列出了 worker 有哪些工具，coordinator 可以据此在 prompt 中指导 worker 使用特定工具，而无需自己拥有这些工具

**SendMessageTool（继续已有 worker）vs AgentTool（新建 worker）：**

代码注释和 system prompt 给出了明确的决策矩阵：
- 研究过的文件需要编辑 → continue（worker 已有文件在 context）
- 研究范围宽但实现范围窄 → spawn fresh（避免携带噪声上下文）
- 修复已有 worker 的失败 → continue（worker 有错误上下文）
- 独立验证 → spawn fresh（验证者应有新鲜视角）

**权衡：**

| 优势 | 劣势 |
|------|------|
| 并行研究/实现大幅提速 | coordinator 轮次增加（每次等 worker 回报才能继续） |
| 清晰的任务归属（谁做了什么有 task-id 可追溯） | worker 不能看到彼此的工作（只能通过 coordinator 中转） |
| coordinator 上下文专注于高层决策 | 长并行 session 会积累大量 task-notification 消息，增加 context 长度 |
| 可以停止错误方向的 worker（TaskStopTool） | worker 之间无法直接协调（无 peer-to-peer 通信） |

---

## 八、关键洞察总结

1. **Task 是调度骨架，TaskState 是状态容器**：`Task` 接口只有 `kill`，实际状态全在 `AppState.tasks[id]` 中的 `*TaskState` 对象里。

2. **结果异步化是统一机制**：无论本地还是远程，结果都通过 `enqueuePendingNotification()` 注入消息队列，父 agent 永远不「等待」子任务，而是「接收通知」。

3. **隔离层次与执行方式正交**：LocalAgentTask 和 InProcessTeammateTask 都在本地进程内运行，但隔离机制不同——前者通过克隆 ToolUseContext 实现记忆隔离，后者通过 AsyncLocalStorage 实现上下文隔离。

4. **AbortController 树**：整个多 agent 系统通过 AbortController 父子链形成树状取消结构。父 abort 自动传播给所有子 agent，但子 abort 不向上传播。

5. **工具过滤即角色定义**：coordinator 只有编排工具，worker 有执行工具，teammate 有协作工具。工具集的差异不是技术限制，而是角色职责的代码化表达。
