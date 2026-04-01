---
---
# Task 08：插件与技能系统深度精读

> 精读日期：2026-03-31
> 精读模型：Claude Sonnet 4.6
> 代码库：`/Users/oopslink/works/codes/oos/claude-code/src/`

---

## 一、Plugin vs Skill 本质区别（一句话定义）

| 机制 | 本质定义 |
|------|---------|
| **Plugin** | 一个**文件系统包**（目录 + 可选 plugin.json），从外部来源（marketplace / git / npm / 本地路径）安装，向系统注册 **commands（Markdown 文件）、agents（Markdown 文件）、hooks（JSON 配置）、MCP 服务器（.mcpb/.dxt）、输出样式**等结构化组件；自身不含可执行 TypeScript 代码，是"配置包"。 |
| **Skill** | 一个**行为单元**，其核心是一个 `getPromptForCommand(args)` 函数，被调用时返回 `ContentBlockParam[]`（纯文本块）；执行时内容以 **user 消息**形式注入到当前对话，驱动 Claude 完成特定任务。Skill 是"行为扩展点"。 |

**核心区别**：Plugin 是安装时注册的**结构化包**（声明式），Skill 是运行时触发的**行为注入**（命令式）。Plugin 可以携带 Skill（commands/ 目录下的 Markdown 即为 Skill 内容），但 Skill 不依赖 Plugin 机制也可以独立注册（bundled skills 用 TypeScript 代码直接注册）。

---

## 二、全面回答 12 个问题

### Q1. Plugin 和 Skill 各自是什么？

**Plugin**：一个从 marketplace / git / npm / 本地目录安装的目录包，包含可选的 plugin.json 清单和若干子目录（commands/、agents/、hooks/、skills/、output-styles/）。Plugin 不能执行任意代码，只能注册 Markdown 命令、Agent 定义文件、Hook 配置 JSON 和 MCP bundle 文件。

**Skill**：一个可被模型通过 `SkillTool`（`tool_use` 类型）调用的命名行为单元。每个 Skill 有 `name`、`description`、可选的 `allowedTools`、可选的 `model` 以及核心的 `getPromptForCommand(args)` 函数。调用后函数返回 Markdown 文本块，这些文本块以 **user 消息**的形式注入到对话流。

### Q2. Plugin 可以注册哪些类型的扩展？

从 `createPluginFromPath`（pluginLoader.ts:1348）及相关 schema 可以确认：

| 类型 | 目录/文件 | 说明 |
|------|-----------|------|
| Commands（斜杠命令） | `commands/` 目录或 manifest.commands | Markdown 文件，每个文件成为一个 `/plugin:name` 命令 |
| Agents（自定义 Agent） | `agents/` 目录或 manifest.agents | Markdown 文件，定义专用 Agent |
| Hooks（生命周期钩子） | `hooks/hooks.json` 或 manifest.hooks | JSON 配置，响应 PreToolUse / PostToolUse 等 ~20 种事件 |
| Skills | `skills/` 目录 | Markdown 文件，注册为 Skill（与 commands/ 类似但走 Skill 路径） |
| MCP 服务器 | `.mcpb` / `.dxt` 文件 | MCP bundle，提供工具给模型 |
| Output Styles（输出样式） | `output-styles/` 目录 | 控制输出格式 |
| Plugin 设置 | `settings.json` 或 manifest.settings | 仅允许白名单 key（当前仅 `agent`） |

### Q3. Skill 的内容格式是什么？执行时发生了什么？

**内容格式**：Skill 内容格式灵活，但核心载体是 **Markdown 文本**（`ContentBlockParam[]`，实际为 `{ type: 'text', text: string }[]`）。

- **Bundled skills**（`src/skills/bundled/`）：TypeScript 函数，`getPromptForCommand(args)` 动态生成 Markdown 字符串。例如 `debug.ts` 会读取调试日志尾部内容后拼接成 Markdown 指令返回。
- **Disk-based skills**（用户 `.claude/skills/` 或 plugin skills/）：`SKILL.md` 文件，支持 YAML frontmatter（`allowedTools`、`model`、`description` 等）+ Markdown 正文，正文中 `$ARGUMENTS` 占位符被实际参数替换。
- **MCP skills**：通过 MCP 协议从外部服务器加载。

