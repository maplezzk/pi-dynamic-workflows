---
title: feat: Workflow 底层切换为 pi-interactive-subagents
type: feat
status: active
date: 2026-06-05
---

# feat: Workflow 底层切换为 pi-interactive-subagents

## Overview

将 `pi-dynamic-workflows` 的子 Agent 底层从**内存会话**（`createAgentSession` → `session.prompt()`）切换为 **pi-interactive-subagents**（`launchSubagent()` → `watchSubagent()`），使工作流中的每个 `agent()` 调用跑在独立 tmux pane + 独立 pi 进程中，获得真正的进程级隔离和可恢复性。

---

## Problem Frame

当前 `WorkflowAgent.run()` 通过 Pi 的 `createAgentSession` 在内存中创建子会话，子 Agent 与主 workflow 运行在同一 Node.js 进程内。这带来三个问题：

1. **无进程隔离** — 子 Agent 共享主进程，无法独立分配资源
2. **不可恢复** — 内存会话在 workflow 结束后即销毁，无法 resume 继续
3. **与 subagent 生态割裂** — pi-interactive-subagents 已提供成熟的 tmux pane 管理、状态监控、widget 展示、中断/恢复能力，但 workflow 没有利用

目标是将 WorkflowAgent 的会话管理委托给 pi-interactive-subagents，同时保持 workflow 脚本的编程模型不变（`await agent(...)` 仍然是同步 Promise）。

---

## Requirements Trace

- R1. `await agent(prompt, opts)` 在 workflow 沙箱中保持不变，仍返回子 Agent 的最终文本
- R2. `parallel()` 同时启动多个子 Agent 到独立 tmux pane，互不干扰
- R3. `signal` 取消能中断所有正在运行的子 Agent
- R4. 主 Agent 在 workflow 执行期间能看到子 Agent 状态（running/done/error）
- R5. 子 Agent 可以 resume（通过 session 文件路径）
- R6. 结构化输出降级为 prompt 约定（要求 JSON 输出），不再依赖 `structured_output` 工具

---

## Scope Boundaries

- 仅改动 `src/agent.ts`（核心）、`src/workflow.ts`（ctx 传递）、`extensions/workflow.ts`（ctx 注入）
- 不修改 workflow 脚本语法和 AST 解析逻辑
- 不修改 display.ts、structured-output.ts、测试文件
- 不改变 `parallel()`/`pipeline()` 的语义

### Deferred to Follow-Up Work

- 结构化输出的 TypeBox schema 验证恢复（可能通过 prompt 约定 + post-parse 验证）
- pi-interactive-subagents 内部 API（`launchSubagent`/`watchSubagent`）的稳定导出

---

## Context & Research

### Relevant Code and Patterns

| 文件 | 角色 |
|------|------|
| `src/agent.ts` | 当前 `WorkflowAgent` — 通过 `createAgentSession` 创建内存会话 |
| `src/workflow.ts` | `runWorkflow()` — vm 沙箱中调用 `agentRunner.run()`，注入全局函数 |
| `extensions/workflow.ts` | Pi 扩展入口 — `session_start` 时激活 workflow 工具 |
| `pi-interactive-subagents/pi-extension/subagents/index.ts` | `launchSubagent()` + `watchSubagent()` — 创建/等待子 Agent |

### 接口对比

| 维度 | 当前 (WorkflowAgent) | 目标 (interactive-subagents) |
|------|---------------------|------------------------------|
| 启动 | `createAgentSession()` 内存 | `launchSubagent(params, ctx)` → tmux pane |
| 等待 | `session.prompt()` 同步返回 | `watchSubagent(running, signal)` → Promise |
| 结果 | `lastAssistantText(messages)` | `SubagentResult.summary` |
| 取消 | `AbortSignal` → `session.abort()` | `AbortSignal` → `subagent_interrupt` |
| 结构化输出 | `structured_output` 工具 (TypeBox) | ❌ 不支持 — 需降级为 prompt 约定 JSON |

### External References

- pi-interactive-subagents 源码：`/Users/zzk/CliProject/PiExtensions/pi-interactive-subagents/pi-extension/subagents/index.ts`
- `launchSubagent()` — L1429+，接收 `SubagentParams` + `ctx`，返回 `RunningSubagent`
- `watchSubagent()` — L1400+，轮询 `pollForExit`，返回 `SubagentResult { summary, exitCode, elapsed }`

---

## Key Technical Decisions

- **保留 Promise 接口** — `agent()` 在 vm 沙箱中仍然是 `Promise<string>`，通过 `watchSubagent()` 的轮询 Promise 自然兼容
- **ctx 通过 options 传递** — `WorkflowRunOptions` 新增 `ctx` 字段，从 `extensions/workflow.ts` → `runWorkflow()` → `agentRunner.run()`
- **结构化输出降级** — 不再注入 `structured_output` 工具，改为在 prompt 末尾追加 "输出纯 JSON，不要包含其他文字" 的约定
- **并发控制仍由 workflow 管理** — `parallel()` 的并发限制器仍在 `runWorkflow()` 中，不依赖 subagent 基础设施
- **不修改 workflow 脚本语法** — AST 解析、确定性验证、沙箱全局注入全部不变

