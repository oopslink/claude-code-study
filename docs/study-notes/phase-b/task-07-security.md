# Task 07：安全与沙箱系统深度精读

> 精读时间：2026-03-31
> 核心问题：Claude Code 如何防止 LLM 生成的 bash 命令破坏用户系统？

---

## 一、必答问题解析

### AST 基础

**Q1：`ast.ts` 定义了哪些主要的 AST 节点类型？**

`ast.ts` 使用 tree-sitter-bash 的节点类型体系，核心类型分两组：

**结构性节点（STRUCTURAL_TYPES）** — 递归遍历时透明穿过：
- `program` — 根节点（整个脚本）
- `list` — 由 `&&`、`||` 或 `;` 连接的命令序列
- `pipeline` — 管道 `a | b`
- `redirected_statement` — 命令 + 重定向的组合节点

**危险节点（DANGEROUS_TYPES）** — 出现即触发 `too-complex`，放弃静态分析：
- `command_substitution` — `$(…)` 命令替换
- `process_substitution` — `<(…)` / `>(…)` 进程替换
- `expansion` / `simple_expansion` — `${var}` / `$var` 参数展开
- `brace_expression` — `{a,b}` brace 展开
- `subshell` — `(…)` 子 shell
- `for_statement` / `while_statement` / `until_statement` / `if_statement` / `case_statement` — 控制流
- `function_definition` — 函数定义
- `ansi_c_string` — `$'...'` ANSI-C 字符串（可编码任意字符）
- `heredoc_redirect` / `herestring_redirect` — heredoc

**叶节点（正常命令词）**：
- `command` — 一条简单命令
- `variable_assignment` — `VAR=value` 赋值
- `declaration_command` — `export`/`local`/`declare`/`typeset`/`readonly`
- `negated_command` — `! cmd`
- `file_redirect` — `>file`、`<file` 等重定向（操作符类型：`>`、`>>`、`<`、`>&`、`<&`、`>|`、`&>`、`&>>`、`<<<`）
- `comment` — 注释（直接跳过）

关键导出类型（在 `ast.ts` 开头定义）：
```typescript
export type SimpleCommand = {
  argv: string[]
  envVars: { name: string; value: string }[]
  redirects: Redirect[]
  text: string
}

export type ParseForSecurityResult =
  | { kind: 'simple'; commands: SimpleCommand[] }
  | { kind: 'too-complex'; reason: string; nodeType?: string }
  | { kind: 'parse-unavailable' }
```

---

**Q2：为什么需要 AST 而不是字符串正则匹配？**

**核心原因：字符串正则无法处理解析差异（parser differential）**。

经典例子——brace 展开绕过权限检查：

```bash
git ls-remote {--upload-pack="touch /tmp/test",test}
```

- **正则视角**：看到一个参数 `{--upload-pack="touch /tmp/test",test}`，是一个字符串整体，不包含任何危险模式
- **bash 实际执行**：brace 展开后等价于 `git ls-remote --upload-pack="touch /tmp/test" test`，其中 `--upload-pack="touch /tmp/test"` 会执行任意命令

AST 分析在这里能做到的事：在 tree-sitter 树中发现 `brace_expression` 节点，直接返回 `too-complex`，要求用户确认，而不是错误地认为命令安全。

另一个典型例子（文件中注释有详细说明）：

```bash
VAR="-rf /" && rm $VAR
```

- **正则**：扫描到 `rm`，检查其后是否有 `-rf /`，看不到（因为参数是 `$VAR`）
- **AST**：发现 `simple_expansion($VAR)` 节点，`BARE_VAR_UNSAFE_RE` 检测到变量值包含空格（word splitting 风险），返回 `too-complex`

**设计核心原则**：`ast.ts` 的注释写明——这是 **FAIL-CLOSED** 设计：任何未被明确 allowlist 的 AST 节点类型，都触发 `too-complex`，迫使走权限提示流程。

---

### bashSecurity.ts（安全检查核心）

**Q3：`bashSecurity.ts` 的主入口函数及签名？**

旧路径（regex/shell-quote，已标记 `@deprecated`）：
```typescript
export function bashCommandIsSafe_DEPRECATED(command: string): PermissionResult
```

