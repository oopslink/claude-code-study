# Claude Code 源码学习计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 系统性掌握 Claude Code 源码架构，提炼 10 个可复用的 AI agent 设计模式

**Architecture:** 三阶段自顶向下学习——Phase A 建立全局心智模型，Phase B 精读 6 个核心子系统，Phase C 横向提炼设计模式并映射到自身项目。

**Tech Stack:** TypeScript、React (Ink)、Bun、Anthropic SDK、MCP SDK、Zod

---

## Phase A：建立心智模型

---

### Task 1：启动流程与运行模式

**Files:**
- Read: `src/main.tsx`（重点前 200 行）
- Read: `src/setup.ts`
- Read: `src/replLauncher.tsx`（前 80 行）

- [ ] **Step 1：阅读 `src/main.tsx` 前 200 行**

  关注以下三件事：
  1. 启动时并行执行了哪些预取操作（`startMdmRawRead`、`startKeychainPrefetch`、`profileCheckpoint`）
  2. `feature('COORDINATOR_MODE')` 和 `feature('KAIROS')` 的条件加载模式
  3. Commander.js CLI 参数解析的结构

- [ ] **Step 2：记录运行模式清单**

  继续阅读 `src/main.tsx`，找出以下问题的答案，写入笔记：
  ```
  运行模式：
  - interactive（REPL）：入口函数 = ?
  - headless（--print）：入口函数 = ?
  - sdk 模式：入口函数 = ?
  - bridge 模式：入口函数 = ?
  ```

- [ ] **Step 3：阅读 `src/setup.ts`**

  找出：初始化时设置了哪些全局状态？配置文件从哪里加载？

- [ ] **Step 4：验证理解**

  能回答以下问题则继续：
  - 系统启动时哪 3 件事是并行执行的，目的是什么？
  - `KAIROS` feature flag 对应哪个功能模块（assistant 模式）？
  - 配置文件的查找顺序是什么？

---

### Task 2：核心数据结构

**Files:**
- Read: `src/types/message.ts`
- Read: `src/types/permissions.ts`
- Read: `src/types/tools.ts`
- Read: `src/Tool.ts`（完整）

- [ ] **Step 1：阅读 `src/types/message.ts`**

  画出消息类型继承/组合关系图（文字版即可）：
  ```
  Message
  ├── UserMessage        — 包含哪些字段？
  ├── AssistantMessage   — 包含哪些字段？
  ├── ToolUseBlock       — 包含哪些字段？
  ├── ToolResultBlock    — 包含哪些字段？
  ├── SystemMessage      — 何时使用？
  └── ProgressMessage    — 何时使用？
  ```

- [ ] **Step 2：阅读 `src/types/permissions.ts`**

  记录 `PermissionMode` 的所有取值及含义：
  ```
  PermissionMode:
  - "auto"       — 含义：?
  - "manual"     — 含义：?
  - "bypass"     — 含义：?
  - ...（其他值）
  ```

- [ ] **Step 3：阅读 `src/Tool.ts` 完整文件**

  提取 Tool 接口的核心结构，记录：
  ```typescript
  interface Tool {
    name: string          // 工具名称
    description: string   // 给模型看的描述
    inputSchema: ...      // 输入 JSON Schema
    call(input, context): Promise<...>  // 执行函数
    // 还有哪些必须实现的属性/方法？
  }

  interface ToolUseContext {
    // 包含哪些字段？
  }
  ```

- [ ] **Step 4：验证理解**

  能回答：
  - `ProgressMessage` 和 `AssistantMessage` 的区别？何时产生 ProgressMessage？
  - `PermissionResult` 有哪几种结果，各自代表什么决策？
  - Tool 的 `call()` 方法返回值类型是什么？

---

### Task 3：六大子系统速览 + 边界图

**Files:**
- Read: `src/query.ts`（前 50 行）
- Read: `src/QueryEngine.ts`（前 80 行）
- Read: `src/tools.ts`（前 60 行）
- Read: `src/tasks/types.ts`
- Read: `src/memdir/memdir.ts`（前 60 行）
- Read: `src/services/compact/autoCompact.ts`（前 60 行）
- Read: `src/tools/BashTool/`（只看目录结构 + 各文件前 20 行）