---

## Open Questions

### Resolved During Planning

- `launchSubagent`/`watchSubagent` 是内部函数不导出：**从 pi-interactive-subagents 导入或复制必要代码**
- ctx 如何获取：**在 `session_start` 时捕获 ExtensionContext，存为模块变量，注入到 `runWorkflow` options**

### Deferred to Implementation

- 结构化输出 Schema 验证的恢复方案：待实现后根据实际体验决定
- 子 Agent 失败时的重试策略：当前 workflow 已有 `return null` 机制，暂不增强

---

## Implementation Units

- [ ] U1. **新增 InteractiveSubagentWorkflowAgent 类**

**Goal:** 替代现有 `WorkflowAgent`，用 `launchSubagent` + `watchSubagent` 管理子 Agent 生命周期

**Requirements:** R1, R2, R3, R5

**Dependencies:** None

**Files:**
- Modify: `src/agent.ts`

**Approach:**
- 新建类（或替换 `WorkflowAgent`），构造函数接收 `WorkflowAgentOptions` + `ctx`
- `run(prompt, options)` 内部调用 `launchSubagent()` 启动子 Agent，再 `await watchSubagent()` 等待完成
- 从 `SubagentResult.summary` 提取文本返回
- 通过 `options.signal` 传递 AbortSignal 给 `watchSubagent`
- 结构化输出：如果 options.schema 存在，在 prompt 末尾追加 JSON 输出约定，返回时尝试 `JSON.parse`

**Patterns to follow:**
- 现有 `WorkflowAgent` 的接口设计（保持兼容）
- `pi-interactive-subagents` 中 `subagent` 工具 execute() 的 launch + watch 模式

**Test scenarios:**
- Happy path: `agent("echo hello")` → 启动子 Agent → 返回摘要文本
- Parallel: `parallel([() => agent("a"), () => agent("b")])` → 两个子 Agent 并发启动在不同 pane
- Abort: 传入已 abort 的 signal → `run()` 抛出或返回 null
- 结构化输出降级: 传 `schema` → prompt 包含 JSON 约定 → 结果被 JSON.parse

**Verification:**
- 现有测试套件 `npm run test:unit` 全部通过
- 新增一个集成测试：用 workflow 脚本调用 `agent()`，验证子 Agent 实际在后台进程中运行

---

- [ ] U2. **WorkflowRunOptions 新增 ctx 字段**

**Goal:** 让 `runWorkflow` 能接收并传递 ExtensionContext 给 agent runner

**Requirements:** R4

**Dependencies:** None

**Files:**
- Modify: `src/workflow.ts`

**Approach:**
- 在 `WorkflowRunOptions` 接口新增 `ctx?: ExtensionContext` 字段
- `runWorkflow` 中将 `options.ctx` 透传给 `agentRunner` 构造（如果 agentRunner 需要）

**Patterns to follow:**
- 现有 `WorkflowRunOptions extends WorkflowAgentOptions` 的模式

**Test scenarios:**
- 无 ctx 传入时 → 行为不变（向后兼容）

**Verification:**
- TypeScript 编译通过
- 现有测试不受影响

---

- [ ] U3. **extensions/workflow.ts 捕获并注入 ctx**

**Goal:** 在 `session_start` 时捕获 ExtensionContext，传递给 `createWorkflowTool`

**Requirements:** R4

**Dependencies:** U2

**Files:**
- Modify: `extensions/workflow.ts`

**Approach:**
- 模块级变量 `let sessionCtx: ExtensionContext | null = null`
- `session_start` 时赋值
- `createWorkflowTool` 的 execute 中从 sessionCtx 取值注入 `runWorkflow` options

**Patterns to follow:**
- pi-interactive-subagents 中 `latestCtx` 的同类模式

**Test scenarios:**
- workflow 工具调用 → 子 Agent 启动 → widget 显示状态

**Verification:**
- 在 Pi 中实际运行 workflow 工具，观察子 Agent 状态

---

- [ ] U4. **添加 pi-interactive-subagents 依赖 & 清理旧代码**

**Goal:** 正式声明依赖，移除不再需要的代码

**Requirements:** R6

**Dependencies:** U1

**Files:**
- Modify: `package.json`
- Modify: `src/agent.ts` (移除旧的 `createAgentSession` 导入)
- Modify: `src/structured-output.ts` (保留但标记为 deprecated，后续版本移除)