**执行时发生了什么**（inline 模式，最常见）：

```
SkillTool.call()
  └→ processPromptSlashCommand(commandName, args, commands, context)
       └→ command.getPromptForCommand(args)  // 获取 ContentBlockParam[]
  └→ tagMessagesWithToolUseID(newMessages, toolUseID)
  └→ return { data, newMessages, contextModifier }
       // newMessages 是 UserMessage[]，包含 Skill 内容
       // contextModifier 更新 allowedTools / model / effort
```

Skill 内容被封装为 **user 消息**（`UserMessage`），通过 `newMessages` 字段返回到主循环，主循环将这些消息追加到对话历史，然后再次调用 API，这样 Claude 就"看到"了 Skill 的指令文本并据此行动。**注入方式是 user 消息，而非 system prompt，也非 tool result。**

对于 **fork 模式**（command.context === 'fork'）：Skill 内容被包装为初始 user 消息，传给一个独立的子 Agent（`runAgent()`），子 Agent 运行完毕后将结果作为 tool result 返回给父 Agent。

---

### Q4. 插件从哪些位置加载？

来源优先级（从 pluginLoader.ts 顶部注释）：

1. **Marketplace-based plugins**：配置格式 `plugin@marketplace`，存于 `settings.json` 的 `enabledPlugins` 字段。Marketplace 可以来源于：
   - `github`：`{ source: 'github', repo: 'owner/repo', ref?, sha? }`
   - `git`（任意 URL）：`{ source: 'git', url: '...', ref?, sha? }`
   - `git-subdir`：只克隆仓库某个子目录（稀疏克隆）
   - `npm`：`{ source: 'npm', package: 'pkg-name', version?, registry? }`
   - `url`：HTTP/HTTPS/SSH git URL
   - `local`：本地文件路径字符串（直接 copy）

2. **Session-only plugins**（`--plugin-dir` CLI 参数或 SDK `plugins` 选项）：仅在本次会话生效，不写入设置。

3. **内置 Builtin plugins**（`src/plugins/bundled/`）：目前脚手架已就绪但无已注册插件（`initBuiltinPlugins()` 函数体为空，等待迁移）。

**缓存位置**：`~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/`（版本化缓存），旧版为 `~/.claude/plugins/cache/{plugin-name}/`（遗留路径）。还支持 ZIP 缓存（`{...}.zip`）和 Seed 缓存（预置镜像，供 CCR 环境使用）。

---

### Q5. 插件加载的完整流程

```
loadAllPluginsCacheOnly() / loadAllPlugins()
  │
  ├─ 读取 settings.enabledPlugins（合并 --add-dir 插件）
  ├─ 过滤 plugin@marketplace 格式
  ├─ 加载 known_marketplaces.json（Safe 变体：损坏时返回 {}）
  ├─ 企业策略检查（allowlist / blocklist）──失败 → push error，跳过此插件
  ├─ 并行预加载各 marketplace 的 catalog（marketplace.json）
  │
  ├─ 对每个 plugin 并行执行：
  │   ├─ 在 catalog 中查找 entry
  │   ├─ [全量模式] 检查版本化缓存 → ZIP 缓存 → Seed 缓存 → 执行网络下载
  │   │   ├─ npm: npm install → copy
  │   │   ├─ github: git clone → checkout sha
  │   │   ├─ git: git clone → checkout sha
  │   │   ├─ git-subdir: sparse-checkout → rename 子目录
  │   │   └─ local: copyDir
  │   ├─ [缓存模式] 读 installPath，不做网络请求
  │   │
  │   └─ finishLoadingPluginFromPath()
  │       ├─ 读 .claude-plugin/plugin.json（或旧版 plugin.json）
  │       ├─ Zod 验证 PluginManifestSchema
  │       ├─ createPluginFromPath()
  │       │   ├─ 扫描 commands/、agents/、skills/、output-styles/ 是否存在
  │       │   ├─ 验证 manifest 指定的额外路径（并行 pathExists）
  │       │   ├─ 加载 hooks/hooks.json → mergeHooksSettings
  │       │   └─ 加载 settings.json（白名单过滤）
  │       └─ 返回 LoadedPlugin
  │
  └─ 汇总 { enabled, disabled, errors }（通过 memoize 缓存结果）
```