新路径（AST + tree-sitter）入口在 `ast.ts`：
```typescript
export async function parseForSecurity(cmd: string): Promise<ParseForSecurityResult>
export function parseForSecurityFromAst(
  cmd: string,
  root: Node | typeof PARSE_ABORTED,
): ParseForSecurityResult
```

`bashPermissions.ts` 中实际使用的入口是 `checkCommandAndSuggestRules()`，在其内部调用 `bashCommandIsSafeAsync`（即 `bashCommandIsSafeAsync_DEPRECATED` 的别名）。

`PermissionResult` 返回类型（定义于 `src/types/permissions.ts`）：
```typescript
type PermissionResult =
  | { behavior: 'allow'; updatedInput: ...; decisionReason: ... }
  | { behavior: 'deny'; message: string; decisionReason: ... }
  | { behavior: 'ask'; message: string; suggestions?: ...; isBashSecurityCheckForMisparsing?: boolean; ... }
  | { behavior: 'passthrough'; message: string; ... }
```

---

**Q4：`bashSecurity.ts` 检测了哪些具体危险操作？**

文件定义了 23 个安全检查 ID（`BASH_SECURITY_CHECK_IDS`），按类别梳理：

**注入与命令替换（Shell Injection）**
- `DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION`(8)：检测 `$()`, `` ` ``, `<()`, `>()`, `=()` 等进程/命令替换（含 Zsh 特有语法）
- `BACKSLASH_ESCAPED_OPERATORS`(21)：反斜杠转义操作符 `\;`、`\|`，可隐藏命令结构
- `COMMENT_QUOTE_DESYNC`(22)：`#` 注释内含引号字符，可导致后续 quote tracker 状态错乱
- `QUOTED_NEWLINE`(23)：引号内换行后的下一行以 `#` 开头，可绕过 `stripCommentLines` 行处理

**解析差异（Parser Differential）**
- `MALFORMED_TOKEN_INJECTION`(14)：未闭合的分隔符，shell-quote 和 bash 解析不一致
- `BACKSLASH_ESCAPED_WHITESPACE`(15)：`\<空格>` 让 tree-sitter 和 bash 对 word boundaries 的理解不同
- `UNICODE_WHITESPACE`(18)：Unicode 空白字符（NBSP 等），肉眼不可见但影响解析
- `MID_WORD_HASH`(19)：中间位置的 `#`，shell-quote 当注释处理，bash 当字面字符
- `CONTROL_CHARACTERS`(17)：控制字符（null byte 等），bash 静默丢弃但会绕过检查器

**变量与重定向**
- `DANGEROUS_VARIABLES`(6)：变量出现在重定向或管道上下文 `< $VAR`、`$VAR |`
- `IFS_INJECTION`(11)：使用 `$IFS` 可绕过 word-split 验证
- `DANGEROUS_PATTERNS_INPUT_REDIRECTION`(9)：输入重定向 `<`（可读敏感文件）
- `DANGEROUS_PATTERNS_OUTPUT_REDIRECTION`(10)：输出重定向 `>`（可覆盖任意文件）

**Zsh 特有危险**
- `ZSH_DANGEROUS_COMMANDS`(20)：`zmodload`、`emulate`、`sysopen`、`ztcp`、`zpty` 等，可绕过二进制权限检查
- Zsh `=cmd` equals expansion（在 `COMMAND_SUBSTITUTION_PATTERNS` 中）：`=curl evil.com` 展开为 `/usr/bin/curl`，绕过 `Bash(curl:*)` deny 规则

**混淆技术（Obfuscation）**
- `OBFUSCATED_FLAGS`(4)：ANSI-C quoting `$'...'`，空引号拼接 `''-exec`，相邻空引号与 dash `"""-f"` 等
- `BRACE_EXPANSION`(16)：`{a,b}` 或 `{a..b}` brace 展开，可将多个 flag 隐藏为一个词
- `SHELL_METACHARACTERS`(5)：引号内含 `;`、`|`、`&`