**Approach:**
- `package.json` 新增 `pi-interactive-subagents` 为 dependency（本地路径或 npm）
- 移除 `WorkflowAgent` 中对 `createAgentSession`、`SessionManager`、`SettingsManager` 的导入
- `createStructuredOutputTool` 函数保留不删，但 export 中标记 `@deprecated`

**Verification:**
- `npm run build` 通过
- `npm run test:unit` 通过

---

- [ ] U5. **端到端集成测试**

**Goal:** 在 Pi 中实际运行 workflow 验证完整链路

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** U1, U2, U3, U4

**Files:**
- Test: 无新增文件（手动验证）

**Approach:**
- 在 Pi 中运行 workflow 工具，执行包含 serial + parallel agent 的脚本
- 验证子 Agent 在独立 tmux pane 中运行
- 验证 workflow 结果正确聚合
- 验证 `Esc` 取消能中断所有子 Agent

**Test scenarios:**
- 串行: `phase("A") → agent("a") → phase("B") → agent("b")` → 两个子 Agent 依次启动
- 并行: `parallel([agent("a"), agent("b")])` → 两个 pane 同时出现
- 取消: workflow 运行中 `Esc` → 所有 running agent 变为 skipped

**Verification:**
- 子 Agent 显示在 subagent 状态 widget 中
- workflow 结果与旧实现一致
- session 文件路径在结果中可见（可 resume）

---

## System-Wide Impact

- **Interaction graph:** workflow 工具不再是纯内存操作，会创建 tmux pane + 子进程。依赖 tmux 环境可用
- **Error propagation:** 子 Agent 进程崩溃通过 `SubagentResult.exitCode` 透传，workflow 沙箱中以 `null` 返回
- **State lifecycle risks:** 如果 workflow 被提前终止，已启动的子 Agent 可能成为孤儿进程。需要在 AbortSignal 处理中调用 `subagent_interrupt` 或清理 pane
- **Unchanged invariants:** workflow 脚本语法、AST 解析、确定性验证、显示渲染全部不变

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `launchSubagent`/`watchSubagent` 是私有 API，随版本变化 | 在 `package.json` 中锁定 pi-interactive-subagents 版本；或直接内联相关代码 |
| 子 Agent 成为孤儿进程（workflow 提前终止） | U1 中 AbortSignal 处理必须调用 `subagent_interrupt` 或关闭 pane |
| 结构化输出丧失 TypeBox 类型安全 | 降级为 prompt 约定 JSON + 实现侧 try-catch JSON.parse，后续版本恢复 |
| tmux 不可用时 workflow 无法工作 | `extensions/workflow.ts` 启动时检查环境，无 tmux 时降级为旧实现或报错 |

---

## Sources & References

- pi-dynamic-workflows: `/Users/zzk/CliProject/PiExtensions/pi-dynamic-workflows/`
- pi-interactive-subagents: `/Users/zzk/CliProject/PiExtensions/pi-interactive-subagents/pi-extension/subagents/index.ts`
- 技术评估: 2026-06-05 对话中完成的接口对比和 subagent 验证

---

## 任务分配策略

### 依赖与冲突判断

- **U1 与 U2 无冲突** — U1 修改 `src/agent.ts`，U2 修改 `src/workflow.ts`，不同文件
- **U3 依赖 U2** — U3 需要 `WorkflowRunOptions` 有 `ctx` 字段
- **U4 依赖 U1** — U4 移除旧代码需要 U1 的新实现就绪
- **U5 依赖 U1+U2+U3+U4** — 端到端测试需要全部改动完成

### 推荐执行批次

**批次 1（可并行）**
- subagent 1：U1 — 新增 InteractiveSubagentWorkflowAgent 类（修改 `src/agent.ts`）
- subagent 2：U2 — WorkflowRunOptions 新增 ctx 字段（修改 `src/workflow.ts`）

**批次 2（串行，依赖批次 1）**
- subagent 3：U3 — extensions/workflow.ts 捕获并注入 ctx（依赖 U2）

**批次 3（串行，依赖批次 1）**
- subagent 4：U4 — 添加依赖 & 清理旧代码（依赖 U1）

**批次 4（端到端，依赖批次 1+2+3）**
- 主 agent 协调：
  1. 汇总所有变更
  2. 检查导入冲突（U1 移除的 imports 是否被 U2/U3 引用）
  3. 统一执行 `npm run build`
  4. 统一执行 `npm run test:unit`
- subagent 5：U5 — 端到端集成测试（手动验证）

### subagent 限制

- subagent 只负责实现、阅读、分析、局部修改或产出建议
- subagent **禁止执行编译**（`npm run build`、`tsc` 等）
- subagent **禁止执行测试**（`npm test`、`npm run test:unit` 等）
- subagent **禁止执行提交或推送**（`git commit`、`git push` 等）
- 编译、测试、提交统一由主 agent 在批次协调点执行
