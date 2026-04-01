# Claude Code 设计模式卡片索引

本目录收录 Claude Code 精读过程中归纳的 10 个核心设计模式，每个模式对应一个独立的卡片文件。

---

## 模式列表

| # | 模式名称 | 来源子系统 | 核心问题 | 文件 |
|---|---------|---------|---------|------|
| 1 | [流式响应 + 工具调用循环](#1-流式响应--工具调用循环) | Agent 核心循环 | 如何在流式输出中处理工具调用并维持多轮对话？ | [01-streaming-tool-loop.md](01-streaming-tool-loop.md) |
| 2 | [Tool 接口统一抽象](#2-tool-接口统一抽象) | 工具系统 | 如何让能力差异极大的工具被模型以完全统一的方式调用？ | [02-tool-interface-abstraction.md](02-tool-interface-abstraction.md) |
| 3 | [进度上报与 UI 解耦](#3-进度上报与-ui-解耦) | 工具系统 | 如何将工具执行的中间进度实时推送到 UI，且工具不依赖 UI 框架？ | [03-progress-reporting-decoupling.md](03-progress-reporting-decoupling.md) |
| 4 | [分层 Agent 编排](#4-分层-agent-编排) | 多智能体架构 | 如何根据任务特征选择合适的 agent 执行模式？ | [04-layered-agent-orchestration.md](04-layered-agent-orchestration.md) |
| 5 | [Coordinator-Worker 模式](#5-coordinator-worker-模式) | 多智能体架构 | 如何将大任务分解给多个并行 agent 执行并聚合结果？ | [05-coordinator-worker-pattern.md](05-coordinator-worker-pattern.md) |
| 6 | [多层防御安全模型](#6-多层防御安全模型) | 安全与沙箱 | 如何保证 LLM 生成的 bash 命令不破坏用户系统？ | [06-multi-layer-security-defense.md](06-multi-layer-security-defense.md) |
| 7 | [声明式权限规则引擎](#7-声明式权限规则引擎) | 安全与沙箱 | 如何让用户可配置地控制工具权限，而不需要改代码？ | [07-declarative-permission-rules.md](07-declarative-permission-rules.md) |
| 8 | [插件热加载与能力扩展](#8-插件热加载与能力扩展) | 插件与技能系统 | 如何在不修改核心代码、不重启进程的情况下，让 agent 获得新能力？ | [08-plugin-hot-loading.md](08-plugin-hot-loading.md) |
| 9 | [分层内存架构](#9-分层内存架构) | 上下文与内存管理 | 如何在对话轮次间、会话间保持连贯「记忆」，同时不让所有信息堆进 context window？ | [09-layered-memory-architecture.md](09-layered-memory-architecture.md) |
| 10 | [上下文压缩触发与摘要注入](#10-上下文压缩触发与摘要注入) | 上下文与内存管理 | Context window 有限，如何在长对话中不丢失重要信息？ | [10-context-compression.md](10-context-compression.md) |

---

## 模式摘要

### 1. 流式响应 + 工具调用循环

**问题摘要**：如何在流式输出中处理工具调用并维持多轮对话？

**核心思路**：AsyncGenerator 链 + `while(true)` 状态机循环。`content_block_stop` 时立即 yield AssistantMessage，工具执行结果以 UserMessage 注入下一轮 messages，循环继续直到无工具调用或达到终止条件。

**关键文件**：`src/query.ts`（L241-1729），`src/claude.ts`（L1940-2304）

---

### 2. Tool 接口统一抽象

**问题摘要**：如何让文件读取、Bash 执行、网络请求、子 agent 启动、MCP 代理等异构工具被模型统一调用？

**核心思路**：单一 `Tool<Input, Output, Progress>` 泛型接口 + `buildTool()` 工厂函数（fail-closed 默认值）+ Zod schema（运行时校验 + JSON Schema 生成三合一）。

**关键文件**：`src/tools/Tool.ts`（L362, L783）

---

### 3. 进度上报与 UI 解耦

**问题摘要**：如何将工具执行的中间进度实时推送到 UI，且工具逻辑不依赖任何 UI 框架？

**核心思路**：`onProgress?: ToolCallProgress<P>` 回调注入。框架在调用 `tool.call()` 时注入回调，工具通过 `onProgress({ data })` 上报，数据先存入 `ProgressMessage`，UI 组件从消息历史读取后渲染。

**关键文件**：`src/tools/Tool.ts`（L384），`src/tools/AgentTool/AgentTool.tsx`

---

### 4. 分层 Agent 编排

**问题摘要**：如何根据任务特征选择合适的 agent 执行模式（本地/远程/进程内）？

**核心思路**：三种 Task 类型——LocalAgentTask（即发即忘，克隆上下文隔离），RemoteAgentTask（云端执行，本地轮询），InProcessTeammateTask（持续协作，AsyncLocalStorage 隔离）。所有结果通过 `enqueuePendingNotification()` 异步注入父对话。

**关键文件**：`src/tasks/LocalAgentTask/`，`src/tasks/RemoteAgentTask/`，`src/tasks/InProcessTeammateTask/`

---

### 5. Coordinator-Worker 模式

**问题摘要**：如何将大任务分解给多个并行 agent 执行，避免 coordinator 自身执行具体操作带来的混乱？

**核心思路**：Coordinator 工具集严格限定为编排类工具（AgentTool、SendMessageTool 等），不能直接执行文件操作。Worker 通过 LocalAgentTask 并行执行，结果以 XML user-role 消息形式异步通知 coordinator。

**关键文件**：`src/coordinatorMode.ts`，`src/tools/AgentTool/`

---

### 6. 多层防御安全模型

**问题摘要**：如何保证 LLM 生成的 bash 命令不破坏用户系统？

**核心思路**：五层递进防御——声明式规则匹配（deny 优先）→ AST 静态分析（FAIL-CLOSED，遇到不确定性要求确认）→ 语义危险检测（23 类 pattern）→ 路径约束（工作目录白名单 + 敏感文件黑名单）→ OS 沙箱（macOS Sandbox / firejail）。各层独立，不能绕过。

**关键文件**：`src/tools/BashTool/bashPermissions.ts`，`src/utils/bash/ast.ts`，`src/utils/sandbox/sandbox-adapter.ts`

---

### 7. 声明式权限规则引擎

**问题摘要**：如何让用户可配置地控制工具权限，而不需要改代码？

**核心思路**：分层 settings 体系（enterprise policy > user > project > local > flag > session），规则优先级 `deny > ask > allow`，精确匹配 > 前缀/通配符。Deny 规则剥离所有 env var（防包装绕过），Allow 规则只剥离安全白名单（防意外宽松匹配）。

**关键文件**：`src/tools/BashTool/bashPermissions.ts`，`src/types/permissions.ts`

---

### 8. 插件热加载与能力扩展

**问题摘要**：如何在不修改核心代码、不重启进程的情况下，让 agent 获得新能力？

**核心思路**：Plugin（纯 Markdown + JSON 包，无可执行代码）+ Skill（`getPromptForCommand()` 行为注入）双轨扩展。Plugin 启动时并行加载（`Promise.allSettled` 错误隔离），Skill 通过 chokidar 文件监听实现热重载（300ms 防抖）。

**关键文件**：`src/utils/plugins/pluginLoader.ts`，`src/tools/SkillTool/SkillTool.ts`，`src/utils/skills/skillChangeDetector.ts`

---

### 9. 分层内存架构

**问题摘要**：如何在对话轮次间、会话间保持连贯「记忆」，同时不让所有信息堆进 context window？

**核心思路**：三层分离——短期（JSONL append-only，parentUuid DAG 链）、中期（compact 摘要，LLM 生成 + boundary marker 切片）、长期（memory files，每条记忆独立文件 + MEMORY.md 索引）。Git root 作为记忆目录键保证 worktree 共享。

**关键文件**：`src/memdir/memdir.ts`，`src/utils/sessionStorage.ts`，`src/services/extractMemories/extractMemories.ts`

---

### 10. 上下文压缩触发与摘要注入

**问题摘要**：Context window 有限，如何在长对话中不丢失重要信息？

**核心思路**：阈值触发（`tokenCount >= contextWindow - 33K`）→ LLM 生成 9 章节结构化摘要（先 `<analysis>` 草稿再正文）→ 替换旧消息 + 写 boundary marker。LLM 摘要而非硬截断，保留语义连贯性和任务状态。Prompt cache 共享降低摘要 API 成本。

**关键文件**：`src/services/compact/autoCompact.ts`，`src/services/compact/compact.ts`，`src/services/compact/prompt.ts`

---

## 使用建议

这些模式卡片的"在自己项目中的应用思考"部分留空，供个人填写。建议在阅读每个卡片后，结合自己当前或计划中的项目，回答三个问题：

1. **这个问题在我的项目中存在吗？** — 如果不存在，这个模式可能不适用
2. **可以直接用吗？还是需要简化/调整？** — 评估复杂度匹配度
3. **可以省略的复杂度：** — 识别哪些是 Claude Code 特有的需求，在自己项目中可以简化

**精读来源**：`docs/study-notes/phase-b/`（task-04 到 task-09）