**特定命令**
- `JQ_SYSTEM_FUNCTION`(2)：`jq` 的 `system()` 函数可执行任意命令
- `JQ_FILE_ARGUMENTS`(3)：`jq` 的 `-f`/`--from-file`/`--rawfile` 可读取任意文件为 jq 代码
- `GIT_COMMIT_SUBSTITUTION`(12)：git commit 消息中含 `$()` 或 `` ` ``
- `PROC_ENVIRON_ACCESS`(13)：访问 `/proc/self/environ` 等，可泄漏环境变量
- `NEWLINES`(7)：未引用的换行分隔符（可隐藏多条命令）
- `INCOMPLETE_COMMANDS`(1)：以 `-`、`&&`、`||`、`;` 开头的碎片命令

---

**Q5：当检测到危险操作时，返回的数据结构？**

```typescript
// 典型 ask 结果
{
  behavior: 'ask',
  message: 'Command contains $() command substitution',
  // 可选字段：
  isBashSecurityCheckForMisparsing?: boolean,  // 标记为解析差异问题，会在 bashPermissions 早期拦截
  suggestions?: PermissionUpdate[],
  pendingClassifierCheck?: { command, cwd, descriptions }
}

// 明确拒绝
{
  behavior: 'deny',
  message: 'Permission to use Bash with command X has been denied.',
  decisionReason: { type: 'rule', rule: PermissionRule }
}
```

`isBashSecurityCheckForMisparsing: true` 是一个重要标记：表示触发原因是 shell-quote 和 bash 之间的解析差异（而非仅仅是"危险"），`bashToolHasPermission` 中会在 `splitCommand` 处理之前就拦截这类命令。

---

### bashPermissions.ts（权限规则引擎）

**Q6：权限规则的数据结构？**

```typescript
// 核心规则类型（src/types/permissions.ts）
type PermissionRule = {
  source: PermissionRuleSource  // 'userSettings' | 'projectSettings' | 'session' | 'cliArg' | ...
  ruleBehavior: PermissionBehavior  // 'allow' | 'deny' | 'ask'
  ruleValue: PermissionRuleValue  // { toolName: string; ruleContent?: string }
}