- [ ] **Step 1：速览 Agent 核心循环入口**

  阅读 `src/query.ts` 前 50 行 + `src/QueryEngine.ts` 前 80 行。
  记录：`query()` 函数的签名是什么？`QueryEngine` 是类还是函数？

- [ ] **Step 2：速览工具系统入口**

  阅读 `src/tools.ts` 前 60 行。
  记录：工具是如何被注册/聚合的？`getTools()` 返回什么？

- [ ] **Step 3：速览任务类型**

  阅读 `src/tasks/types.ts`。
  记录所有 Task 类型名称及一句话描述其用途。

- [ ] **Step 4：速览内存管理入口**

  阅读 `src/memdir/memdir.ts` 前 60 行 + `src/services/compact/autoCompact.ts` 前 60 行。
  记录：memdir 管理的是什么类型的内存？compact 的触发入口在哪里？

- [ ] **Step 5：速览安全沙箱结构**

  列出 `src/tools/BashTool/` 下所有文件，按职责分组：
  ```
  BashTool/
  ├── 执行层：index.ts, ...
  ├── 安全检查层：bashSecurity.ts, bashPermissions.ts, ...
  └── 验证层：readOnlyValidation.ts, ...
  ```

- [ ] **Step 6：画系统边界图**

  基于以上速览，用文字画出六大子系统的依赖关系：
  ```
  QueryEngine
    ├── 依赖 → query.ts（API 调用）
    ├── 依赖 → tools.ts（工具注册表）
    │           └── 每个 Tool 实现
    │               └── BashTool → bashSecurity（安全检查）
    ├── 依赖 → memdir（内存加载）
    ├── 依赖 → compact（上下文管理）
    └── 产出 → Task（多智能体任务）
  ```
  补全关系，记录哪些系统依赖哪些系统。

- [ ] **Step 7：验证理解**

  能回答：
  - Plugin 和 Skill 各自在哪个目录？它们的加载入口分别是什么？
  - LocalAgentTask 和 RemoteAgentTask 的文件都在哪里？
  - 安全检查层和执行层是同一个文件吗？为什么分开？

---

## Phase B：核心子系统深潜

---

### Task 4：Agent 核心循环精读

**Files:**
- Read: `src/query.ts`（完整）
- Read: `src/QueryEngine.ts`（完整）
- Read: `src/services/api/claude.ts`（重点：query 相关函数，约前 150 行）
- Read: `src/utils/messages.ts`（重点：createSystemMessage、createUserMessage）

- [ ] **Step 1：精读 `src/query.ts` 完整文件**

  找出并记录：
  ```
  query() 函数签名：
    参数：
    - messages: Message[]
    - systemPrompt: string
    - tools: Tool[]
    - ...（其他参数）
    返回值：AsyncGenerator<...> 还是 Promise<...>？

  tool use 循环位置：第 __ 行附近，循环结构是：
  while/for ... {
    // 1. 调用 API
    // 2. 处理响应
    // 3. 如果有 tool_use → 执行工具
    // 4. 将结果追加到 messages
    // 5. 继续循环 / break 条件
  }
  ```

- [ ] **Step 2：精读 `src/QueryEngine.ts` 完整文件**

  找出并记录：
  ```
  QueryEngine 职责（与 query.ts 的分工）：
  - query.ts 负责：单次 API 调用 + tool use 循环
  - QueryEngine 负责：多轮对话编排、重试逻辑、用户中断处理

  重试触发条件（列出所有）：
  1. ...
  2. ...

  abort 信号传播路径：
  用户 Ctrl+C → AbortController → query() → API 请求取消
  具体代码位置：第 __ 行
  ```

- [ ] **Step 3：阅读 `src/services/api/claude.ts` 流式响应部分**

  找出流式响应如何被组装成完整消息：
  ```
  流式处理流程：
  1. API 返回 stream
  2. 每个 chunk 类型：text_delta / tool_use / ...
  3. 组装完整 AssistantMessage 的位置：第 __ 行
  4. usage（token 数）在哪里被提取？
  ```

- [ ] **Step 4：验证理解**

  能画出以下调用链：
  ```
  用户输入
    → QueryEngine.run()
      → query()
        → claude.ts API 调用
          → 流式响应处理
        → tool_use 检测
          → Tool.call()
        → 结果追加 messages
        → 再次调用 query()
    → 最终响应返回给用户
  ```

