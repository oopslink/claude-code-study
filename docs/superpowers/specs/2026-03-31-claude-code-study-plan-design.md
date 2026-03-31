# Claude Code 源码系统性学习计划

**日期**：2026-03-31
**目标**：系统性掌握 Claude Code 完整架构，提炼可复用设计模式
**方法**：自顶向下，三阶段渐进式学习

---

## 背景与目标

### 代码库概况

- **仓库路径**：`/Users/oopslink/works/codes/oos/claude-code/src`
- **规模**：约 38 万行 TypeScript 代码
- **技术栈**：TypeScript、React（Ink terminal UI）、Bun、Anthropic SDK、MCP SDK
- **系统性质**：Claude Code 自身源码——一个生产级 AI agent CLI 工具

### 学习者背景

有 agent 开发经验，理解 LLM API 调用和 tool use 原理，目标是：
1. **理解全貌**：建立完整的系统架构心智模型
2. **提炼设计**：提取可复用的设计模式，应用于自己的项目

### 重点关注的子系统

- A：Agent 核心循环（QueryEngine、query.ts、消息处理）
- B：工具系统（Tool 抽象、执行、权限）
- C：多智能体架构（tasks、swarm、coordinator）
- E：插件/技能系统
- G：上下文与内存管理
- H：安全与沙箱

---

## 学习方案

采用**自顶向下**方案：先建立整体心智模型，再逐层向下精读核心子系统，最后横向提炼设计模式。

---

## Phase A：建立心智模型（1-2 周）

目标：在不深入实现细节的前提下，建立整个系统的准确全局图。

### A-1：启动流程与系统全貌（Day 1-2）

**阅读文件（按顺序）：**

| 文件 | 目的 |
|------|------|
| `src/main.tsx` | 入口：启动优化、CLI 参数解析、运行模式分发 |
| `src/entrypoints/init.js` | 初始化序列：auth、config、telemetry |
| `src/setup.ts` | 环境准备、工作目录、权限初始化 |
| `src/replLauncher.tsx` | 交互式 REPL 模式启动流程 |

**核心问题：**
- 系统启动时做了哪几件并行的事？（keychain prefetch、MDM read、GrowthBook...）
- `COORDINATOR_MODE` 和 `KAIROS` 是什么？如何通过 feature flag 条件加载？
- 有哪几种运行模式（interactive、headless、sdk、bridge）？各自的入口在哪？

### A-2：核心数据结构（Day 2-3）

**阅读文件：**

| 文件 | 目的 |
|------|------|
| `src/types/message.ts` | 消息类型体系：UserMessage、AssistantMessage、ToolUse... |
| `src/types/permissions.ts` | 权限模型的类型定义 |
| `src/types/tools.ts` | 工具进度类型 |
| `src/Tool.ts` | Tool 抽象的完整接口定义 |
| `src/context.ts` | 系统上下文和用户上下文 |

**核心问题：**
- 一条 Message 有哪几种类型？它们的关系和区别是什么？
- `PermissionMode` 有哪些值，各自代表什么策略？
- `Tool` 接口要求实现哪些方法和属性？`ToolUseContext` 包含什么？

### A-3：六大子系统速览（Day 3-7）

每个子系统只读入口文件，目的是建立「这个系统做什么、边界在哪」的感知，不深入实现。

| 子系统 | 入口文件 | 速览重点 |
|--------|----------|----------|
| Agent 核心循环 | `src/query.ts` + `src/QueryEngine.ts` 前 100 行 | query 函数签名、循环结构 |
| 工具系统 | `src/tools.ts` + `src/tools/shared/` | 工具注册方式、执行上下文 |
| 多智能体 | `src/tasks/` 各目录的 index | Task 类型有哪几种 |
| 插件/技能 | `src/services/plugins/` + `src/skills/` | 加载机制入口 |
| 上下文内存 | `src/memdir/memdir.ts` + `src/services/compact/` | 内存提取 vs 上下文压缩 |
| 安全沙箱 | `src/tools/BashTool/` 目录结构 | 安全验证的分层 |

**A-3 交付物**：手绘或文字记录一张「系统边界图」，标出六个子系统之间的依赖方向。

---

## Phase B：核心子系统深潜（3-4 周）

### B-Week 1：Agent 核心循环 + 工具系统

#### Agent 核心循环（Day 1-3）

**精读文件：**

| 文件 | 重点 |
|------|------|
| `src/query.ts` | 核心 `query()` 函数：单次 API 调用 + tool use 处理循环 |
| `src/QueryEngine.ts` | 多轮对话编排：重试、错误处理、用户中断 |
| `src/services/api/claude.ts` | API 调用层：流式响应、usage 统计、错误分类 |
| `src/utils/messages.ts` | 消息构造工具：system/user/assistant message 组装 |
| `src/cost-tracker.ts` | 成本追踪如何与循环集成 |