---

### Q6. 插件加载失败如何处理？

**隔离失败，不影响主系统**。核心策略：

1. **错误收集而非抛出**：`createPluginFromPath` 维护 `errors: PluginError[]` 数组，将路径缺失、hook 加载失败等问题 push 进去并继续。
2. **Promise.allSettled**：`loadPluginsFromMarketplaces` 用 `allSettled` 并行加载所有插件，单个插件失败不中断其他插件。
3. **失败模式分类**：`PluginError.type` 包括 `path-not-found`、`hook-load-failed`、`plugin-not-found`、`marketplace-blocked-by-policy`、`plugin-cache-miss`、`generic-error`。这些错误通过 `/plugin` UI 展示给用户，主循环正常继续。
4. **Manifest 验证失败**：如果 plugin.json 存在但无效，**抛出错误**（这是唯一会中断该插件加载的场景，但仍被 allSettled 隔离）。
5. **Memoize 缓存**：`loadAllPluginsCacheOnly` 通过 `memoize` 缓存，避免重复 I/O；热重载时通过 `clearPluginCache()` 清除。

---

### Q7. 插件的安全边界

**插件没有进程沙箱**，安全边界通过以下机制实现：

1. **内容限制（白名单）**：插件只能提供 Markdown 文件（命令/agent 定义）、JSON 配置（hooks）、MCP bundle，**不能执行任意 JavaScript/TypeScript 代码**。这是架构级隔离。
2. **设置白名单**：插件的 `settings.json` 只有白名单 key 被接受（`PluginSettingsSchema` 用 `.pick({ agent: true }).strip()`），当前仅允许 `agent` 键。
3. **路径遍历防护**：`validatePathWithinBase()` 验证插件声明的路径必须在插件目录内，防止 `../` 逃逸。
4. **Marketplace 名称保护**：`BLOCKED_OFFICIAL_NAME_PATTERN` 阻止第三方伪造 `anthropic-marketplace` 等官方名称；保留名称必须来自 `github.com/anthropics/` 组织（`validateOfficialNameSource`）。
5. **企业策略**：`strictKnownMarketplaces`（allowlist）和 `blockedMarketplaces`（blocklist）双重控制，可配置为只允许来自特定 source 的 marketplace。
6. **URL 验证**：`validateGitUrl()` 只允许 HTTPS、HTTP、file://、git@SSH 协议，阻止其他协议。
7. **Hook 的安全性**：Hook 内容是 JSON 配置（shell 命令路径），实际执行由 Claude Code 主进程的 hooks 系统处理，与普通 settings.json hooks 等同对待。

**本质**：Claude Code 选择"可信内容 + 不可信来源"模型，而非进程级沙箱。插件内容经过结构验证，但一旦通过验证，其 hook 命令可以访问本地系统。

---

### Q8. SkillTool.call() 核心逻辑

```typescript
// 两条执行路径：

// 路径 A：fork 模式（command.context === 'fork'）
executeForkedSkill(command, commandName, args, context, ...)
  └→ prepareForkedCommandContext(command, args, context)
       └→ command.getPromptForCommand(args)  // 获取 Markdown 内容
       └→ skillContent = blocks.join('\n')
       └→ promptMessages = [createUserMessage({ content: skillContent })]
  └→ runAgent({ promptMessages, agentDefinition, ... })  // 独立子 Agent
  └→ 返回 { status: 'forked', result: lastAssistantMessage }
     // 结果作为 tool result 返回给父 Agent

// 路径 B：inline 模式（默认）
processPromptSlashCommand(commandName, args, commands, context)
  └→ command.getPromptForCommand(args)  // 获取 ContentBlockParam[]
  └→ 构建 newMessages (UserMessage[] with COMMAND_MESSAGE_TAG)
  └→ tagMessagesWithToolUseID(newMessages, toolUseID)  // 保持 transient 状态
return {
  data: { success, commandName, allowedTools, model },
  newMessages,           // <-- 注入对话的关键
  contextModifier(ctx) { // 更新 allowedTools / mainLoopModel / effortValue
    ...
  }
}
```

