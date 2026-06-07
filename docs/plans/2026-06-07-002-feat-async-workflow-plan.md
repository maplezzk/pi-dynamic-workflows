---
title: "feat: Workflow 工具异步化 — fire-and-forget + steer 通知"
type: feat
status: active
date: 2026-06-07
---

# feat: Workflow 工具异步化 — fire-and-forget + steer 通知

## Overview

将 workflow 工具从同步阻塞模式改为异步 fire-and-forget 模式：工具立即返回"已启动"确认，后台继续执行 workflow 脚本，完成时通过 steer 消息唤醒主 agent 并渲染最终结果。执行期间 Widget 持续显示实时进度。

---

## Problem Frame

当前 workflow 工具是同步执行的：主 agent 调用 workflow 后，工具 handler 阻塞直到所有子 agent 执行完毕才返回。这导致：

1. **日志刷屏**：子 agent 的大量日志输出会干扰 workflow 工具调用的渲染
2. **对话流阻塞**：workflow 执行期间主 agent 无法处理其他请求
3. **用户感知差**：长时间执行时用户看到的只有 "Working..." 和偶尔的日志输出

期望行为：workflow 工具像 subagent 一样——调用后立即返回，后台异步执行，Widget 实时显示进度，完成后通过 steer 消息通知主 agent。

---

## Requirements Trace

- R1. workflow 工具调用后立即返回"已启动"确认，不阻塞主 agent
- R2. 后台异步执行 workflow 脚本（解析、agent 调度、结果收集）
- R3. Widget 在工具返回后继续存活，实时显示进度（每秒刷新）
- R4. 执行完成后通过 `pi.sendMessage` + `deliverAs: "steer"` 唤醒主 agent
- R5. 完成消息使用 `registerMessageRenderer` 自定义渲染（themed 结果视图）
- R6. 支持中断/取消（用户 ESC 或主 agent 中断）
- R7. 通过环境变量 `PI_WORKFLOW_ASYNC=true` 启用异步模式，默认保持同步（向后兼容）
- R8. 结果文件写入行为不变（`.pi/workflows/<name>-<timestamp>.json` + per-agent 文件）
- R9. 错误处理：执行失败时也通过 steer 消息通知，附带错误信息

---

## Scope Boundaries

- 不改变 workflow 脚本语法（`export const meta`、`phase()`、`agent()` 等）
- 不改变子 agent 的执行方式（SubagentWorkflowAgent / InMemoryWorkflowAgent 不受影响）
- 不改变结果文件格式
- 不修改 Widget 渲染逻辑（复用现有 `renderWorkflowWidgetLines`）

### Deferred to Follow-Up Work

- 多个 workflow 并行执行管理（当前一次只执行一个）
- workflow 执行历史查看/恢复工具

---

## Context & Research

### Relevant Code and Patterns

- `pi-interactive-subagents/pi-extension/subagents/index.ts`：subagent 异步模式的参考实现
  - 工具 handler 立即返回 `{ content, details }`
  - 独立 `AbortController` 管理后台任务生命周期
  - `watchSubagent().then()` 中通过 `pi.sendMessage({ triggerTurn: true, deliverAs: "steer" })` 推送结果
  - `registerMessageRenderer` 自定义 steer 消息渲染
- `pi-dynamic-workflows/src/workflow-tool.ts`：当前同步 workflow 工具
  - 9 阶段执行流程
  - Widget 通过 `setInterval(updateWidget, 1000)` 每秒刷新
  - `createToolUpdateWorkflowDisplay` 处理双重渲染（stream + widget）
- `pi-dynamic-workflows/src/display.ts`：渲染逻辑
  - `renderWorkflowWidgetLines`：Widget 内容生成
  - `renderWorkflowThemed`：最终结果 themed 渲染

### 关键 API