- [ ] **Step 5：写模式卡片草稿 #1**

  文件：`docs/study-notes/patterns/01-streaming-tool-loop.md`
  ```markdown
  ## 模式：流式响应 + 工具调用循环

  **问题**：如何在流式输出中处理工具调用并维持多轮对话？

  **方案**：
  - query.ts 实现单次调用循环（tool use → execute → append → repeat）
  - QueryEngine 负责多轮编排和错误恢复
  - AbortController 贯穿整个调用链

  **关键设计决策**：
  - 为什么 query 和 QueryEngine 分离？（可测性 / 职责单一）
  - 流式与工具调用的冲突如何解决？

  **适用条件**：任何需要流式输出 + 工具调用的 agent 系统

  **权衡**：
  - 优点：...
  - 缺点：...

  **我的项目如何应用**：
  ```

---

### Task 5：工具系统精读

**Files:**
- Read: `src/Tool.ts`（重点：接口定义部分）
- Read: `src/tools.ts`（完整）
- Read: `src/tools/FileReadTool/`（完整，作为简单工具范例）
- Read: `src/tools/AgentTool/AgentTool.tsx`（重点：call 方法）
- Read: `src/hooks/useCanUseTool.tsx`（完整）

- [ ] **Step 1：精读 `src/tools.ts` 完整文件**

  记录：
  ```
  getTools() 函数：
  - 返回 Tool[] 数组
  - 哪些工具是始终包含的？
  - 哪些工具是条件包含的（feature flag / 配置）？
  - 工具数组如何传递给 query()？
  ```

- [ ] **Step 2：精读 FileReadTool 完整实现（作为基准参照）**

  阅读 `src/tools/FileReadTool/` 下所有文件。记录：
  ```typescript
  // FileReadTool 的完整结构
  {
    name: "Read",
    description: "...",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", ... },
        // 其他参数
      }
    },
    async call(input, context) {
      // 核心逻辑步骤：
      // 1. ...
      // 2. ...
      // 返回值格式：
    }
  }
  ```

- [ ] **Step 3：精读 AgentTool 的 call 方法**

  阅读 `src/tools/AgentTool/AgentTool.tsx`，找出 AgentTool 如何启动子 agent：
  ```
  AgentTool.call() 流程：
  1. 解析 input（prompt、subagent_type 等）
  2. 创建子任务：调用 __ 函数，传入 __
  3. 等待子任务完成：通过 __ 机制
  4. 返回子任务结果
  ```

- [ ] **Step 4：精读 `src/hooks/useCanUseTool.tsx`**

  记录权限检查流程：
  ```
  useCanUseTool 返回的函数签名：
    canUseTool(tool, input, context) → PermissionResult

  决策逻辑：
  1. 检查 PermissionMode（auto/manual/bypass）
  2. 检查工具的 needsPermissions 属性
  3. 检查已记录的用户偏好
  4. 返回 allow / deny / ask

  「记住此选择」的存储位置：
  ```

- [ ] **Step 5：理解进度上报机制**

  在 FileReadTool 或 BashTool 中找出工具如何向 UI 上报进度（progress）：
  ```
  进度上报方式：
  - context 中有一个 __ 函数
  - 调用方式：context.__(progressData)
  - ProgressData 类型来自 src/types/tools.ts 的 __
  ```

- [ ] **Step 6：写模式卡片草稿 #2 和 #3**

  ```markdown
  ## 模式 #2：Tool 接口统一抽象
  问题：如何让不同能力的工具（文件读取、bash、网络请求）统一被模型调用？
  方案：统一 Tool 接口，name/description/inputSchema/call
  关键决策：inputSchema 用 JSON Schema 而非 TypeScript 类型（模型需要看到 schema）
  ...

  ## 模式 #3：进度上报与 UI 解耦
  问题：工具执行时如何实时更新 UI 而不依赖 UI 框架？
  方案：通过 context 注入 onProgress 回调，工具只知道「上报数据」，不知道「怎么显示」
  ...
  ```

---

### Task 6：多智能体架构精读

**Files:**
- Read: `src/Task.ts`（完整）
- Read: `src/tasks/types.ts`（完整）
- Read: `src/tasks/LocalAgentTask/`（完整）
- Read: `src/tasks/RemoteAgentTask/`（完整，对比本地）
- Read: `src/utils/swarm/inProcessRunner.ts`
- Read: `src/coordinator/coordinatorMode.ts`（前 100 行）
- Read: `src/tools/AgentTool/forkSubagent.ts`（完整）