**核心问题：**
1. `query()` 和 `QueryEngine` 的职责边界是什么？
2. tool use 循环：模型返回 tool_call → 执行 → 结果注入 → 再次调用，循环在哪里实现？
3. 流式响应如何被组装成完整消息？
4. 哪些错误会触发重试？重试策略是什么？
5. 用户按 Ctrl+C 时，abort 信号如何传播到整个调用链？

**提炼模式**：「流式响应 + 工具调用循环」模式。

#### 工具系统（Day 4-5）

**精读文件：**

| 文件 | 重点 |
|------|------|
| `src/Tool.ts` | Tool 接口完整定义 |
| `src/tools.ts` | 工具注册与聚合 |
| `src/tools/shared/` | 工具执行的共享基础设施 |
| `src/tools/BashTool/index.ts` | 最复杂工具的完整实现（范例） |
| `src/tools/FileReadTool/` | 简单工具的完整实现（对比） |
| `src/tools/AgentTool/` | 工具嵌套工具的实现 |
| `src/hooks/useCanUseTool.ts` | 权限检查如何介入工具执行 |

**核心问题：**
1. `Tool` 接口中 `call()` 的完整签名是什么？`ToolUseContext` 包含哪些信息？
2. 工具执行前的权限检查流程？
3. 工具如何上报进度（progress）给 UI？
4. `AgentTool` 如何启动子 agent 并等待结果？

---

### B-Week 2：多智能体架构

**精读文件：**

| 文件 | 重点 |
|------|------|
| `src/Task.ts` | Task 基础抽象 |
| `src/tasks.ts` | Task 注册与管理 |
| `src/tasks/LocalAgentTask/` | 本地 agent 子任务完整实现 |
| `src/tasks/RemoteAgentTask/` | 远程 agent 任务，对比本地 |
| `src/tasks/InProcessTeammateTask/` | 进程内 teammate 模式 |
| `src/tasks/DreamTask/` | 异步后台任务 |
| `src/utils/swarm/` | swarm 协调：任务分发、结果聚合 |
| `src/coordinator/` | Coordinator 模式：主从 agent 编排 |

**核心问题：**
1. Task 和 Tool 的关系？AgentTool 和 LocalAgentTask 如何配合？
2. 本地 vs 远程 agent 任务的本质区别？消息如何跨进程传递？
3. Swarm 模式下，coordinator 如何分配子任务、收集结果？
4. teammate 模式（进程内）和普通子 agent 的区别？
5. 任务取消/超时如何处理？

**提炼模式**：「分层 agent 编排」模式，记录任务类型的选择标准。

---

### B-Week 3：安全与沙箱

**精读文件：**

| 文件 | 重点 |
|------|------|
| `src/tools/BashTool/bashSecurity.ts` | bash 命令安全检查：AST 分析 |
| `src/tools/BashTool/bashPermissions.ts` | 权限规则引擎 |
| `src/tools/BashTool/readOnlyValidation.ts` | 只读模式验证 |
| `src/utils/bash/bashParser.ts` | bash AST 解析器（4400 行） |
| `src/utils/bash/ast.ts` | AST 节点类型 |
| `src/utils/permissions/filesystem.ts` | 文件系统权限控制 |
| `src/utils/permissions/denialTracking.ts` | 权限拒绝追踪 |
| `src/utils/sandbox/` | 沙箱隔离实现 |
| `src/hooks/toolPermission/` | 工具权限 hook 系统 |

**核心问题：**
1. bash 安全检查如何通过 AST 分析识别危险操作？
2. 权限模式（auto/manual/bypass）如何影响每个工具的执行路径？
3. `PermissionResult` 的决策流程？deny/allow/ask 如何判定？
4. 只读模式验证的边界？有哪些绕过防御措施？
5. 沙箱如何隔离文件系统访问？

**提炼模式**：「多层防御」安全模型——AST 静态分析 + 运行时权限 + 沙箱隔离。

---

### B-Week 4：插件/技能系统 + 上下文与内存管理

#### 插件/技能系统（Day 1-3）

**精读文件：**

| 文件 | 重点 |
|------|------|
| `src/services/plugins/pluginLoader.ts` | 插件加载机制（3300 行，最大文件之一） |
| `src/services/plugins/marketplaceManager.ts` | 插件市场管理 |
| `src/plugins/bundled/` | 内置插件参考实现 |
| `src/skills/bundled/` | 内置 skill 参考实现 |
| `src/tools/SkillTool/` | skill 作为工具的执行 |
| `src/utils/skills/` | skill 工具函数 |

