# 模式卡片 #8：插件热加载与能力扩展

**来源子系统**：插件与技能系统（Plugin & Skill）
**Claude Code 关键文件**：`src/utils/plugins/pluginLoader.ts`，`src/tools/SkillTool/SkillTool.ts`，`src/utils/skills/skillChangeDetector.ts`

---

## 问题

如何在不修改核心代码、不重启进程的情况下，让 agent 获得新的行为能力？同时，如何防止第三方扩展破坏核心系统的稳定性或安全性？

## 方案

Plugin + Skill 双轨扩展机制：

**Plugin 轨道**（结构化包扩展）：
- 插件是纯文件系统包（Markdown + JSON），不含可执行代码
- 通过 marketplace 机制分发，支持 npm / git / GitHub / 本地路径
- 安装后缓存到 `~/.claude/plugins/cache/`，版本化存储
- 启动时 `Promise.allSettled` 并行加载所有 enabled plugins，错误隔离（单个失败不中断其他插件）

**Skill 轨道**（行为注入扩展）：
- Skill 是命名的 `getPromptForCommand()` 函数，返回 Markdown 文本
- 调用时将文本以 user 消息形式注入对话，无需重新构建 system prompt
- Chokidar 文件监听实现热重载（300ms 防抖，Bun 下降级为 polling）

**热重载流程**（`skillChangeDetector.ts`）：
```
文件变更（chokidar/polling）→ 300ms 防抖
  → clearSkillCaches() + clearCommandsCache()
  → executeConfigChangeHooks('skills', path)
  → skillsChanged.emit()
```

## 关键设计决策

1. **Plugin（配置发布单元）和 Skill（执行单元）分离**：
   - 安全分层：Plugin 不能执行代码（无 TypeScript 文件），只能声明内容。插件仓库无法注入恶意代码，只能提供 Markdown 指令
   - 职责分离：Plugin 解决"如何打包和分发"，Skill 解决"如何改变模型行为"
   - 粒度不同：Plugin 是"组件集合"（含多个 commands + hooks + MCP 服务器），Skill 是"单一行为"

2. **插件失败隔离**：`Promise.allSettled` 保证单个插件失败不中断其他插件；错误收集到 `PluginError[]` 不抛出异常；致命错误只影响该插件，用户在 `/plugin` UI 中看到错误提示。

3. **Context budget 管理**（`prompt.ts`）：Skill 列表占总 context window 的 1%（`SKILL_BUDGET_CONTEXT_PERCENT`），每个条目上限 250 字符。Bundled skills 永不截断；non-bundled skills 超预算时逐步退化。这是"发现列表 vs 执行内容"分离设计：列表只做索引，完整内容在调用时才加载。

4. **Bun 环境降级**：Bun 的 fs.watch() 存在 deadlock bug（oven-sh/bun#27469），强制使用 polling 模式（`USE_POLLING = typeof Bun !== 'undefined'`）。

## 适用条件

- 需要向 AI agent 分发可复用行为模式（/commit、/review、/deploy）
- 需要在不同项目/团队间共享工具集
- 需要在不修改核心二进制的前提下扩展 agent 能力
- 需要用户可自定义和启用/禁用特定功能

## 权衡

**优点：**
- 无代码插件：安全边界清晰，插件无法执行恶意代码
- 热重载：无需重启进程
- 版本化缓存：稳定性
- 错误隔离：主系统不受影响

**缺点/局限：**
- 无法执行复杂逻辑（需要 bundled skill 或 MCP 工具）
- 热重载存在 300ms 延迟 + Bun polling 性能损耗
- 缓存管理复杂（版本化 + ZIP + Seed 三层缓存）
- 错误信息需通过 `/plugin` UI 查看，不在主对话中显示
- 非 bundled skill 描述可能被截断，降低发现准确率

---

## 在自己项目中的应用思考

**这个问题在我的项目中存在吗？**
（待填写）

**可以直接用吗？还是需要简化/调整？**
（待填写）

**可以省略的复杂度：**
（待填写）