- [ ] **Step 1：精读 Task 基础抽象**

  阅读 `src/Task.ts` + `src/tasks/types.ts`，记录：
  ```
  Task 接口核心方法：
  - start() / stop() / ...
  - 状态机：pending → running → completed / failed / cancelled

  Task 和 Tool 的关系：
  - Tool 是：单次调用，同步/异步返回结果
  - Task 是：持续运行，有生命周期管理
  - AgentTool 和 LocalAgentTask 的关系：AgentTool.call() 内部创建 LocalAgentTask
  ```

- [ ] **Step 2：精读 LocalAgentTask**

  阅读 `src/tasks/LocalAgentTask/` 下所有文件，记录：
  ```
  LocalAgentTask 的执行模型：
  1. 如何创建独立的 QueryEngine 实例？
  2. 父 agent 和子 agent 如何共享/隔离上下文？
     - 共享：工具列表、权限模式
     - 隔离：消息历史、工作目录（可选）
  3. 子任务结果如何返回给父 agent？
  4. 父 agent 如何取消子任务？
  ```

- [ ] **Step 3：对比 RemoteAgentTask**

  阅读 `src/tasks/RemoteAgentTask/`，对比本地任务：
  ```
  本地 vs 远程的核心区别：
  - 本地：同进程，直接调用 QueryEngine
  - 远程：跨进程/跨网络，通过 __ 协议通信
  消息序列化格式：
  结果回传机制：
  ```

- [ ] **Step 4：理解 Swarm 协调**

  阅读 `src/utils/swarm/inProcessRunner.ts` + `src/coordinator/coordinatorMode.ts` 前 100 行：
  ```
  Coordinator 模式：
  - Coordinator（主 agent）负责：任务分解、分配给 Worker
  - Worker（子 agent）负责：执行单个任务、返回结果
  - 结果聚合位置：第 __ 行

  与普通 AgentTool 的区别：
  - AgentTool：单个子 agent，顺序执行
  - Coordinator：多个 Worker，可并行执行
  ```

- [ ] **Step 5：精读 `src/tools/AgentTool/forkSubagent.ts`**

  理解 fork 子 agent 的完整流程，记录：
  ```
  forkSubagent() 函数：
  - 输入参数：
  - 创建子 agent 的步骤：
  - 子 agent 的隔离边界（继承哪些状态，不继承哪些）：
  - 返回值：
  ```

- [ ] **Step 6：写模式卡片草稿 #4 和 #5**

  ```markdown
  ## 模式 #4：分层 agent 编排
  问题：如何选择本地/远程/进程内三种任务执行模式？
  方案：
  - LocalAgentTask：同机器，低延迟，共享文件系统
  - RemoteAgentTask：跨机器，高隔离，需要序列化
  - InProcessTeammateTask：最低开销，共享内存，适合协作场景
  选择标准：...

  ## 模式 #5：Coordinator-Worker 模式
  问题：如何将大任务分解给多个并行 agent 执行？
  方案：Coordinator 持有任务队列，动态分配给 Worker，收集结果后聚合
  权衡：调度复杂度 vs 并行效率
  ```

---

### Task 7：安全与沙箱精读

**Files:**
- Read: `src/utils/bash/bashParser.ts`（前 150 行，理解 AST 结构）
- Read: `src/utils/bash/ast.ts`（完整）
- Read: `src/tools/BashTool/bashSecurity.ts`（完整）
- Read: `src/tools/BashTool/bashPermissions.ts`（前 200 行）
- Read: `src/tools/BashTool/readOnlyValidation.ts`（前 100 行）
- Read: `src/utils/permissions/filesystem.ts`（前 100 行）

- [ ] **Step 1：理解 bash AST 结构**

  阅读 `src/utils/bash/ast.ts` 完整文件，记录：
  ```
  AST 节点类型（列出主要类型）：
  - Command：表示单个命令，包含 args
  - Pipeline：管道，包含多个 Command
  - Redirect：重定向操作 > >> < 等
  - Subshell：$() 或 ()
  - ...（其他类型）

  为什么需要 AST 而不是简单的字符串匹配？
  ```