**关键**：`newMessages` 是 SkillTool 区别于其他所有工具的特殊能力——返回结果中携带新消息，主循环将这些消息追加到对话历史并重新发 API 请求，使 Skill 内容成为"对话的一部分"。

---

### Q9. Skill 注入方式

**Skill 注入方式是 user 消息**。

- Inline 模式：Skill 内容被封装为 `UserMessage`，通过 `newMessages` 返回，追加到对话历史中紧跟 SkillTool 的 tool_result 之后，下一轮 API 请求时模型可见。
- Fork 模式：Skill 内容被封装为 `createUserMessage({ content: skillContent })`，成为子 Agent 的第一条 user 消息，子 Agent 独立运行，最终结果以 tool result 形式返回父 Agent。

不是 system prompt（system prompt 在 API 调用前固定，Skill 在调用中动态注入）。不是纯 tool result（虽然 SkillTool 自身返回 tool result，但它额外携带 newMessages 来注入 user 消息）。

---

### Q10. 一个 Skill 可以包含哪些元素？

从 `BundledSkillDefinition` 类型（bundledSkills.ts）和 Markdown skill 的 frontmatter schema：

| 元素 | 来源 | 说明 |
|------|------|------|
| `name` | 必填 | Skill 的名称，即 `/name` 命令 |
| `description` | 必填 | 简短描述，显示在 Skill 列表 |
| `whenToUse` | 可选 | 告诉模型何时调用此 Skill（列表中显示为 `${description} - ${whenToUse}`）|
| `allowedTools` | 可选 | Skill 执行期间自动 allow 的工具列表（如 `['Read', 'Grep']`）|
| `model` | 可选 | 覆盖执行此 Skill 时使用的模型 |
| `argumentHint` | 可选 | 参数提示（如 `[issue description]`）|
| `aliases` | 可选 | 别名列表 |
| `disableModelInvocation` | 可选 | 为 true 时，模型无法通过 SkillTool 调用（只能用户手动输入）|
| `userInvocable` | 可选 | 是否在用户 UI 中显示 |
| `context` | 可选 | `'inline'`（默认）或 `'fork'`（独立子 Agent 执行）|
| `agent` | 可选 | fork 模式下使用哪个 agent 类型 |
| `hooks` | 可选 | Skill 级别的 hooks 配置 |
| `files` | 可选 | Bundled skills 可携带参考文件，首次调用时解压到磁盘 |
| `effort` | 可选 | 思考努力程度（从 Markdown frontmatter 读取）|
| `getPromptForCommand` | 必填 | 核心函数，接受 args 返回 `ContentBlockParam[]` |

Markdown disk-based skill 的 YAML frontmatter 支持同等字段，正文中用 `$ARGUMENTS` 占位符接收参数。

---

### Q11. 内置 Skill 示例：debug

**文件**：`src/skills/bundled/debug.ts`

**结构**：
- `name: 'debug'`
- `description`：根据用户类型不同（ant 内部用户显示完整调试信息，外部用户只提示启用 debug 日志）
- `allowedTools: ['Read', 'Grep', 'Glob']`
- `disableModelInvocation: true`（只能用户手动 `/debug` 调用，不能被模型主动触发）
- `userInvocable: true`

**`getPromptForCommand(args)` 逻辑**：
1. 调用 `enableDebugLogging()` 开启本次会话的调试日志（若未开启）
2. 读取调试日志文件的最后 64KB（`stat → fd.read` 尾读，避免大文件 OOM）
3. 格式化日志为 Markdown 字符串，包括：日志大小、最后 20 行原始内容
4. 拼接成完整 Markdown 提示，包含：
   - "## Debug Skill" 标题
   - 可能的"调试日志刚刚启用"提示
   - 日志文件路径和内容
   - 用户描述的问题（`args`）
   - 设置文件路径（user/project/local 三个层级）
   - 明确的分步骤指令（读日志 → 查 ERROR/WARN → 分析 → 给出建议）
