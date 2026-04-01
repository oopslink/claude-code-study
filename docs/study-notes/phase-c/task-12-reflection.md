# Task 12：复盘与总结

> 完成日期：2026-03-31
> 覆盖范围：Phase A（task-01 至 task-03）、Phase B（task-04 至 task-09）、Phase C（task-10）及 10 张模式卡片

---

## 一、完整系统边界图（更新版）

以下系统图在 Task 3 基础上补充了每个子系统的核心数据结构、子系统间传递的数据类型、关键异步边界与依赖方向。

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 外部入口层                                                                                           │
│                                                                                                     │
│  [CLI 入口 / main.tsx]                   [SDK 入口 / QueryEngine]                                   │
│  launchRepl() | runHeadless()            QueryEngine.submitMessage() → AsyncGenerator<SDKMessage>   │
│  核心数据：argv / PermissionMode         核心数据：QueryEngineConfig / mutableMessages[]             │
│  ─────────────────────┬────────────────────────────┬──────────────────────────────────────────────  │
│    同步配置加载          ↓ UserMessage              ↓ UserMessage                                    │
│  [配置系统]        ─────────────────────────────────────────────────────────────────────────        │
│  settingsCache + MDM + keychain prefetch                                                            │
│  数据流：raw plist/JSON → Settings（五层优先级合并）→ PermissionMode                                  │
└───────────────────────┬─────────────────────────────────────────────────────────────────────────────┘
                        │ QueryParams（messages, systemPrompt, canUseTool, toolUseContext）
                        ↓ 【异步边界：AsyncGenerator pipeline 起点】
┌───────────────────────────────────────────────────────────────────┐
│ 子系统 1：Agent 核心循环                                            │
│                                                                   │
│ 核心文件：query.ts / QueryEngine.ts / services/api/claude.ts       │
│ 核心数据结构：                                                      │
│   QueryParams { messages, systemPrompt, canUseTool, toolUseContext }│
│   Terminal { reason: 'completed' | 'max_turns' | 'aborted_*' | … } │
│   AssistantMessage { message: BetaMessage, uuid, timestamp }        │
│   StreamEvent { type: 'stream_event', ... }                         │
│                                                                   │
│ 内部：while(true) 状态机                                           │
│   每轮状态：                                                        │
│     messagesForQuery → callModel() → AssistantMessage[]            │
│     + toolUseBlocks[]                                              │
│     → runToolUse() → UserMessage（tool_result）                    │
│     → 下一轮 messagesForQuery                                      │
│                                                                   │
│ 产出（yield）：StreamEvent | AssistantMessage | ProgressMessage     │
│ 返回（return）：Terminal（退出原因）                                 │
│                                                                   │
│ 关键异步边界：                                                      │
│   • callModel() ← SSE stream（AsyncGenerator from claude.ts）       │
│   • runToolUse() ← 工具执行（可并行，StreamingToolExecutor）         │
│   • autoCompact() ← LLM 摘要子调用（forked query()）               │
└────────┬──────────────────┬──────────────────┬────────────────────┘
         │                  │                  │
         │ Tool<Input,Out>  │                  │ CanUseToolFn
         │ call(args,ctx,…) │                  │ 结果：PermissionResult
         ↓                  ↓                  ↓