- [ ] **Step 2：精读 `src/tools/BashTool/bashSecurity.ts`**

  记录安全检查识别的危险操作类型：
  ```
  危险操作检测（找出所有 isDangerous/isRisky 类型的函数）：
  1. 检测 rm -rf 类操作：通过 AST 的 __ 节点
  2. 检测网络请求（curl/wget）：通过 __
  3. 检测环境变量泄露：通过 __
  4. 检测命令注入（; && ||）：通过 __

  返回值格式：
  - 安全：返回 __
  - 危险：返回 { reason: string, ... }
  ```

- [ ] **Step 3：精读权限规则引擎**

  阅读 `src/tools/BashTool/bashPermissions.ts` 前 200 行，记录：
  ```
  权限规则的数据结构：
  type PermissionRule = {
    pattern: string  // glob 或 regex？
    action: "allow" | "deny"
    // 其他字段？
  }

  规则匹配顺序：先 deny 还是先 allow？
  用户自定义规则的存储位置（配置文件路径）：
  ```

- [ ] **Step 4：理解只读模式验证**

  阅读 `src/tools/BashTool/readOnlyValidation.ts` 前 100 行：
  ```
  只读模式允许的命令白名单（列举前 10 个）：
  ls, cat, grep, ...

  判断一个命令是否只读的算法：
  1. 检查命令名是否在白名单
  2. 检查是否有写入重定向（> >>）
  3. 检查是否调用了非只读子命令
  ```

- [ ] **Step 5：理解文件系统权限**

  阅读 `src/utils/permissions/filesystem.ts` 前 100 行：
  ```
  文件系统权限控制：
  - 允许访问的目录列表来自：
  - 路径规范化（防止 ../.. 逃逸）的位置：第 __ 行
  - 检查函数签名：isPathAllowed(path, workingDir) → boolean
  ```

- [ ] **Step 6：写模式卡片草稿 #6 和 #7**

  ```markdown
  ## 模式 #6：多层防御安全模型
  问题：如何保证 LLM 生成的 bash 命令不破坏用户系统？
  方案：三层防御
  - 层 1：AST 静态分析（识别结构级危险操作）
  - 层 2：权限规则引擎（用户自定义的 allow/deny 规则）
  - 层 3：沙箱隔离（运行时文件系统限制）
  关键洞察：字符串匹配不够，必须解析 AST 才能准确识别危险

  ## 模式 #7：声明式权限规则引擎
  问题：如何让用户可配置地控制工具权限，而不需要改代码？
  方案：rules 数组 + pattern 匹配 + 优先级顺序
  对比：硬编码白名单 vs 声明式规则（灵活性、可审计性）
  ```

---

### Task 8：插件与技能系统精读

**Files:**
- Read: `src/services/plugins/pluginLoader.ts`（前 200 行 + 关键函数）
- Read: `src/plugins/bundled/`（选一个内置插件完整读）
- Read: `src/tools/SkillTool/`（完整）
- Read: `src/utils/skills/skillChangeDetector.ts`（完整，理解 skill 加载机制）

- [ ] **Step 1：理解 Plugin vs Skill 的边界**

  阅读 `src/services/plugins/pluginLoader.ts` 前 200 行：
  ```
  Plugin（插件）：
  - 定义：能扩展系统能力的外部模块
  - 可以做到：注册新工具 / 新命令 / 新 skill / 修改系统提示
  - 加载时机：启动时
  - 配置方式：settings.json 的 plugins 字段

  Skill（技能）：
  - 定义：给 LLM 的行为指导（Markdown 文档）
  - 能做到：定义新的 /command，注入 prompt 片段
  - 加载时机：被调用时（lazy）
  - 配置方式：.claude/skills/ 目录或插件提供
  ```

- [ ] **Step 2：读一个内置插件的完整实现**

  选择 `src/plugins/bundled/` 下最简单的一个插件，完整阅读。记录：
  ```
  插件结构：
  export default {
    name: "...",
    tools: [...],     // 注册了哪些工具？
    commands: [...],  // 注册了哪些命令？
    skills: [...],    // 提供了哪些 skill？
    onLoad: () => ... // 加载钩子
  }
  ```

- [ ] **Step 3：精读 SkillTool**

  阅读 `src/tools/SkillTool/` 下所有文件：
  ```
  Skill 执行流程：
  1. 用户调用 Skill tool，传入 skill 名称
  2. 加载 skill 的 Markdown 内容
  3. 将 skill 内容注入为：system prompt 片段 / user 消息 / 工具结果？
  4. 执行后如何影响后续对话？
  ```