5. 返回 `[{ type: 'text', text: prompt }]`

这是一个典型的"动态生成 prompt 注入对话"模式：Skill 在调用时采集环境状态（日志），生成上下文丰富的指令文本，注入为 user 消息，然后 Claude 按指令执行。

---

### Q12. 内置 Plugin 示例

**现状**：`src/plugins/bundled/index.ts` 中的 `initBuiltinPlugins()` 函数体当前**为空**，注释说明这是"供用户可开关功能的脚手架，尚未迁移任何 bundled skill"。

**外部 Plugin 的典型结构**（从代码推断）：

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json          # { name, version, description, author }
├── commands/
│   ├── build.md             # /my-plugin:build 命令
│   └── deploy.md            # /my-plugin:deploy 命令
├── agents/
│   └── code-reviewer.md     # 专用 Agent
├── hooks/
│   └── hooks.json           # { "hooks": { "PreToolUse": [...] } }
└── skills/
    └── analyze/
        └── SKILL.md         # /my-plugin:analyze 技能
```

从 `loadPluginHooks.ts` 可见，plugin 的 hooks 被转换为 `PluginHookMatcher[]`，带上 `pluginRoot`、`pluginName`、`pluginId` 上下文，注册到全局 hook 系统，与用户 settings.json 中的 hooks 等同对待。

---

## 三、Plugin vs Skill 对比表

| 维度 | Plugin | Skill |
|------|--------|-------|
| **本质** | 文件系统包（目录 + 可选清单），声明式扩展容器 | 命名行为单元，运行时调用 `getPromptForCommand()` 注入 user 消息 |
| **内容格式** | 目录结构：`commands/*.md`、`agents/*.md`、`hooks/hooks.json`、`.mcpb`，以 JSON 清单描述 | 主体是 Markdown 文本（可动态生成）；Bundled Skill 用 TypeScript 函数；Disk Skill 是 `SKILL.md` 文件（YAML frontmatter + Markdown 正文）|
| **加载时机** | **启动时**加载并缓存（`loadAllPluginsCacheOnly()` memoized），热重载由 `skillChangeDetector` 触发 | Bundled skill 在 **CLI 启动时** 注册（`initBundledSkills()`）；Disk/Plugin skill 在首次查询时懒加载；MCP skill 从 AppState 实时读取 |
| **可注册内容** | Commands、Agents、Hooks、Skills、MCP servers、Output styles、Settings（白名单） | 一个 `getPromptForCommand` 函数 + 元数据（`allowedTools`、`model`、`effort`、`context` 等） |
| **隔离方式** | 无进程沙箱；架构级内容限制（只接受 Markdown + JSON 配置，不执行代码）；路径遍历防护；Marketplace 名称防仿冒；企业 policy 控制来源 | Inline 模式：在父 Agent 对话流内（共享 context）；Fork 模式：在隔离子 Agent 内运行（独立 ToolUseContext，mutable state 隔离） |
| **典型用途** | 分发一组相关命令/工具给团队，如代码审查插件（包含 review 命令 + pre-tool-use hooks）；提供专用 MCP 工具服务器 | 封装可复用的 AI 行为模式，如 `/debug`（读日志 + 分析）、`/simplify`（代码质量审查）、`/commit`（生成 commit 消息） |
| **来源** | npm 包、GitHub 仓库、git URL（稀疏克隆支持）、本地路径 | Bundled（编译进二进制）、Disk（`~/.claude/skills/` 或项目 `.claude/skills/`）、Plugin 携带（plugin 的 skills/ 目录）、MCP 协议提供 |

---

## 四、Skill 执行路径详解（流程图）

```
用户输入 "/debug some issue"
         │
         ▼
主循环发 API 请求（含 SkillTool 定义 + system-reminder 中的 skill 列表）
         │
         ▼
Claude 决策：调用 SkillTool { skill: "debug", args: "some issue" }
         │
         ▼
SkillTool.validateInput()
  ├─ 查找 command（getAllCommands → localCommands + mcpSkills）
  ├─ 检查 command.type === 'prompt'
  └─ 检查 !disableModelInvocation    ← /debug 设置了此标志，所以模型实际上无法调用！
         │
         ▼（以一个无 disableModelInvocation 的 skill 为例，如 /simplify）
SkillTool.checkPermissions()
  ├─ 查 deny 规则
  ├─ 查 allow 规则
  ├─ skillHasOnlySafeProperties → auto-allow
  └─ 否则 → 向用户询问权限
         │
         ▼
SkillTool.call()
  ├─ [fork] executeForkedSkill → runAgent(子 Agent) → tool result
  └─ [inline] processPromptSlashCommand
                 └→ command.getPromptForCommand(args)
                      // 返回 ContentBlockParam[]（Markdown 文本）
                 └→ 构建 UserMessage（newMessages）
                 └→ tagMessagesWithToolUseID（标记 transient）
  └─ return {
       data: { success, commandName, allowedTools, model },
       newMessages: [UserMessage(skill content)],
       contextModifier: (ctx) => { ... allowedTools / model / effort ... }
     }
         │
         ▼
主循环处理 ToolResult
  ├─ 追加 newMessages 到对话历史
  ├─ contextModifier 更新 ToolUseContext
  └─ 发下一轮 API 请求（包含 Skill 的 user 消息内容）
         │
         ▼
Claude 看到 Skill 内容，按指令执行任务
```

---

## 五、关键设计发现

### 5.1 Skill 列表的上下文预算管理

`prompt.ts` 中有精细的 context budget 管理：

- Skill 列表占总 context window 的 **1%**（`SKILL_BUDGET_CONTEXT_PERCENT = 0.01`）
- 每个条目硬性上限 **250 字符**（`MAX_LISTING_DESC_CHARS = 250`），确保发现效率不浪费 turn-1 cache tokens
- Bundled skills 永不截断；non-bundled skills 在超预算时逐步退化（先截短描述，再降为仅名称）
- 这是一个显式的"发现列表 vs 执行内容"分离设计：列表只做索引，完整内容在调用时才加载

### 5.2 addInvokedSkill 与 registerSkillHooks 的时机

`processPromptSlashCommand` 内部会调用 `addInvokedSkill`（记录 skill 被调用）和 `registerSkillHooks`（注册 skill 级别的 hooks）。SkillTool.call 的注释明确说明不要重复调用——这保证了 hook 注册的幂等性。

### 5.3 ZIP 缓存 + Seed 缓存（CCR 环境优化）

远程运行环境（CCR）预置 plugin 内容到镜像中（Seed 缓存），启动时直接读取，无需网络克隆。ZIP 缓存将目录压缩为单文件以减少 IOPS（文件数量影响文件系统性能）。

### 5.4 Plugin 热重载

`skillChangeDetector.ts` 用 chokidar 监听 `~/.claude/skills/`、`.claude/skills/` 等目录，检测到 `.md` 文件变更后，300ms 防抖后触发：
1. `clearSkillCaches()` + `clearCommandsCache()` 清除缓存
2. `executeConfigChangeHooks('skills', path)` 触发 ConfigChange hooks
3. `skillsChanged.emit()` 通知订阅者

注意：Bun 的 fs.watch() 存在 deadlock bug（oven-sh/bun#27469），强制使用 polling 模式（`USE_POLLING = typeof Bun !== 'undefined'`）。

---

## 六、模式卡片 #8：插件热加载与能力扩展

```markdown
## 模式卡片 #8：插件热加载与能力扩展

### 问题
如何在不修改核心代码、不重启进程的情况下，让 agent 获得新的行为能力？
同时，如何防止第三方扩展破坏核心系统的稳定性或安全性？

### 方案：Plugin + Skill 双轨扩展机制

**Plugin 轨道**（结构化包扩展）：
- 插件是纯文件系统包（Markdown + JSON），不含可执行代码
- 通过 marketplace 机制分发，支持 npm / git / GitHub / 本地路径
- 安装后缓存到 `~/.claude/plugins/cache/`，版本化存储
- 启动时并行加载所有 enabled plugins，错误隔离（Promise.allSettled）

**Skill 轨道**（行为注入扩展）：
- Skill 是命名的 `getPromptForCommand()` 函数，返回 Markdown 文本
- 调用时将文本以 user 消息形式注入对话，无需重新构建 system prompt
- Chokidar 文件监听实现热重载（300ms 防抖，Bun 下降级为 polling）

### 关键设计决策：为什么 Plugin（代码扩展）和 Skill（行为扩展）要分离？

1. **安全分层**：Plugin 是"配置发布单元"，Skill 是"执行单元"。Plugin 不能执行代码（无 TypeScript 文件），只能声明内容。这样插件仓库无法注入恶意代码，只能提供 Markdown 指令。
2. **职责分离**：Plugin 解决"如何打包和分发"，Skill 解决"如何改变模型行为"。两者可以组合（Plugin 内携带 Skill），也可以独立（Bundled Skill 不依赖 Plugin 机制）。
3. **粒度不同**：Plugin 是"组件集合"（一个 Plugin 可含多个 commands + hooks + MCP 服务器），Skill 是"单一行为"（一个 Skill 完成一件事）。

### 加载隔离：插件失败如何不影响主系统？

1. `Promise.allSettled` 并行加载，单个失败不中断其他插件
2. 错误收集到 `PluginError[]` 数组，不抛出异常
3. 路径不存在等非致命错误：记录 error，跳过该组件，插件其余部分正常加载
4. Manifest 格式错误等致命错误：该插件加载失败，系统继续，用户在 `/plugin` UI 中看到错误提示
5. Memoize 缓存避免重复 I/O，热重载时显式清除缓存

### 适用条件

- 需要向 AI agent 分发可复用行为模式（/commit、/review、/deploy）
- 需要在不同项目/团队间共享工具集
- 需要在不修改核心二进制的前提下扩展 agent 能力
- 需要用户可自定义和启用/禁用特定功能

### 权衡

| 优势 | 代价 |
|------|------|
| 无代码插件：安全边界清晰 | 无法执行复杂逻辑（需要 bundled skill 或 MCP 工具） |
| 热重载：无需重启 | 热重载存在 300ms 延迟 + Bun polling 性能损耗 |
| 版本化缓存：稳定性 | 缓存管理复杂（版本化 + ZIP + Seed 三层缓存） |
| 错误隔离：主系统不受影响 | 错误信息需通过 `/plugin` UI 查看，不在主对话中显示 |
| Context budget 管理：不浪费 token | 非 bundled skill 描述可能被截断，降低发现准确率 |
```

---

## 七、参考文件索引

| 文件 | 作用 |
|------|------|
| `src/utils/plugins/pluginLoader.ts` | 核心 Plugin 加载逻辑（2400+ 行）：发现、克隆、验证、缓存 |
| `src/utils/plugins/loadPluginCommands.ts` | Plugin commands 目录扫描与转换为 Command 对象 |
| `src/utils/plugins/loadPluginHooks.ts` | Plugin hooks 注册与热重载订阅 |
| `src/utils/plugins/schemas.ts` | Plugin 所有 Zod schema（PluginManifestSchema、CommandMetadataSchema 等） |
| `src/tools/SkillTool/SkillTool.ts` | SkillTool 完整实现：validateInput、checkPermissions、call |
| `src/tools/SkillTool/prompt.ts` | Skill 列表格式化 + context budget 管理 |
| `src/tools/SkillTool/constants.ts` | `SKILL_TOOL_NAME = 'Skill'` |
| `src/utils/skills/skillChangeDetector.ts` | Skill 文件热重载（chokidar + debounce + Bun polling 降级）|
| `src/skills/bundledSkills.ts` | `registerBundledSkill()` 函数 + `BundledSkillDefinition` 类型 |
| `src/skills/bundled/index.ts` | 所有 bundled skill 的注册入口 |
| `src/skills/bundled/debug.ts` | 典型 bundled skill 示例（动态 prompt 生成）|
| `src/skills/bundled/loremIpsum.ts` | 简单 bundled skill 示例（参数处理 + 内容生成）|
| `src/plugins/bundled/index.ts` | Built-in plugin 入口（当前为空脚手架）|
| `src/utils/forkedAgent.ts` | `prepareForkedCommandContext()` + fork 模式支持 |
