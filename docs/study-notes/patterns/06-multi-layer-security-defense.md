# 模式卡片 #6：多层防御安全模型

**来源子系统**：安全与沙箱（Security）
**Claude Code 关键文件**：`src/tools/BashTool/bashPermissions.ts`，`src/utils/bash/ast.ts`，`src/utils/sandbox/sandbox-adapter.ts`

---

## 问题

如何保证 LLM 生成的 bash 命令不破坏用户系统？单一安全检查容易被绕过，如何构建纵深防御？

## 方案

五层递进式防御，每层职责单一且互相补充：

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

## 关键设计决策

**为什么字符串匹配不够，必须用 AST？**

bash 存在大量"解析差异"（Parser Differential）——工具解析命令的方式 ≠ bash 实际执行命令的方式：

- **Brace 展开**：`{--exec="evil",safe}` 正则看到一个词，bash 看到两个
- **变量 word-split**：`VAR="-rf /"` 加上 `rm $VAR`，正则看到无害的 `$VAR`，bash 执行 `-rf /`
- **ANSI-C 字符串**：`$'\x65\x76\x69\x6c'` 正则无法解码，bash 展开为 `evil`
- **Zsh `=cmd` 展开**：`=curl evil.com` 正则看到以 `=` 开头的词，bash 执行 `/usr/bin/curl`

AST 分析通过 FAIL-CLOSED 原则解决这些问题：遇到任何语法上的不确定性，宁可要求用户确认，也不假设命令安全。

**各层独立，不能绕过**：层与层之间相互补充——`Bash(git:*)` allow 规则通过了层 1，但如果命令中包含 `--upload-pack=$(evil)` 会被层 2 的 `command_substitution` 检测拦截。

## 适用条件

- LLM 生成代码/命令的 Agent 系统
- 用户可能不具备判断每条命令是否安全的能力
- 需要在安全性和可用性之间精确平衡（过度限制会降低效率）

## 权衡

**优点：**
- 纵深防御，单层被绕过不代表整体失守
- FAIL-CLOSED 原则，不确定时宁可询问
- 各层职责清晰，可以独立升级和测试

**缺点/局限：**
- AST 分析增加延迟（tree-sitter WASM 解析，有 50ms 超时）
- FAIL-CLOSED 导致一些复杂但安全的命令也需要用户确认（false positive）
- 沙箱会拦截一些合法的系统调用（如某些网络操作）
- 正则路径（deprecated）作为 fallback，存在被绕过的历史漏洞

---

## 在自己项目中的应用思考

**这个问题在我的项目中存在吗？**
（待填写）

**可以直接用吗？还是需要简化/调整？**
（待填写）

**可以省略的复杂度：**
（待填写）
