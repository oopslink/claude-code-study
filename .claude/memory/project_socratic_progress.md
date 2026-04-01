---
name: Socratic study progress
description: Progress tracking for Socratic-method deep dive into Claude Code source - completed security, agent loop; context management in progress; next multi-agent, plugins
type: project
---

Socratic study series on Claude Code source code is underway.

**Completed (2026-04-01 session 1):**
- Security system five-layer defense model (static tool classification, Bash AST, permission rules, user confirmation, OS sandbox)
- Deep dive into readOnly validation (flag-level allowlist, xargs -i vulnerability, git hooks attack vectors)
- Agent loop state machine (AsyncGenerator, 11+ exit reasons, transition vs return)
- Tool concurrency control (isConcurrencySafe, dynamic per-invocation judgment)

**In progress (2026-04-01 session 2):**
- Context management and compression — just started, first Socratic question posed (how does infinite conversation work with fixed context window)
- Key source files identified: compact.ts, autoCompact.ts, microCompact.ts, postCompactCleanup.ts, prompt.ts, sessionMemory.ts, tokens.ts

**Next topics:**
- Multi-agent architecture
- Plugin/skill system

**Why:** User prefers Socratic teaching method - asking questions to guide discovery rather than lecturing. Likes to go deep into implementation details rather than staying surface-level.

**How to apply:** Continue with Socratic dialog style in future sessions. When user says "深一些" (go deeper), follow the thread rather than switching topics. New notes go in `docs/study-notes/superpowers/` as `socratic-XX-*.md` and corresponding HTML in `site/`.