```typescript
// 异步结果推送
pi.sendMessage(
  { customType: "workflow_result", content: summary, display: true, details: snapshot },
  { triggerTurn: true, deliverAs: "steer" }
);

// 自定义消息渲染
pi.registerMessageRenderer("workflow_result", (message, options, theme) => {
  // 使用 renderWorkflowThemed 渲染
});

// Widget 工具返回后继续存活（subagent 已验证此模式）
ctx.ui.setWidget("workflow-status", (_tui, _theme) => ({
  invalidate() {},
  render(width) { return renderWorkflowWidgetLines(snapshot, width); }
}), { placement: "aboveEditor" });
```

---

## Key Technical Decisions

- **环境变量切换**：`PI_WORKFLOW_ASYNC=true` 启用异步模式。理由：向后兼容，用户可选择同步模式用于调试或特殊场景
- **独立 AbortController**：工具返回后原始 `signal` 失效，后台任务需自己的 AbortController。理由：同 subagent 模式
- **sendMessage 而非 sendUserMessage**：使用 `pi.sendMessage` + `registerMessageRenderer` 自定义渲染。理由：可控制渲染格式，避免纯文本输出
- **Widget 在工具返回后保留**：setWidget 创建后不随工具 handler 返回而销毁（Pi 框架行为）。理由：subagent 已验证此模式可行
- **清理时机**：Widget 在 steer 消息发送前清除。理由：steer 消息的 renderResult 会替代 Widget 显示最终结果

---

## Open Questions

### Resolved During Planning

- **Q: Widget 在工具返回后是否存活？** → 是，Pi 框架不会在工具 handler 返回时自动清除 Widget（subagent 已验证）
- **Q: steer 消息能否自定义渲染？** → 能，通过 `registerMessageRenderer` 注册自定义类型渲染器
- **Q: 多次调用 workflow 如何处理？** → 当前简单方案：如果已有 workflow 在运行，拒绝新的调用（返回错误）

### Deferred to Implementation

- 精确的中断信号传递路径（需要测试 AbortController 在 VM 沙箱内的行为）
- steer 消息在 agent context 中的精确格式（需要测试 agent 对 custom message 的反应）

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
同步模式（当前/默认）：
┌─────────────────────────────────────────┐
│  workflow tool execute()                │
│  ┌─ parse → init → run → result ─┐     │
│  │  (阻塞直到所有 agent 完成)      │     │
│  └──────────────────────────────────┘    │
│  return { content, details }             │
└──────────────────────────────────────────┘

异步模式（PI_WORKFLOW_ASYNC=true）：
┌─────────────────────────────────────────┐
│  workflow tool execute()                │
│  1. parse script (同步，快速)            │
│  2. init snapshot + widget              │
│  3. start background execution          │  ← fire-and-forget
│  4. return { content: "已启动" }         │  ← 立即返回
└──────────────────────────────────────────┘
         ↓ (后台 Promise 链)
┌─────────────────────────────────────────┐
│  Background execution                   │
│  - runWorkflow() with own AbortCtrl     │
│  - Widget 每秒刷新（setInterval）       │
│  - 完成/失败 → clearWidget              │
│  - pi.sendMessage("workflow_result")     │  ← steer 唤醒 agent
└──────────────────────────────────────────┘
         ↓ (agent 新 turn)