// ToolPermissionContext 是运行时规则容器
type ToolPermissionContext = {
  mode: PermissionMode  // 'default' | 'acceptEdits' | 'bypassPermissions' | ...
  alwaysAllowRules: ToolPermissionRulesBySource  // { userSettings?: string[], session?: string[], ... }
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  additionalWorkingDirectories: ReadonlyMap<string, AdditionalWorkingDirectory>
  isBypassPermissionsModeAvailable: boolean
  ...
}
```

Bash 规则内容（`ruleContent`）的语法，由 `shellRuleMatching.ts` 解析：
- 精确匹配：`git status` → 仅匹配这一条确切命令
- 前缀匹配：`git commit:*` → 匹配所有以 `git commit` 开头的命令
- 通配符：`npm run *` → 支持 glob 模式匹配

---

**Q7：规则匹配的优先级顺序？**

**Deny 优先于 Ask 优先于 Allow**，精确匹配优先于前缀/通配符匹配。

`bashToolCheckPermission()` 中明文写出的 8 步决策树：

```
1. 精确匹配 deny 规则 → deny
2. 精确匹配 ask 规则  → ask
3. 精确匹配 allow 规则 → （暂存，待后续 path check 通过后用）
4. 前缀/通配符 deny 规则 → deny
5. 前缀/通配符 ask 规则  → ask
6. 路径约束检查（checkPathConstraints）
7. 前缀/通配符 allow 规则 → allow
8. sed 约束检查
9. 模式检查（checkPermissionMode）
10. 只读检查（BashTool.isReadOnly）→ allow
11. passthrough → 触发权限提示弹窗
```

**Deny 规则和 Ask 规则使用更激进的 env var 剥离**（`stripAllEnvVars: true`）：
- 确保 `FOO=bar denied_command` 依然能匹配 `Bash(denied_command:*)` 的 deny 规则
- 而 allow 规则只剥离白名单中的安全 env var（`SAFE_ENV_VARS`），防止 `DOCKER_HOST=evil.com docker ps` 绕过 `Bash(docker ps:*)` 的 allow 规则

---

**Q8：用户自定义规则存储在哪里？如何加载？**

**存储位置**（按来源 `PermissionRuleSource`）：

| source | 物理路径 | 作用域 |
|--------|---------|--------|
| `userSettings` | `~/.claude/settings.json` | 全局，所有项目共享 |
| `projectSettings` | `<cwd>/.claude/settings.json` | 项目级 |
| `localSettings` | `<cwd>/.claude/settings.local.json` | 本地项目（不提交 git）|
| `policySettings` | 管理员策略文件 | 企业管控 |
| `flagSettings` | CLI 启动参数 `--allow-bash` 等 | 单次会话 |
| `cliArg` | CLI 传入的规则 | 单次会话 |
| `session` | 内存中（用户在当前对话确认"不再询问"）| 会话级临时 |
| `command` | 内置命令直接授权 | 单次操作 |

**加载方式**：通过 `extractRules()` 从各来源的 settings JSON 中读取 `alwaysAllow`、`alwaysDeny`、`alwaysAsk` 字段，整合进 `ToolPermissionContext`，在每次权限检查时通过 `getRuleByContentsForTool()` 查询。

---

### readOnlyValidation.ts（只读模式）

**Q9：只读模式的命令白名单有哪些？**

`readOnlyValidation.ts` 的 `COMMAND_ALLOWLIST` 包含以下命令族（每个命令有精细的安全 flag 白名单）：

**系统工具**：`xargs`、`file`、`sed`（只读模式：无 `-i` 原地修改）、`sort`、`man`、`help`、`netstat`、`ps`

**Git 操作**（`GIT_READ_ONLY_COMMANDS`，来自 `readOnlyCommandValidation.ts`）：
`git status`、`git log`、`git diff`、`git show`、`git branch`、`git remote`、`git stash list`、`git tag`、`git ls-files`、`git grep` 等（约 30+ 个只读子命令）

**外部工具**：
- `GH_READ_ONLY_COMMANDS`：`gh pr list`、`gh issue list`、`gh repo view` 等（ant 内部）
- `EXTERNAL_READONLY_COMMANDS`：`cat`、`ls`、`echo`、`grep`、`find`、`head`、`tail`、`wc`、`stat`、`pwd`、`which`、`type`、`env`、`printenv` 等基础命令
- `DOCKER_READ_ONLY_COMMANDS`：`docker ps`、`docker inspect`、`docker logs`、`docker images` 等
- `RIPGREP_READ_ONLY_COMMANDS`：`rg` 相关（含详细 flag 控制，排除 `--replace` 等修改操作）
- `PYRIGHT_READ_ONLY_COMMANDS`：静态类型检查命令

**常用只读命令列表（来自 COMMAND_ALLOWLIST）：**

| 命令 | 用途 |
|------|------|
| xargs | 构建和执行命令，传递参数 |
| file | 确定文件类型 |
| sed | 流式文本编辑器（仅只读模式，无 `-i` 修改） |
| sort | 行排序 |
| man | 查看手册页面 |
| help | 显示 shell 内置命令帮助 |
| netstat | 网络统计信息查询 |
| ps | 进程状态查询 |
| base64 | Base64 编码/解码 |
| grep | 文本搜索（管道配合） |
| sha256sum | SHA256 哈希校验 |
| sha1sum | SHA1 哈希校验 |
| md5sum | MD5 哈希校验 |
| tree | 目录树显示 |
| date | 日期时间信息 |
| hostname | 主机名查询 |
| info | GNU 信息查看 |
| lsof | 开放文件列表 |
| pgrep | 进程名搜索 |
| tput | 终端能力查询 |
| ss | 套接字统计信息 |
| fd/fdfind | 文件查找工具（rg 替代品风格）|
| aki | 内部工具 |

---

**Q10：判断一个命令是否只读的算法步骤？**

入口在 `BashTool.isReadOnly(input)` → `checkReadOnlyConstraints()`，算法如下：

1. **提取并剥离 Redirects**：调用 `extractOutputRedirections()` 分离输出重定向（`>`/`>>`/`&>` 等）。有输出重定向 → 非只读，立即返回 false

2. **拆分复合命令**：调用 `splitCommand_DEPRECATED()` 将 `&&`、`||`、`;` 分隔的命令拆成子命令列表

3. **对每个子命令**：
   a. 剥离安全 wrapper（`timeout`、`nohup`、`nice` 等）和安全 env var 前缀
   b. 提取 base command（第一个词）
   c. 在 `COMMAND_ALLOWLIST` 中查找该 base command
   d. 未找到 → 非只读

4. **Flag 验证**（`validateFlags()`）：
   - 解析命令参数列表
   - 对每个 flag，检查是否在该命令的 `safeFlags` Record 中
   - 验证 flag 的参数类型（`'none'` / `'string'` / `'number'` / `'char'` / 特定字面量）
   - 遇到不在白名单的 flag → 非只读

5. **额外回调验证**（`additionalCommandIsDangerousCallback`）：
   - 如 `sed` 会调用 `sedCommandIsAllowedByAllowlist()`，检查 sed 的表达式是否只包含读取操作（无 `w` 写操作、无原地修改）

6. 所有检查通过 → 只读

---

### 文件系统权限

**Q11：`filesystem.ts` 的 `pathInWorkingPath()` 如何防止路径逃逸？**

核心防御函数是 `pathInWorkingPath(path, workingPath)`：

```typescript
export function pathInWorkingPath(path: string, workingPath: string): boolean {
  const absolutePath = expandPath(path)          // 展开 ~，但不解析 symlink
  const absoluteWorkingPath = expandPath(workingPath)

  // 处理 macOS symlink 常见映射
  // /var -> /private/var,  /tmp -> /private/tmp
  const normalizedPath = absolutePath
    .replace(/^\/private\/var\//, '/var/')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1')
  const normalizedWorkingPath = absoluteWorkingPath
    .replace(...)

  // case-insensitive（防止 macOS/Windows 大小写绕过）
  const caseNormalizedPath = normalizeCaseForComparison(normalizedPath)
  const caseNormalizedWorkingPath = normalizeCaseForComparison(normalizedWorkingPath)

  // 计算相对路径
  const relative = relativePath(caseNormalizedWorkingPath, caseNormalizedPath)

  if (relative === '') return true  // 同一路径

  if (containsPathTraversal(relative)) return false  // 包含 `..`

  return !posix.isAbsolute(relative)  // 相对路径（在工作目录内）
}
```

**`containsPathTraversal(relative)`** 是关键：检测相对路径中是否含有 `..` 分量，有则拒绝。

**多路径检查机制**：`pathInAllowedWorkingPath()` 会同时检查**原始路径**和所有 **symlink 解析后的路径**（通过 `getPathsForPermissionCheck(path)` 获取，调用 `realpathSync` 解析 symlink chain）。两路径都必须在工作目录内才允许访问，防止通过 symlink 逃逸。

**危险路径额外检查**（`checkPathSafetyForAutoEdit()`）：
- `hasSuspiciousWindowsPathPattern()`：NTFS ADS（`::$DATA`）、8.3 短名（`GIT~1`）、长路径前缀（`\\?\`）、三点路径（`...`）、UNC 路径
- `isDangerousFilePathToAutoEdit()`：`.git/`、`.vscode/`、`.idea/`、`.claude/`、`.bashrc`、`.gitconfig` 等（case-insensitive 比较）
- `isClaudeConfigFilePath()`：Claude 自身配置文件始终需要确认

---

## 二、多层防御架构图

```
用户/LLM 提交 bash 命令
  │
  ▼
[前置：模式检查 checkPermissionMode]
  系统是否处于 bypassPermissions 模式？
  acceptEdits 模式？
  │
  ▼
[层 1：精确/前缀规则匹配 — deny/ask 优先]
  文件：bashPermissions.ts → bashToolCheckExactMatchPermission()
  ├── 查 alwaysDenyRules：匹配 → 直接 deny（用户明确禁止的命令）
  ├── 查 alwaysAskRules：匹配 → ask（用户要求每次确认）
  └── 查 alwaysAllowRules：匹配 → 暂存，继续往下做 path 检查
  │
  ▼
[层 2：AST 静态安全分析]
  文件：ast.ts → parseForSecurity() → parseForSecurityFromAst()
  旧路径：bashSecurity.ts → bashCommandIsSafe_DEPRECATED()（tree-sitter 不可用时）
  ├── Pre-checks（字符级）：控制字符、Unicode 空白、反斜杠空格、Zsh 语法
  ├── tree-sitter 解析 bash AST（50ms 超时，50,000 节点预算）
  ├── FAIL-CLOSED 遍历：未知节点类型 → too-complex → ask
  ├── 危险节点：command_substitution/brace_expression/expansion 等 → too-complex
  ├── 变量作用域跟踪：检测 VAR="-rf /" && rm $VAR 模式
  └── 结果：
      ├── simple（含各子命令的 argv[] 和 redirects）→ 继续
      ├── too-complex → ask（需用户确认）
      └── parse-unavailable → 降级到 regex 路径
  │
  ▼  (too-complex 时也走 regex 路径作为 fallback)
[层 2b：正则补充安全检查 bashSecurity.ts]
  检测 23 类 pattern（obfuscated flags、IFS injection、proc environ、
  mid-word hash、comment quote desync、brace expansion 等）
  → 任一命中 → behavior='ask'，部分标记 isBashSecurityCheckForMisparsing=true
  │
  ▼
[层 3：路径约束检查]
  文件：pathValidation.ts → checkPathConstraints()
  ├── 提取命令中所有文件路径参数
  ├── pathInAllowedWorkingPath()：是否在工作目录范围内
  │     ├── 原始路径 + symlink 解析路径双重检查
  │     └── containsPathTraversal() 阻断 ../.. 逃逸
  ├── checkPathSafetyForAutoEdit()：危险文件（.bashrc/.gitconfig/.claude/）
  └── hasSuspiciousWindowsPathPattern()：NTFS ADS、UNC 路径等
  │
  ▼
[层 4：只读模式检查（acceptEdits 模式激活时）]
  文件：readOnlyValidation.ts → checkReadOnlyConstraints()
  ├── 无输出重定向（> >> &>）
  ├── base command 在 COMMAND_ALLOWLIST 中
  ├── 所有 flag 在 safeFlags 白名单中
  └── additionalCommandIsDangerousCallback() 额外验证
  │
  ▼
[层 5：沙箱（可选，macOS/Linux）]
  文件：sandbox-adapter.ts
  ├── macOS：Sandbox.app（Apple 沙箱，读写限制）
  ├── Linux：firejail / seccomp
  └── 沙箱内仍保留 deny 规则检查（sandbox auto-allow 场景）
  │
  ▼
执行命令
```

---

## 三、模式卡片

### 模式卡片 #6：多层防御安全模型

**问题**：如何保证 LLM 生成的 bash 命令不破坏用户系统？

**方案**：五层递进式防御，每层职责单一且互相补充：

**层 1 — 声明式规则匹配**（`bashPermissions.ts`，函数 `matchingRulesForInput`）
- 用户在 `settings.json` 中声明 `alwaysDeny`/`alwaysAsk`/`alwaysAllow` 规则
- Deny 规则优先，防止任何包装技巧绕过（`nohup FOO=bar timeout 5 claude` 也能被 `Bash(claude:*)` deny 规则拦截）

**层 2 — AST 静态分析**（`ast.ts`，函数 `parseForSecurity`）
- 用 tree-sitter 解析 bash AST，提取每条子命令的 argv[]
- FAIL-CLOSED 设计：未识别节点 = 拒绝分析 = 要求用户确认
- 超时保护（50ms）和节点数限制（50,000），防止 DoS

**层 3 — 语义危险检测**（`bashSecurity.ts`，函数 `bashCommandIsSafe_DEPRECATED`）
- 23 类 pattern 检查，覆盖 parser differential、obfuscation、Zsh 特有攻击
- 对已由 AST 分析的命令可跳过（`!astParseSucceeded` 条件门控）

**层 4 — 路径约束**（`pathValidation.ts` + `filesystem.ts`）
- 路径白名单（工作目录）+ 黑名单（`.bashrc`、`.gitconfig` 等敏感文件）
- `pathInWorkingPath()` 用相对路径计算防止 `../..` 逃逸
- symlink 双路径检查防止间接逃逸

**层 5 — OS 沙箱**（`sandbox-adapter.ts`）
- macOS Sandbox / Linux firejail，OS 级别的系统调用拦截
- 软限制（deny 规则仍然生效）

**关键洞察：为什么字符串匹配不够，必须用 AST？**

bash 的语法极其复杂，存在大量"解析差异"：
- Brace 展开：`{--exec="evil",safe}` 正则看到一个词，bash 看到两个
- 变量 word-split：`VAR="-rf /"` 加上 `rm $VAR`，正则看到无害的 `$VAR`，bash 执行 `-rf /`
- ANSI-C 字符串：`$'\x65\x76\x69\x6c'` 正则无法解码，bash 展开为 `evil`
- Zsh `=cmd` 展开：`=curl evil.com` 正则看到以 `=` 开头的词，bash 执行 `/usr/bin/curl`

AST 分析通过 FAIL-CLOSED 原则解决这些问题：遇到任何语法上的不确定性，宁可要求用户确认，也不假设命令安全。

**适用条件**：
- LLM 生成代码/命令的 Agent 系统
- 用户可能不具备判断每条命令是否安全的能力
- 需要在安全性和可用性之间精确平衡（过度限制会降低效率）

**权衡**：
- AST 分析增加延迟（tree-sitter WASM 解析，有 50ms 超时）
- FAIL-CLOSED 导致一些复杂但安全的命令也需要用户确认（false positive）
- 沙箱会拦截一些合法的系统调用（如某些网络操作）
- 正则路径（deprecated）作为 fallback，存在被绕过的历史漏洞

---

### 模式卡片 #7：声明式权限规则引擎

**问题**：如何让用户可配置地控制工具权限，而不需要改代码？

**方案**：基于分层 settings 的规则引擎，`ToolPermissionContext` 作为运行时规则容器

**规则结构**：
```typescript
type PermissionRule = {
  source: PermissionRuleSource   // 规则来源（决定优先级和持久化位置）
  ruleBehavior: 'allow' | 'deny' | 'ask'
  ruleValue: { toolName: string; ruleContent?: string }
}
```

Bash 规则 `ruleContent` 语法（由 `shellRuleMatching.ts` 解析）：
- `git status` — 精确匹配
- `git commit:*` — 前缀匹配（git commit 加任意后缀）
- `npm run *` — 通配符模式

**分层 settings 体系**（优先级从高到低）：
```
policySettings（企业管控）
  > userSettings（~/.claude/settings.json，全局用户配置）
  > projectSettings（.claude/settings.json，项目级别）
  > localSettings（.claude/settings.local.json，本地不提交）
  > flagSettings（CLI 参数 --allow-bash）
  > session（用户在会话中点"不再询问"）
```

**关键设计决策：规则优先级**

```
deny > ask > allow，精确匹配 > 前缀/通配符
```

原因：
- Deny 优先保证了安全底线——用户明确禁止的命令永远不执行
- Ask 优先于 Allow 提供了"强制审查"的逃生通道
- 精确匹配优先于前缀避免了宽泛规则意外覆盖精确规则

**Deny 规则的特殊处理**：匹配时使用 `stripAllLeadingEnvVars`（不只剥离安全白名单中的 env var），防止 `FOO=bar denied_cmd` 绕过 `Bash(denied_cmd:*)` 的 deny 规则。Allow 规则只剥离安全 env var，防止 `DOCKER_HOST=evil docker ps` 自动匹配 `Bash(docker ps:*)` 规则。

**规则建议机制**：当命令需要用户确认时，系统自动建议合适粒度的规则：
- 稳定前缀（`git commit:*`）优于精确命令（每次参数不同的命令无法精确再匹配）
- Heredoc 命令 → 取 heredoc 前的命令前缀作为规则
- 多行命令 → 取第一行作为前缀规则
- Shell 解释器（`bash`、`zsh`、`sudo` 等）→ 不建议 `Bash(bash:*)` 这类过于宽泛的规则

**适用条件**：
- 用户需要精细控制 AI 工具权限（既不想每次都问，也不想完全信任）
- 不同项目需要不同权限配置
- 企业环境需要统一策略管控

**权衡**：
- 规则越细越安全，但用户配置成本高
- 前缀规则复用性强，但可能意外允许危险命令（`Bash(git:*)` 允许所有 git 操作）
- session 临时规则使用方便，但无法持久化——重启后需重新确认
- deny 规则的激进 env-var 剥离可能造成意外拦截（`ANT_ENV=prod denied_cmd` 也被拦截）

---

## 四、关键文件索引

| 文件 | 职责 | 核心函数 |
|------|------|---------|
| `/src/utils/bash/ast.ts` | AST 分析引擎，提取 argv[] | `parseForSecurity()`, `parseForSecurityFromAst()`, `walkProgram()` |
| `/src/utils/bash/bashParser.ts` | pure-TS bash 解析器，生成 tree-sitter 兼容 AST | `parseSource()`, `TsNode` |
| `/src/tools/BashTool/bashSecurity.ts` | 正则+字符级安全检查（deprecated 主路径的 fallback） | `bashCommandIsSafe_DEPRECATED()` |
| `/src/tools/BashTool/bashPermissions.ts` | 权限规则引擎，决策树主控 | `bashToolHasPermission()`, `checkCommandAndSuggestRules()`, `stripSafeWrappers()` |
| `/src/tools/BashTool/readOnlyValidation.ts` | 只读模式命令白名单验证 | `checkReadOnlyConstraints()`, `COMMAND_ALLOWLIST` |
| `/src/tools/BashTool/pathValidation.ts` | 路径约束检查 | `checkPathConstraints()` |
| `/src/utils/permissions/filesystem.ts` | 文件系统权限基础库 | `pathInWorkingPath()`, `pathInAllowedWorkingPath()`, `checkPathSafetyForAutoEdit()` |
| `/src/utils/permissions/PermissionResult.ts` | 权限结果类型定义 | `PermissionResult` |
| `/src/types/permissions.ts` | 核心权限类型（无循环依赖） | `PermissionRule`, `ToolPermissionContext`, `PermissionBehavior` |
| `/src/utils/shell/readOnlyCommandValidation.ts` | 只读命令及安全 flag 集合 | `GIT_READ_ONLY_COMMANDS`, `EXTERNAL_READONLY_COMMANDS`, `validateFlags()` |
| `/src/hooks/toolPermission/PermissionContext.ts` | 权限提示 UI 与审批流 | `handlePermissionRequest()` |
| `/src/utils/sandbox/sandbox-adapter.ts` | OS 沙箱适配层 | `SandboxManager` |

---

## 五、安全设计的深层 Insight

### 1. FAIL-CLOSED 而非 FAIL-OPEN

整个安全系统的设计哲学是 fail-closed：当无法分析时，宁可提示用户，不默认允许。体现在：
- AST 分析遇到未知节点 → `too-complex` → ask
- Parser 超时/节点过多 → `PARSE_ABORT` → too-complex（防止 DoS 攻击构造的恶意输入）
- 旧的 parse-unavailable 分支会复用 legacy 路径，但少了部分检查（`EVAL_LIKE_BUILTINS`），这被认为是安全缺陷并已修复

### 2. 分层防御的关键：各层独立，不能绕过

每层都有独立的检查目标：
- 规则引擎（层 1）检查用户意图
- AST 分析（层 2）检查结构性欺骗
- 正则检查（层 2b）检查字符串层面的混淆
- 路径检查（层 3）检查文件系统越界

它们相互补充：比如 `Bash(git:*)` allow 规则通过了层 1，但如果命令中包含 `--upload-pack=$(evil)` 会被层 2 的 `command_substitution` 检测拦截。

### 3. 解析差异（Parser Differential）是核心威胁模型

代码注释中反复出现的模式：
> 工具（tree-sitter/shell-quote）解析命令的方式 ≠ bash 实际执行命令的方式

这种差异可以被攻击者利用，让命令看起来安全但实际危险。防御思路是：
- 对所有可能产生差异的语法构造，选择保守（要求用户确认）
- 尽量减少依赖单一解析器，多路径交叉验证

### 4. 规则引擎的对称性设计

Allow 规则和 Deny 规则采用不同的 env-var 剥离策略，这不是 bug 而是精心设计：
- Allow 规则需要精确匹配，额外的 env var 应该让规则无法匹配（避免意外允许）
- Deny 规则需要广覆盖，任何包装都不应该让被禁命令溜过去

这种非对称设计体现了"allow 要谨慎，deny 要彻底"的安全原则。