┌──────────────────┐ ┌───────────────────┐ ┌─────────────────────────┐
│ 子系统 2：工具系统│ │ 子系统 5：内存管理│ │ 子系统 6：安全与沙箱    │
│                  │ │                   │ │                         │
│ 核心文件：        │ │ 核心文件：         │ │ 核心文件：              │
│  Tool.ts         │ │  memdir/memdir.ts  │ │  utils/bash/ast.ts      │
│  tools.ts        │ │  services/compact/ │ │  utils/permissions/     │
│  BashTool/       │ │  utils/sessionSto- │ │  tools/BashTool/bash-   │
│  FileReadTool/   │ │  rage.ts           │ │  Permissions.ts         │
│  AgentTool/      │ │                   │ │                         │
│                  │ │ 核心数据结构：      │ │ 核心数据结构：           │
│ 核心数据结构：    │ │  • 短期：          │ │  ParseForSecurityResult │
│  Tool<I,O,P>     │ │    Message JSONL   │ │  { kind: 'simple'|      │
│    inputSchema   │ │    parentUuid DAG  │ │    'too-complex'|       │
│    call()        │ │  • 中期：          │ │    'parse-unavailable'} │
│    checkPerms()  │ │    CompactSummary  │ │  PermissionRule         │
│    render*()     │ │    UserMessage     │ │  PermissionResult       │
│  ToolUseContext  │ │    (isCompact=true)│ │    { behavior: allow/   │
│    messages[]    │ │  • 长期：          │ │      ask/deny/          │
│    abortCtrl     │ │    MEMORY.md       │ │      passthrough }      │
│    setAppState   │ │    topic/*.md      │ │                         │
│    onProgress    │ │                   │ │ 数据流：                 │
│  ToolResult<T>   │ │ 数据流：           │ │  shell string           │
│    data          │ │  JSONL append →   │ │  → tree-sitter AST      │
│    newMessages?  │ │  sessionStorage   │ │  → SimpleCommand[]      │
│    contextMod?   │ │  MEMORY.md →      │ │  → PermissionDecision   │
│                  │ │  systemPrompt     │ │                         │
│ 数据流：          │ │  token count →   │ │ 依赖：无（叶子节点）     │
│  ToolUseBlock    │ │  autoCompact()→   │ │ 提供给：                 │
│  → tool.call()  │ │  CompactSummary   │ │  子系统 2（BashTool）    │
│  → ToolResult   │ │                   │ │  子系统 1（canUseTool）  │
│  → tool_result  │ │ 依赖：            │ │                         │
│    BlockParam   │ │  子系统 1（触发）  │ │ 【异步边界】：           │
│                  │ │ 提供给：          │ │  OS sandbox spawn        │
│ 【异步边界】：    │ │  子系统 1（注入） │ │  （macOS sb-exec /       │
│  tool.call()    │ │                   │ │   firejail）             │
│  返回 Promise   │ │ 【异步边界】：    │ │                         │
│  并行工具调用    │ │  extractMemories  │ │                         │
│  用 Promise.all │ │  后台子代理       │ │                         │
└──────┬───────────┘ └───────────────────┘ └─────────────────────────┘
       │ AgentTool.call() → runAgent() → query()
       │ 传递：SubagentContextOverrides（克隆 readFileState, 独立 abortCtrl）
       ↓ 【异步边界：子 agent 独立 query() 循环】
┌────────────────────────────────────────────────────────────────────┐
│ 子系统 3：多智能体架构                                               │
│                                                                    │
│ 核心文件：Task.ts / tasks/ / coordinator/coordinatorMode.ts         │
│                                                                    │
│ 核心数据结构：                                                       │
│   Task { name, type: TaskType, kill() }                            │
│   TaskStatus: 'pending'|'running'|'completed'|'failed'|'killed'    │
│   TaskStateBase { taskId, status, startTime, evictAfter, ... }     │
│   TaskType: local_agent | remote_agent | in_process_teammate |     │
│             local_bash | local_workflow | monitor_mcp | dream      │
│                                                                    │
│ 子系统间传递的数据：                                                 │
│   → 父发给子：SubagentContextOverrides（克隆 + no-op 替换）         │
│   ← 子回报父：enqueuePendingNotification → XML task-notification   │
│     格式：<task-id> <status> <result> <usage> （user role 消息）    │
│                                                                    │
│ LocalAgentTask：克隆 ToolUseContext → runAgent() → query() 循环    │
│ RemoteAgentTask：HTTP 轮询 pollRemoteSessionEvents（1秒间隔）        │
│ InProcessTeammateTask：AsyncLocalStorage 隔离 + mailbox（500ms轮询）│
│ CoordinatorMode：工具集过滤为 {AgentTool, SendMessage, TaskStop}    │
│                                                                    │
│ 【异步边界】：                                                       │
│   • runAsyncAgentLifecycle()：void 启动，不等待                     │
│   • pollRemoteSessionEvents()：HTTP 轮询，1秒间隔                   │
│   • mailbox 文件轮询：500ms 间隔                                    │
└────────────────────────────────────────────────────────────────────┘
       │ SkillTool.call() → getPromptForCommand() → newMessages[]
       ↓ 【加载时依赖：Plugin → Skill 目录 → SkillTool】
┌────────────────────────────────────────────────────────────────────┐
│ 子系统 4：插件与技能系统                                             │
│                                                                    │
│ 核心文件：services/plugins/ / skills/ / tools/SkillTool/           │
│                                                                    │
│ 核心数据结构：                                                       │
│   Plugin { name, path, commands[], agents[], hooks, mcpBundles[] } │
│   Skill { name, description, getPromptForCommand(args) }           │
│   Command { name, getPromptForCommand, context: 'inline'|'fork' }  │
│                                                                    │
│ 数据流：                                                            │
│   Plugin 安装 → 扫描 commands/agents/hooks/ → 注册到系统           │
│   SkillTool.call() → getPromptForCommand()                         │
│     → ContentBlockParam[]（Markdown 文本）                          │
│     → UserMessage（注入对话流）                                      │
│                                                                    │
│ 加载机制：                                                           │
│   • 启动时：Promise.allSettled 并行加载所有 Plugin（错误隔离）        │
│   • 热重载：chokidar 文件监听 + 300ms 防抖（Skill 文件变化）          │
│   • 延迟加载：ToolSearch 找到后才加载具体 Skill                       │
└────────────────────────────────────────────────────────────────────┘

依赖方向汇总（→ = 依赖）：
  1（核心循环）→ 2（工具）→ 6（安全）
  1 → 5（内存）
  1 → 6（通过 canUseTool）
  1 ↔ 3（AgentTool 触发子任务，子任务内运行 query()，递归）
  2 → 3（AgentTool 创建 LocalAgentTask）
  2 → 4（SkillTool 调用 skill 加载器）
  4 → 2（SkillTool 是 Tool，属于工具系统）
  6 → 无（叶子节点）
```

---

## 二、10 个关键设计决策

**决策 1：AsyncGenerator 作为核心数据流抽象**
- 做法：`query()` 是 `AsyncGenerator<StreamEvent | Message, Terminal>`，整个 API 调用链到 UI 渲染都是 AsyncGenerator pipeline
- 为什么这样：流式 AI 响应的本质是无限流，Promise 只能传递一个最终值；AsyncGenerator 支持中间产出、背压控制、组合（`yield*`）、携带终止值（`return Terminal`）四合一
- 放弃了什么：代码初看不直观（需要理解 AsyncGenerator 的 `next()`/`done` 语义）；放弃了 RxJS Observable 等更完善的响应式抽象（选择了 JS 原生 API 减少依赖）

**决策 2：Tool 接口包含 React 渲染方法**
- 做法：`Tool` 接口包含 15+ 个 `render*()` 方法（返回 `React.ReactNode`），每个工具自治负责自身的 UI 呈现
- 为什么这样：避免外部分发表（switch/case 大表），工具能力与展示内联，新增工具不需要修改任何中央注册逻辑
- 放弃了什么：Tool 接口极重（~70 个字段）；UI 逻辑与业务逻辑耦合在同一对象；依赖 React 框架，工具无法在无 UI 环境下零成本复用

**决策 3：权限检查在工具调用前，而非调用中**
- 做法：`runToolUse()` 先 `validateInput()` → `checkPermissions()` → `canUseTool()`，全部通过后才调用 `tool.call()`；拒绝时返回 `is_error: true` 的 tool_result，工具从未开始运行
- 为什么这样：工具执行是不可回滚的副作用（删除文件、运行命令）；调用中中断比调用前拒绝产生更严重的状态不一致风险
- 放弃了什么：无法实现「执行到某个检查点再问用户」的精细化交互；某些工具（如长时间 bash 命令）用户只能整体批准或拒绝

**决策 4：子 agent 通过「克隆上下文 + no-op 替换」实现隔离**
- 做法：`createSubagentContext()` 克隆 `readFileState`、新建独立 `abortController`、将 `setAppState` 替换为 no-op，而非使用 OS 进程隔离
- 为什么这样：同一 JS 进程内调用成本低（零序列化、零 IPC），同时通过对象级隔离防止状态污染；`contentReplacementState` 克隆保证 prompt cache 命中率
- 放弃了什么：没有真正的内存沙箱（子 agent 代码崩溃会影响主进程）；子 agent 的文件系统操作没有 OS 级限制（只有逻辑层权限控制）

**决策 5：Coordinator 工具集过滤即角色定义**
- 做法：`CLAUDE_CODE_COORDINATOR_MODE` 激活后，coordinator 的工具集被硬编码为 `{AgentTool, TaskStopTool, SendMessageTool}`，无法直接操作文件或执行命令
- 为什么这样：角色分离——coordinator 专注全局规划和结果汇总，worker 专注执行；工具集约束强制 coordinator 并行化（只能派发，不能自己做）
- 放弃了什么：coordinator 无法做轻量级实时检查（必须派发子任务）；任务粒度必须大到值得启动子 agent

**决策 6：多层内存分离（短期/中期/长期）注入不同 API 字段**
- 做法：短期（session JSONL → messages 数组）、中期（compact 摘要 → messages 数组头部 user 消息）、长期（MEMORY.md → system prompt）三层分别存储和注入
- 为什么这样：Anthropic API 的 messages 数组必须以 user 消息开始（协议约束反向影响架构）；长期记忆注入 system 减少 token 消耗；compact 摘要必须是 user 角色以满足 API 格式要求
- 放弃了什么：三层架构复杂度高；compact 摘要以 user 消息注入在语义上有些奇怪（系统生成的摘要用 user 角色表达）

**决策 7：bash AST 分析的 FAIL-CLOSED 策略**
- 做法：tree-sitter 解析 bash 脚本，遇到任何「危险节点」（命令替换、参数展开、控制流等）直接返回 `too-complex`，要求用户确认，而非尝试分析
- 为什么这样：攻击者（或幻觉模型）可以精心构造绕过正则的命令（如 brace 展开 `{--upload-pack="evil",x}`）；宁可误报（频繁要求确认）也不漏报（错放危险命令）
- 放弃了什么：大量常见的非危险复杂命令（`for` 循环、管道、变量）也会触发确认，降低自动化效率

**决策 8：配置系统五层优先级，企业策略始终最高**
- 做法：user < project < local < flag < policy；policySettings 始终加载且不受 `--setting-sources` 控制
- 为什么这样：支持个人使用（user）、团队共享（project）、本地覆盖（local）、企业管控（policy）四种场景；企业策略最高保证合规
- 放弃了什么：用户在企业环境下无法覆盖 policySettings，影响灵活性；配置来源越多，调试「某个设置为什么没生效」越困难

**决策 9：Plugin 不含可执行 TypeScript 代码**
- 做法：Plugin 只能包含 Markdown 文件（commands/agents/skills）、JSON 配置（hooks）、MCP bundle（`.mcpb`/`.dxt`）；不能包含任意 JS/TS 代码
- 为什么这样：安全边界——来自 marketplace 的第三方 Plugin 如果能执行任意代码，等同于任意代码执行漏洞；纯声明式设计降低审计难度
- 放弃了什么：Plugin 无法实现复杂的程序化逻辑（如动态生成 prompt）；复杂扩展必须走 MCP 协议（更重的方案）

**决策 10：UserMessage 承担人类输入和工具结果两种角色**
- 做法：`type: 'user'` 的消息同时用于人类对话（`isMeta=undefined, toolUseResult=undefined`）和工具结果（`toolUseResult !== undefined`，content 含 `tool_result` block）；通过 `isHumanTurn()` 谓词区分
- 为什么这样：Anthropic API 协议要求 tool_result 必须在 user 角色消息中；Claude Code 沿用 API 的角色模型而非自建内部类型体系，保持与 API 的对应关系
- 放弃了什么：类型安全依赖谓词函数而非 TypeScript 类型系统区分；初读代码容易混淆两种用途

---

## 三、最意外的发现

**意外 1：3 行代码在所有 import 之前执行，是整个系统最关键的性能优化**

`main.tsx` 顶部（第 12-20 行）在任何 `import` 之前就触发了 MDM 子进程启动和 keychain 读取。这利用了 ESM 加载器的副作用时机（side effect hoisting），让约 65ms 的 I/O 操作完全隐藏在 ~135ms 的模块加载时间内。在阅读代码之前，完全想不到一个 CLI 工具会在模块加载阶段就做实质性的 I/O 并行化。

**意外 2：工具结果异步通知以 XML user 消息注入对话——父 agent 像处理用户输入一样处理子任务完成**

子 agent 完成后，结果通过 `enqueuePendingNotification()` 写入消息队列，格式是 XML 文本的 user role 消息（`<task-notification>...</task-notification>`）。父 agent 的 query loop 在下一轮接收这条消息时，和普通用户输入完全走同一条路径。这意味着「子任务通知」和「用户打字」在架构上完全等价——系统通过对话协议统一了人机交互和机器间通信。

**意外 3：compact 摘要必须是 user 角色消息——API 协议约束反向影响架构**

直觉上，对话摘要应该是系统消息（system 角色）。但 Anthropic API 要求 messages 数组必须以 user 消息开头，compact 摘要作为新的对话起点，必须是 user 角色。这个 API 协议约束硬性决定了 compact 摘要的存储格式（JSONL 中 `isCompactSummary=true` 的 UserMessage）和注入位置，以及后续所有围绕 compact boundary 的复杂处理逻辑。

**意外 4：Skill 执行的本质是 user 消息注入，而非 system prompt 修改**

调用 SkillTool 时，Skill 的 Markdown 内容被包装为 UserMessage 注入到对话流（`newMessages` 字段），而不是附加到 system prompt。这意味着 Skill 的指令通过「角色扮演」（模型看到「用户」发来的指令）而非「系统配置」方式生效。在理解这个设计之前，我以为 Skill 是 system prompt 的动态片段。

**意外 5：FileReadTool 读文件时顺带做 Skill 发现（副作用）**

`FileReadTool.call()` 内部有一行 `discoverSkillDirsForPaths()`——读取某个文件路径时，顺带检查该路径附近是否有 Skill 目录需要激活。这是一个「被动激活」机制：不需要用户显式安装 Skill，只要访问了正确的文件路径就会自动发现并加载相关 Skill。把能力发现藏在文件读取的副作用中，是一个非常隐性的设计。

---

## 四、可以简化的复杂度

对于中小型 agent 项目（单一 LLM、单层工具调用、无多 agent 需求），以下 Claude Code 的设计属于「产品级过度设计」：

**简化 1：Tool 接口的 render*() 方法族**

Claude Code 的 `Tool` 接口包含 15+ 个渲染方法（`renderToolUseMessage`、`renderToolResultMessage`、`renderToolUseProgressMessage` 等），让工具完全自治地渲染 UI。对于中小项目，可以将 UI 渲染与工具执行完全分离：工具只返回结构化数据，UI 层用 switch/case 或映射表处理不同工具的展示。代价是新增工具需要修改中央渲染逻辑，但换来更轻的工具接口。

**简化 2：7 种 TaskType 多智能体架构**

LocalAgentTask / RemoteAgentTask / InProcessTeammateTask / local_bash / local_workflow / monitor_mcp / dream 七种任务类型应对的是不同级别的规模和复杂度。对于中小型项目，只需 1-2 种：同步子 agent（直接等待结果）和可选的后台子 agent（写结果到文件，轮询读取）。CoordinatorMode 的工具过滤、mailbox 优先级调度、AsyncLocalStorage 上下文隔离等机制均可省略。

**简化 3：bash AST 安全分析层**

Claude Code 用 tree-sitter 完整解析 bash AST，识别危险节点类型（23 类 pattern），实现多层防御。对于不需要 bash 工具的 agent，这层可以完全省略。需要 bash 工具时，可以用更简单的方案：只允许预定义的安全命令白名单，拒绝一切复杂命令，无需 AST 解析。代价是灵活性大幅降低，但安全边界更清晰。

**简化 4：三层内存架构（短期/中期/长期）**

Claude Code 维护 JSONL 会话历史（短期）、LLM 生成的 compact 摘要（中期）、MEMORY.md 跨会话记忆（长期）三套完整的持久化体系。对于中小型 agent，根据场景可以：只保留短期内存（无跨会话记忆需求）、或只保留简单的 system prompt 手动注入（无 compact 需求）。LLM 生成的 compact 摘要本身会消耗额外 token，中小项目可以改用简单截断策略。

**简化 5：Plugin 安装管理系统**

Claude Code 的 Plugin 系统支持 github/git/npm/url/local 五种来源、稀疏克隆、SHA 锁定、marketplace 名称保护、enterprise allowlist/blocklist 等完整的包管理能力。对于中小项目，可以用更简单的方案：一个 `~/.myagent/skills/` 目录，用户将 Markdown 文件放进去，agent 启动时全量扫描加载。省略安装/卸载/版本管理的全部复杂度。

**简化 6：五层配置优先级**

Claude Code 支持 user/project/local/flag/policy 五层设置合并，还有 MDM（企业移动设备管理）和远程管理设置。对于个人或小团队 agent 项目，一个 JSON 配置文件 + 环境变量覆盖就已足够。五层优先级的主要价值在于企业合规场景。

---

## 五、最值得直接复用的设计

从 10 个模式卡片中，性价比最高的三个设计：

**首选：模式 3 — 进度上报与 UI 解耦**

`onProgress?: ToolCallProgress<P>` 回调注入模式。工具执行时通过 `onProgress({ data })` 发射进度，框架决定如何处理（存储、渲染、转发）。这个模式解决了「工具与 UI 框架耦合」的核心问题，且实现成本极低——一个回调参数，类型安全，零框架依赖。任何需要实时进度展示的工具系统都可以直接照抄。对比 EventEmitter 方案，这个模式没有 listener 管理的复杂度；对比共享状态方案，这个模式没有竞态条件。

**次选：模式 1 — 流式响应 + 工具调用循环**

AsyncGenerator 链 + `while(true)` 状态机的 agent loop 模式。`query()` 函数作为 `AsyncGenerator`，每个 `yield` 是一条消息（流式输出给 UI），最终 `return Terminal`（退出原因）。内部 `while(true)` 状态机用局部变量自然隔离每轮的 toolUseBlocks / toolResults，无需手动清空。这个模式直接解决了「流式 LLM 响应 + 工具调用」的核心架构问题，且 JS 原生支持，无需额外依赖。复用时需要理解 AsyncGenerator 语义，学习曲线约 0.5 天。

**第三：模式 7 — 声明式权限规则引擎**

`deny 优先 > ask > allow`、规则精确匹配 > 前缀 > 通配符、规则分层（session/project/user/policy）的权限设计。对于任何需要让用户配置「哪些操作永远允许/永远拒绝」的 agent 系统，这个模式提供了清晰的决策框架。实现时可以大幅简化（只保留 allow 和 deny，去掉 ask 层和 passthrough），但核心的优先级顺序和规则匹配策略值得直接借鉴。规则精确匹配（而非模糊匹配）是关键——`Bash(npm install)` 只允许 `npm install`，不允许 `npm install malware`。

---

## 六、如果重新设计

如果用另一种技术栈（例如 Python + asyncio，或 Go + goroutine）重新实现 Claude Code，我会做以下取舍：

**保留的核心设计：**

1. AsyncGenerator（或等价的异步迭代器）作为 agent loop 的核心抽象——这是由 LLM 流式 API 的本质决定的，不是语言偏好。Python 的 `async for` + `AsyncGenerator` 完全可以实现同等效果。

2. `while(true)` 状态机循环代替递归——工具调用循环本质上是有限状态机，每轮迭代独立声明局部变量，比递归更容易理解和调试，也没有栈溢出风险。

3. 回调注入三件套（`canUseTool` / `setAppState` / `onProgress`）——依赖倒置原则让工具代码与 UI 框架解耦，测试时注入 mock，子 agent 时注入 no-op，这个模式在任何语言中都有价值。

4. 权限系统的 FAIL-CLOSED 原则——遇到不确定就拒绝，这是安全设计的基本原则，与技术栈无关。

5. 分层内存架构（短/中/长期）——这由 LLM 的 context window 限制决定，不是实现语言的问题。

**会改变的设计：**

1. 工具接口中的 render 方法——在 Python 中强烈倾向于将 UI 渲染完全剥离到外部。工具只返回结构化 Pydantic 模型，展示层自行决定如何渲染。

2. 配置系统简化到 3 层（user / project / env override），去掉企业 MDM 和远程管理层——这部分复杂度是 Anthropic 产品需求，对于独立项目没有价值。

3. 用 Python 的 `dataclass` 或 Pydantic 模型替代 Zod schema——避免引入 JavaScript 生态的工具，同时获得更好的类型安全和序列化支持。

4. 将 Plugin 系统简化为目录扫描——去掉 marketplace、版本管理、SHA 锁定等企业级包管理能力，只保留「放文件到目录，自动发现」的核心机制。

总体而言，Claude Code 的架构核心是正确的——AsyncGenerator pipeline、回调注入、权限前置、分层内存。这些设计解决了真实的技术问题，值得在任何 agent 项目中借鉴。复杂度主要来自产品边界（多平台、企业合规、多用户场景），而非过度工程。