┌─────────────────────────────────────────┐
│  registerMessageRenderer                │
│  - renderWorkflowThemed(snapshot)       │
│  - 显示结果文件路径                      │
└──────────────────────────────────────────┘
```

---

## Implementation Units

- [ ] U1. **异步执行核心逻辑**

**Goal:** 在 `workflow-tool.ts` 中实现异步模式的 fire-and-forget 执行路径

**Requirements:** R1, R2, R7

**Dependencies:** None

**Files:**
- Modify: `src/workflow-tool.ts`
- Modify: `extensions/workflow.ts`

**Approach:**
- 在 `createWorkflowTool` 的 execute handler 中，检测 `PI_WORKFLOW_ASYNC` 环境变量
- 异步模式下：完成脚本解析和 snapshot 初始化后，将 `runWorkflow` + 后续逻辑放入独立 Promise 链（不 await）
- 创建独立 `AbortController` 管理后台任务生命周期
- 维护一个模块级 `runningWorkflow` 状态，防止重复调用
- 立即返回 `{ content: "Workflow {name} 已启动...", details: { name, status: "running" } }`

**Patterns to follow:**
- `pi-interactive-subagents/pi-extension/subagents/index.ts` 第 1460-1530 行的 fire-and-forget 模式

**Test scenarios:**
- Happy path: 异步模式下 execute() 立即返回 "已启动" 确认，不等待 workflow 完成
- Happy path: 同步模式下行为不变（env var 未设置时走原有路径）
- Edge case: 已有 workflow 在运行时拒绝新调用
- Error path: 脚本解析失败时同步抛错（解析阶段仍是同步的）

**Verification:**
- 异步模式下工具 handler 在毫秒级返回
- 同步模式下行为完全不变

---

- [ ] U2. **Widget 跨工具生命周期管理**

**Goal:** 确保 Widget 在工具返回后继续存活并持续刷新，直到 workflow 完成

**Requirements:** R3

**Dependencies:** U1

**Files:**
- Modify: `src/workflow-tool.ts`

**Approach:**
- 异步模式下，Widget 初始化和 setInterval 逻辑与同步模式相同
- 工具返回后 Widget 和定时器继续运行（Pi 框架不会自动清除）
- 后台执行完成时：先 clearInterval，再 clearWidget，最后发 steer 消息
- 中断时同样先清 Widget 再通知

**Patterns to follow:**
- subagent 的 Widget 跨工具生命周期管理
- 当前 `renderWorkflowWidgetLines` 函数直接复用

**Test scenarios:**
- Happy path: Widget 在工具返回后继续显示进度
- Happy path: workflow 完成后 Widget 正确清除
- Error path: workflow 异常时 Widget 也被清除（不泄漏）
- Edge case: 中断时 Widget 立即清除

**Verification:**
- 工具返回后 Widget 仍可见
- workflow 完成/失败后 Widget 消失

---

- [ ] U3. **Steer 消息推送与自定义渲染**

**Goal:** workflow 完成后通过 steer 消息唤醒主 agent，并使用自定义渲染器显示结果

**Requirements:** R4, R5, R9

**Dependencies:** U1

**Files:**
- Modify: `src/workflow-tool.ts`
- Modify: `extensions/workflow.ts`

**Approach:**
- 后台 Promise 链的 `.then()` 中：
  - 计算最终 snapshot + 写入结果文件
  - 调用 `pi.sendMessage({ customType: "workflow_result", content, display: true, details }, { triggerTurn: true, deliverAs: "steer" })`
- `.catch()` 中：
  - 同样推送 steer 消息，content 含错误信息
- 在扩展初始化时注册 `pi.registerMessageRenderer("workflow_result", renderer)`
- renderer 复用 `renderWorkflowThemed` + 结果文件路径显示

**Patterns to follow:**
- `pi-interactive-subagents` 的 `subagent_result` 消息类型和渲染器
- 当前 `renderWorkflowThemed` 函数

**Test scenarios:**
- Happy path: workflow 成功完成后主 agent 收到 steer 消息并被唤醒
- Happy path: steer 消息使用自定义渲染器显示 themed 结果
- Error path: workflow 失败时 steer 消息包含错误信息
- Integration: steer 消息的 details 中包含完整 snapshot + resultFile 路径

**Verification:**
- 主 agent 在 workflow 完成后被唤醒并开始新 turn
- 渲染结果与同步模式的 renderResult 视觉一致

---

- [ ] U4. **中断与取消支持**

**Goal:** 支持用户在 workflow 异步执行期间中断/取消

**Requirements:** R6

**Dependencies:** U1, U2

**Files:**
- Modify: `src/workflow-tool.ts`
- Modify: `extensions/workflow.ts`

**Approach:**
- 维护模块级 `runningWorkflow` 对象，包含 `abortController`
- 在扩展中注册 `workflow_cancel` 工具（或在 session_shutdown 时自动取消）
- 取消时：调用 `abortController.abort()` → VM 内 `throwIfAborted()` 检测 → 标记 agents skipped → 清 Widget → 推送取消通知（steer）
- Pi 的 `session_shutdown` 事件中自动清理

**Patterns to follow:**
- subagent 的 `subagent_interrupt` 工具
- 当前 workflow 中断逻辑（`isAbortError` 检测 + agents 标记 skipped）

**Test scenarios:**
- Happy path: 用户取消后 workflow 停止执行
- Happy path: 取消后推送 steer 消息通知主 agent
- Edge case: 取消时正在执行的 agent 被正确标记为 skipped
- Edge case: 没有正在运行的 workflow 时取消工具返回提示

**Verification:**
- 取消后 Widget 消失
- 主 agent 收到取消通知

---

- [ ] U5. **集成测试与验证**

**Goal:** 端到端验证异步模式正常工作

**Requirements:** R1-R9

**Dependencies:** U1, U2, U3, U4

**Files:**
- Modify: `tests/workflow-tool.test.ts`

**Approach:**
- 添加异步模式测试：mock `pi.sendMessage`，验证工具立即返回 + 后续 sendMessage 被调用
- 验证同步模式行为不变
- 验证 Widget 清理逻辑
- 验证错误路径的 steer 消息

**Test scenarios:**
- Happy path: 异步模式工具立即返回，后台完成后 sendMessage 被调用
- Happy path: 同步模式行为完全不变
- Error path: 解析失败时同步报错
- Error path: 执行失败时推送错误 steer 消息
- Integration: 结果文件正确写入

**Verification:**
- 所有现有测试通过（同步模式无回归）
- 新增异步模式测试通过

---

## System-Wide Impact

- **Interaction graph:** workflow 工具返回后，Widget 和 setInterval 继续运行；完成时 sendMessage 触发新 turn
- **Error propagation:** 后台执行错误通过 steer 消息传递给主 agent，不会静默丢失
- **State lifecycle risks:** `runningWorkflow` 模块级状态需要在 session_shutdown 时正确清理
- **API surface parity:** 同步模式完全不变，异步模式是新增路径
- **Unchanged invariants:** workflow 脚本语法、子 agent 执行方式、结果文件格式均不变

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Widget 在工具返回后可能行为异常 | subagent 已验证此模式可行；实现时先做最小验证 |
| AbortController 在 VM 沙箱内传递问题 | 当前同步模式已使用 signal 传递，异步只是换成独立的 controller |
| sendMessage steer 消息格式 agent 无法识别 | 使用 display:true 确保消息可见；content 包含摘要文本 |
| 多次调用竞态 | 简单互斥：已有 workflow 运行时拒绝新调用 |

---

## 任务分配策略

### 依赖与冲突判断

- U1 是核心基础，U2/U3/U4 都依赖它
- U2（Widget 管理）和 U3（steer 推送）无冲突，都在 `workflow-tool.ts` 中但修改不同代码段
- U4（中断支持）依赖 U1 和 U2（需要 `runningWorkflow` 状态和 Widget 清理逻辑）
- U5（测试）依赖所有前序任务

### 推荐执行批次

1. 批次 1（串行）
   - subagent 1：U1 — 异步执行核心逻辑
2. 主 agent 协调点
   - 编译验证
   - 确认基础架构正确
3. 批次 2（可并行）
   - subagent 2：U2 — Widget 生命周期管理
   - subagent 3：U3 — steer 消息推送与渲染器
4. 主 agent 协调点
   - 汇总变更（U2/U3 修改同文件不同段，需 merge）
   - 统一编译测试
5. 批次 3（串行）
   - subagent 4：U4 — 中断与取消支持
6. 主 agent 协调点
   - 编译测试
7. 批次 4（串行）
   - subagent 5：U5 — 集成测试
8. 主 agent 最终协调
   - 全量测试
   - 端到端手动验证
   - 提交

### subagent 限制

- subagent 只负责实现、阅读、分析、局部修改或产出建议
- subagent 禁止执行编译、测试、提交等操作
- 编译、测试、提交统一由主 agent 执行