- [ ] **Step 4：写模式卡片草稿 #8**

  ```markdown
  ## 模式 #8：插件热加载与能力扩展
  问题：如何在不修改核心代码的情况下扩展 agent 能力？
  方案：
  - Plugin = 代码扩展（新工具、新命令）
  - Skill = 行为扩展（新 prompt 模式）
  两者解耦：Plugin 提供能力，Skill 指导使用方式
  加载隔离：插件在独立 context 中加载，失败不影响主系统
  ```

---

### Task 9：上下文与内存管理精读

**Files:**
- Read: `src/memdir/memdir.ts`（完整）
- Read: `src/memdir/memoryTypes.ts`（完整）
- Read: `src/services/compact/autoCompact.ts`（完整）
- Read: `src/services/compact/compact.ts`（前 150 行）
- Read: `src/services/extractMemories/extractMemories.ts`（前 100 行）
- Read: `src/utils/sessionStorage.ts`（前 100 行，理解持久化结构）

- [ ] **Step 1：理解分层内存架构**

  阅读 `src/memdir/memdir.ts` + `src/memdir/memoryTypes.ts` 完整文件：
  ```
  Memory 层级：
  1. memory files（MEMORY.md 系统）：
     - 存储路径：~/.claude/projects/<hash>/memory/
     - 加载时机：每次对话开始时
     - 内容格式：Markdown 文件
     - 注入方式：作为 system prompt 的一部分

  2. session memory：
     - 存储位置：
     - 生命周期：

  3. compact 摘要：
     - 生成时机：
     - 存储位置：
     - 如何重新注入新对话？
  ```

- [ ] **Step 2：精读 autoCompact**

  阅读 `src/services/compact/autoCompact.ts` 完整文件：
  ```
  自动压缩触发条件：
  - token 阈值：context 使用量超过 __%
  - 具体检查逻辑：第 __ 行

  压缩算法：
  1. 识别可压缩的消息段（哪些消息可以压缩？）
  2. 调用 LLM 生成摘要（prompt 在 src/services/compact/prompt.ts）
  3. 替换原始消息为摘要消息
  4. 标记压缩边界（SDKCompactBoundaryMessage）
  ```

- [ ] **Step 3：理解会话持久化**

  阅读 `src/utils/sessionStorage.ts` 前 100 行：
  ```
  会话持久化：
  - 存储格式：JSON / JSONL / 其他？
  - 存储路径：~/.claude/projects/<hash>/sessions/
  - 每条消息的存储结构：
  - 恢复会话时如何重建 messages 数组？
  - 增量写入 vs 全量写入？
  ```

- [ ] **Step 4：理解自动记忆提取**

  阅读 `src/services/extractMemories/extractMemories.ts` 前 100 行：
  ```
  记忆提取触发时机：
  - 对话结束时？还是实时？
  - 触发条件：

  提取算法：
  - 调用 LLM 判断哪些信息值得长期记忆
  - 存储到 memory files 的哪个位置？
  ```

- [ ] **Step 5：写模式卡片草稿 #9 和 #10**

  ```markdown
  ## 模式 #9：分层内存架构
  问题：agent 如何在对话轮次间、会话间保持连贯的「记忆」？
  方案：三层分离
  - 短期（session）：当前对话消息历史，RAM
  - 中期（compact 摘要）：自动压缩的历史摘要，随会话存储
  - 长期（memory files）：用户显式或自动提取的重要信息，跨会话持久化
  关键洞察：不同时间尺度的信息需要不同的存储和检索策略

  ## 模式 #10：上下文压缩触发与摘要注入
  问题：context window 有限，如何在不丢失重要信息的情况下处理长对话？
  方案：
  - 监控 token 使用率，超阈值触发
  - LLM 自身生成摘要（而非硬截断）
  - 保留压缩边界标记，支持会话恢复
  权衡：压缩有延迟，摘要可能丢失细节
  ```

---

## Phase C：设计模式提炼

---

### Task 10：横切关注点分析

**Files:**
- Read: `src/services/api/errors.ts`（完整）
- Read: `src/components/permissions/`（目录结构 + 主文件）
- Read: `src/hooks/useCanUseTool.tsx`（已读，回顾权限传播）

