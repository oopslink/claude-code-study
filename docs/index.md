---
title: Claude Code 源码学习笔记索引
---

# Claude Code 源码学习笔记索引

> 学习周期：2026-03-31
> 覆盖版本：claude-code 开源版本（main 分支）
> 学习路径：Phase A（心智模型）→ Phase B（子系统深潜）→ Phase C（模式提炼与复盘）

---

## Phase A：建立心智模型

- [Task 1：启动流程与运行模式](study-notes/phase-a/task-01-startup.md)
  — 并行启动优化、Feature Flags（COORDINATOR_MODE / KAIROS）、8 种运行模式、setup.ts 全局状态

- [Task 2：核心数据结构](study-notes/phase-a/task-02-data-structures.md)
  — Message 类型 Union、PermissionMode、Tool 接口（~70 字段）、ToolUseContext、权限决策四元组

- [Task 3：六大子系统速览与边界图](study-notes/phase-a/task-03-system-overview.md)
  — 子系统一览、初版系统边界图、核心枢纽与叶子节点分析

---

## Phase B：核心子系统深潜

- [Task 4：Agent 核心循环](study-notes/phase-b/task-04-agent-loop.md)
  — `query()` AsyncGenerator、`while(true)` 状态机、11 个退出点、重试策略、QueryEngine 多轮历史维护

- [Task 5：工具系统](study-notes/phase-b/task-05-tool-system.md)
  — `Tool.call()` 签名、`getAllBaseTools()` vs `getTools()`、条件工具注册、FileReadTool 去重、AgentTool fork 机制

- [Task 6：多智能体架构](study-notes/phase-b/task-06-multi-agent.md)
  — 7 种 TaskType、LocalAgentTask 上下文克隆、RemoteAgentTask HTTP 轮询、InProcessTeammateTask mailbox、Coordinator 工具过滤

- [Task 7：安全与沙箱](study-notes/phase-b/task-07-security.md)
  — bash AST 节点类型、FAIL-CLOSED 策略、五层防御模型、危险模式 23 类、路径约束、OS sandbox

- [Task 8：插件与技能系统](study-notes/phase-b/task-08-plugins-skills.md)
  — Plugin（声明式包）vs Skill（行为注入）、5 种来源加载、热重载（chokidar + 300ms 防抖）、SkillTool 执行流

- [Task 9：上下文与内存管理](study-notes/phase-b/task-09-memory.md)
  — 三层内存架构（短期 JSONL / 中期 compact 摘要 / 长期 MEMORY.md）、autoCompact 阈值计算、extractMemories 后台子代理

---

## Phase C：设计模式提炼

- [Task 10：横切关注点分析](study-notes/phase-c/task-10-cross-cutting.md)
  — 错误处理分类（5 类）、HTTP 状态码策略、权限检查时机、Tool vs Task vs Plugin vs Skill 精确边界、AsyncGenerator 选择原因、回调注入三件套

- [Task 12：复盘与总结](study-notes/phase-c/task-12-reflection.md)
  — 完整系统边界图（更新版，含数据结构 + 异步边界）、10 个关键设计决策、5 个意外发现、6 条可简化的复杂度、3 个最值得复用的设计、重新设计的思考

---

## 苏格拉底专题（对话式深潜）

- [专题 01：安全体系与 Agent 循环](study-notes/superpowers/socratic-01-security-and-agent-loop.md)
  — 五层防御模型、Bash AST fail-closed、flag 级只读白名单、git hooks 攻击、Agent 状态机、工具并发控制

---

## 设计模式卡片

- [10 个可复用模式卡片索引](study-notes/patterns/README.md)

| # | 模式名称 | 核心文件 |
|---|---------|---------|
| 1 | 流式响应 + 工具调用循环 | `src/query.ts` |
| 2 | Tool 接口统一抽象 | `src/Tool.ts` |
| 3 | 进度上报与 UI 解耦 | `src/tools/AgentTool/AgentTool.tsx` |
| 4 | 分层 Agent 编排 | `src/tasks/LocalAgentTask/` |
| 5 | Coordinator-Worker 模式 | `src/coordinator/coordinatorMode.ts` |
| 6 | 多层防御安全模型 | `src/utils/bash/ast.ts` |
| 7 | 声明式权限规则引擎 | `src/utils/permissions/` |
| 8 | 插件热加载与能力扩展 | `src/utils/plugins/pluginLoader.ts` |
| 9 | 分层内存架构 | `src/memdir/memdir.ts` |
| 10 | 上下文压缩触发与摘要注入 | `src/services/compact/autoCompact.ts` |