**核心问题：**
1. plugin 和 skill 的本质区别是什么？
2. 插件如何注册新工具、新命令、新 skill？
3. 插件加载的安全边界？沙箱隔离程度？
4. skill 执行时如何注入到当前对话上下文？

#### 上下文与内存管理（Day 4-5）

**精读文件：**

| 文件 | 重点 |
|------|------|
| `src/memdir/memdir.ts` | 结构化内存（memory files）加载 |
| `src/utils/sessionStorage.ts` | 会话持久化（5100 行，最大文件） |
| `src/services/compact/` | 上下文压缩：触发时机与执行逻辑 |
| `src/services/extractMemories/` | 自动提取记忆 |
| `src/services/SessionMemory/` | 会话级内存管理 |
| `src/utils/memory/` | 内存工具函数 |

**核心问题：**
1. 「memory files」(MEMORY.md 系统) 和「session memory」的区别？
2. 上下文压缩（compact）的触发条件和算法？
3. 会话如何持久化到磁盘？恢复时如何重建状态？
4. 自动记忆提取（extractMemories）何时触发？提取逻辑是什么？

**提炼模式**：「分层内存架构」——短期（session）、中期（compact 摘要）、长期（memory files）。

---

## Phase C：设计模式提炼（持续进行）

### C-1：横切关注点分析

**错误处理模式**

| 观察点 | 文件 |
|--------|------|
| API 错误分类与重试策略 | `src/services/api/errors.ts` |
| 工具执行失败如何向模型反馈 | `src/tools/shared/` |
| 用户可见错误 vs 内部错误的边界 | `src/cli/print.ts` |

提炼问题：系统如何区分「可重试错误」「用户错误」「系统错误」？错误信息如何分别格式化给模型和用户？

**权限模型一致性**

| 观察点 | 文件 |
|--------|------|
| 权限决策的统一入口 | `src/hooks/useCanUseTool.ts` |
| 权限结果的传播路径 | `src/types/permissions.ts` |
| 权限拒绝的用户交互 | `src/components/permissions/` |

提炼问题：权限检查是调用前拦截还是调用中拦截？用户「记住此选择」的机制如何实现？

**三对核心抽象的边界**

```
Tool      vs  Task        — 单次执行 vs 持续运行的任务
Plugin    vs  Skill       — 系统扩展 vs 行为扩展
Memory    vs  Context     — 持久化信息 vs 当前对话窗口
```

### C-2：10 个可复用设计模式清单

每个模式写一份「模式卡片」，格式：问题 → 方案 → 适用条件 → 权衡。

| # | 模式名称 | 来源子系统 |
|---|----------|-----------|
| 1 | 流式响应 + 工具调用循环 | Agent 核心循环 |
| 2 | Tool 接口统一抽象 | 工具系统 |
| 3 | 进度上报与 UI 解耦 | 工具系统 |
| 4 | 分层 agent 编排（本地/远程/in-process） | 多智能体 |
| 5 | Coordinator-Worker 模式 | 多智能体 |
| 6 | AST 静态分析 + 运行时权限的多层防御 | 安全沙箱 |
| 7 | 声明式权限规则引擎 | 安全沙箱 |
| 8 | 插件热加载与隔离 | 插件系统 |
| 9 | 分层内存架构（短/中/长期） | 上下文内存 |
| 10 | 上下文压缩触发与摘要注入 | 上下文内存 |

### C-3：与自身项目的映射

每个模式卡片写完后追加「我的项目如何应用」，回答：
1. 这个问题在我的项目中存在吗？（是/否/变体）
2. Claude Code 的方案可以直接用吗？还是需要简化/调整？
3. 有什么我不需要的复杂度？

---

## 贯穿三阶段的学习方法

| 方法 | 说明 |
|------|------|
| **读前提问** | 每次精读前先写下 3-5 个问题，读完后回答 |
| **画数据流图** | 每个子系统画一张「数据从哪来、到哪去、被谁处理」的简图 |
| **写模式卡片** | Phase C 的核心交付物，强迫自己从「看懂代码」到「能解释设计」 |
| **对比实验** | 有疑问时直接运行 claude-code，观察行为印证代码理解 |

---

## 时间估算

| 阶段 | 时长 | 交付物 |
|------|------|--------|
| Phase A | 1-2 周 | 系统边界图 |
| Phase B | 3-4 周 | 每个子系统的数据流图 + 核心问题解答 |
| Phase C | 持续 | 10 份模式卡片 + 项目映射文档 |