- [ ] **Step 1：错误处理模式分析**

  阅读 `src/services/api/errors.ts`，填写：
  ```
  错误分类：
  - 可重试错误（retryable）：429 rate limit, 529 overload, ...
  - 用户错误（user-facing）：认证失败, 配额超限, ...
  - 内部错误（internal）：序列化失败, 状态损坏, ...

  错误格式化规则：
  - 给模型看的错误：包含 __ 信息，格式：<tool_error>...</tool_error>
  - 给用户看的错误：包含 __ 信息，显示在 __
  ```

- [ ] **Step 2：权限模型一致性分析**

  回顾 `src/hooks/useCanUseTool.tsx`，记录：
  ```
  权限检查是「调用前」还是「调用中」？答：__

  「记住此选择」的实现：
  - 用户选择 allow/deny 后，存储到：__（文件路径）
  - 下次同类操作时，通过 __ 查找历史选择
  - 选择的 key 是什么（命令名？完整命令？）：__
  ```

- [ ] **Step 3：完善三对核心抽象的边界理解**

  基于 Phase B 的学习，用一句话精确描述：
  ```
  Tool vs Task：
  - Tool = 单次调用，同步返回 ToolResult，不保持状态
  - Task = __, 有生命周期，可以持续运行和取消

  Plugin vs Skill：
  - Plugin = 代码级扩展，可以注册新 Tool / Command / Skill
  - Skill = __, 是 Markdown 文档，指导 LLM 行为

  Memory vs Context：
  - Context = 当前对话的消息窗口（有限，会被压缩）
  - Memory = __，跨会话持久化，每次启动时注入
  ```

---

### Task 11：完成 10 份模式卡片

**Files:**
- Create: `docs/study-notes/patterns/` 目录下 10 个文件

- [ ] **Step 1：创建模式卡片目录**

  ```bash
  mkdir -p /Users/oopslink/works/codes/oos/claude-code/docs/study-notes/patterns
  ```

- [ ] **Step 2：完善 10 份模式卡片**

  基于 Task 4-9 中写的草稿，补全每份卡片的「我的项目如何应用」部分：

  文件列表：
  ```
  01-streaming-tool-loop.md
  02-tool-interface-abstraction.md
  03-progress-reporting-decoupling.md
  04-layered-agent-orchestration.md
  05-coordinator-worker-pattern.md
  06-multi-layer-security-defense.md
  07-declarative-permission-rules.md
  08-plugin-hot-loading.md
  09-layered-memory-architecture.md
  10-context-compression.md
  ```

  每份卡片必须包含：
  ```markdown
  ## 模式名称

  **问题**：（1-2 句话描述解决什么问题）

  **方案**：（具体实现方式，含关键代码位置引用）

  **适用条件**：（何时用这个模式）

  **权衡**：
  - 优点：
  - 缺点/局限：

  **Claude Code 中的位置**：`src/...`

  ## 我的项目如何应用

  **这个问题在我的项目中存在吗？**（是/否/变体）

  **可以直接用吗？**（直接用 / 需要简化 / 需要调整，说明原因）

  **不需要的复杂度**：（Claude Code 是产品级，哪些部分我可以省略）
  ```

- [ ] **Step 3：提交所有模式卡片**

  ```bash
  cd /Users/oopslink/works/codes/oos/claude-code
  git add docs/study-notes/
  git commit -m "docs: add 10 reusable AI agent design pattern cards"
  ```

---

### Task 12：复盘与总结

- [ ] **Step 1：更新系统边界图**

  基于 Phase B 的深度学习，更新 Task 3 中画的系统边界图，补充：
  - 每个子系统的核心数据结构
  - 子系统间传递的数据类型
  - 关键的异步边界（哪里是 async/await，哪里是 event-driven）

- [ ] **Step 2：写一份「如果我来设计这个系统」的反思**

  文件：`docs/study-notes/reflection.md`

  回答以下问题：
  1. Claude Code 中哪个设计决策让你最意外？
  2. 哪个设计你认为过度复杂，在中小型项目中可以简化？
  3. 哪个设计你认为最值得直接复用？
  4. 如果用另一种语言/框架实现，哪些设计会自然不同？

- [ ] **Step 3：最终提交**

  ```bash
  cd /Users/oopslink/works/codes/oos/claude-code
  git add docs/study-notes/
  git commit -m "docs: add study reflection and finalize learning notes"
  ```
