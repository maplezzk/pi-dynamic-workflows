---
title: "feat: Workflow TUI 渲染优化 — 主题着色 + Widget 状态栏"
type: feat
status: active
date: 2026-06-07
---

# feat: Workflow TUI 渲染优化 — 主题着色 + Widget 状态栏

## Overview

重新设计 pi-dynamic-workflows 的终端 UI 渲染，参考 pi-interactive-subagents 的状态展示设计，实现：
1. `renderResult` 最终视图使用 theme 着色（颜色、图标、结构化布局）
2. 运行时使用 Widget API 在输入框上方显示实时进度状态栏
3. 流式 `onUpdate` 保持简洁但增加基本着色

---

## Problem Frame

当前 workflow 渲染是纯文本，没有颜色、没有视觉层次：
- 运行中和完成后的渲染都是同一套纯文本
- 无法一眼区分 running/done/error 状态
- 没有耗时信息
- 文件路径和 agent 名称没有视觉区分

pi-interactive-subagents 的状态栏设计（蓝色边框 + box-drawing + 实时耗时 + 状态标签）提供了很好的参考，但两者架构不同，不能直接照搬。

---

## Requirements Trace

- R1. renderResult 最终视图使用 theme 着色，具有清晰的视觉层次
- R2. 运行中通过 Widget（输入框上方）显示实时进度
- R3. agent 状态用颜色图标区分（running=accent, done=success, error=error）
- R4. 显示每个 agent 的耗时
- R5. 文件路径用 dim/muted 颜色降低视觉噪音
- R6. 保持向后兼容：content 文本给大 agent 看的内容不变

---

## Scope Boundaries

- 不实现可折叠/交互式 UI（workflow 工具结果是静态的，不支持 handleInput）
- 不修改 pi-tui 框架本身
- 不改变 workflow 运行逻辑，只改渲染层
- 不做动画/spinner（pi-tui 的 Text 不支持定时刷新，widget 通过 setInterval 实现）

---

## Context & Research

### 可用 pi-tui 组件

| 组件 | 能力 | 限制 |
|------|------|------|
| Text | 多行+自动换行+bgFn+paddingX/Y | 不支持子组件嵌套 |
| Box | 容器+bgFn+子组件垂直堆叠 | 无边框、无水平布局 |
| Container | 纯容器 | 无装饰 |
| Spacer | 空行 | — |

### Theme 颜色（已确认可用）

| 语义 | key | 用途 |
|------|-----|------|
| 标题 | `toolTitle` | workflow 名称、agent 名称 |
| 强调 | `accent` | 图标、进度指示 |
| 成功 | `success` | ✓ 完成状态 |
| 错误 | `error` | ✗ 失败状态 |
| 暗色 | `dim` | 耗时、次要信息 |
| 静音 | `muted` | 文件路径、更次要信息 |
| 输出 | `toolOutput` | agent 标签 |
| 背景-进行中 | `toolPendingBg` | 框架自动应用（isPartial=true） |
| 背景-成功 | `toolSuccessBg` | 框架自动应用（完成无错误） |
| 背景-错误 | `toolErrorBg` | 框架自动应用（完成有错误） |

### Widget API

```typescript
ctx.ui.setWidget(
  "workflow-status",
  (_tui, _theme) => ({
    invalidate() {},
    render(width: number): string[] { /* 返回行数组 */ }
  }),
  { placement: "aboveEditor" }
);
```

- 支持 `"aboveEditor"` 定位
- `render(width)` 返回 `string[]`，每行一个字符串
- 不经过 theme 系统，需要硬编码 ANSI 或使用 theme 对象（通过 factory 参数获取）

### Subagent Widget 视觉参考

```
╭─ Subagents ─────────────────── 2 running ─╮
│ 00:42  scout (reviewer)      active 12s   │
│ 01:15  worker              waiting 30s    │
╰───────────────────────────────────────────╯
```

### 现有 WorkflowAgentSnapshot 字段

```typescript
interface WorkflowAgentSnapshot {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: WorkflowAgentStatus; // "queued" | "running" | "done" | "error" | "skipped"
  resultPreview?: string;
  error?: string;
  startedAt?: number;   // ← 已有但未使用
  finishedAt?: number;  // ← 已有但未使用
}
```

---

## Key Technical Decisions

- **Widget + renderResult 双通道**：运行时用 Widget 实时刷新（1s 间隔），完成后 Widget 消失，renderResult 展示最终着色视图。理由：Widget 提供实时体验，renderResult 提供持久记录。
- **box-drawing 字符用于 Widget**：参考 subagent 的 `╭╮╰╯│─` 风格，给 workflow 状态栏加边框。理由：视觉一致性。
- **renderResult 不用边框**：使用 theme 着色 + 缩进层次即可，边框在对话流中显得多余（框架已加背景色）。理由：简洁。
- **耗时信息来源**：`startedAt`/`finishedAt` 字段已存在于接口但未填充，需要在 onAgentStart/onAgentEnd 中设置时间戳。理由：零成本获取。
- **ANSI 颜色获取**：Widget 的 render 函数中无法直接使用 theme（factory 参数是 `_tui, _theme`），但 `_theme` 实际可用。需确认 factory 签名是否传递 theme。如果不传，使用硬编码 ANSI（参考 subagent 做法）。

---

## Open Questions

### Resolved During Planning

- **Widget factory 是否接收 theme？** 是的，签名是 `(_tui, _theme) => ...`，subagent 代码中用硬编码 ANSI 是设计选择而非限制。
- **renderResult 中 isPartial 的影响？** 框架自动加 `toolPendingBg` 背景，不需要手动处理。

### Deferred to Implementation

- **Widget 刷新间隔**：1s 是否足够？参考 subagent 的 1s 间隔，应该没问题。
- **终端宽度适配**：box-drawing 宽度需要动态计算，实现时需测试窄终端。

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

### Widget 状态栏（运行中）

```
╭─ Workflow: dev_workflow_demo ────────── 3/10 done ─╮
│  ✓ 规划                                           │
│    #1 ✓ Tech Lead 制定计划                   12s  │
│  ▶ 并行实现                                       │
│    #2 ● 实现 string-utils                    8s  │
│    #3 ● 实现 array-utils                     6s  │
│  ○ Review                                         │
│  ○ 总结                                           │
╰───────────────────────────────────────────────────╯
```

图标语义：
- `✓` phase 完成（全部 agent done）
- `▶` phase 进行中（有 running agent）
- `○` phase 等待中（未开始）
- `●` agent 正在运行
- `✓` agent 已完成
- `✗` agent 失败

### renderResult 最终视图（完成后）

```
▸ dev_workflow_demo — 10 agents · 90s

  ✓ 规划                                        12s
    #1 ✓ Tech Lead 制定计划
         📄 .pi/workflows/.../01-Tech_Lead.json
  ✓ 并行实现                                    28s
    #2 ✓ 实现 string-utils
    #3 ✓ 实现 array-utils
  ✓ Review                                      15s
    #7 ✓ Code Review
  ✗ 修复                                        20s
    #8 ✓ 修复 string-utils.js
    #9 ✗ 修复 test.js — timeout
  ✓ 总结                                         5s
    #10 ✓ 最终总结

  📄 .pi/workflows/dev_workflow_demo-xxx.json
```

着色方案：
- `▸` → `theme.fg("accent")`
- workflow name → `theme.fg("toolTitle", theme.bold(...))`
- `✓` → `theme.fg("success")`
- `●` (running) → `theme.fg("accent")`
- `✗` → `theme.fg("error")`
- agent label → `theme.fg("toolOutput")`
- 耗时 → `theme.fg("dim")`
- 文件路径 → `theme.fg("muted")`
- phase name → `theme.fg("text")` (默认)

---

## Implementation Units

- [ ] U1. **填充 startedAt/finishedAt 时间戳**

**Goal:** 在 onAgentStart/onAgentEnd 回调中记录时间戳，为耗时显示提供数据源。

**Requirements:** R4

**Dependencies:** None

**Files:**
- Modify: `src/workflow-tool.ts`（onAgentStart 设置 `startedAt = Date.now()`，onAgentEnd 设置 `finishedAt = Date.now()`）

**Approach:**
- 在 `onAgentStart` 回调中 `snapshot.agents` push 时已有 status 字段，加 `startedAt: Date.now()`
- 在 `onAgentEnd` 回调中找到 agent 后加 `finishedAt: Date.now()`

**Patterns to follow:**
- 现有 `onAgentEnd` 回调中设置 `agent.status` 和 `agent.resultPreview` 的模式

**Test scenarios:**
- Happy path: agent 完成后 `finishedAt - startedAt` 返回合理的毫秒数
- Edge case: agent 失败时仍设置 `finishedAt`

**Verification:**
- 单元测试中检查 snapshot.agents[].startedAt/finishedAt 不为 undefined

---

- [ ] U2. **renderResult 主题着色**

**Goal:** 重写 `renderResult` 中的渲染逻辑，使用 theme API 着色。

**Requirements:** R1, R3, R4, R5, R6

**Dependencies:** U1

**Files:**
- Modify: `src/display.ts`（新增 `renderWorkflowThemed(snapshot, theme, options)` 函数）
- Modify: `src/workflow-tool.ts`（`renderResult` 调用新函数）

**Approach:**
- 新增 `renderWorkflowThemed(snapshot: WorkflowSnapshot, theme: Theme, completed: boolean, options: WorkflowDisplayOptions): string`
- 返回带 ANSI 着色的多行字符串
- renderResult 中：完成后调用 themed 版本，isPartial 时仍用纯文本版本（streaming 兼容）
- 保留现有 `renderWorkflowText` 供 onUpdate 流式通道使用（纯文本，给 content 用）

**Patterns to follow:**
- pi-interactive-subagents `renderResult` 中 `theme.fg("accent", "▸") + " " + theme.fg("toolTitle", theme.bold(name))` 的组合模式

**Test scenarios:**
- Happy path: 10 个 agent 全部完成，输出包含 ✓ 图标和绿色着色
- Error path: 有 agent 失败，输出包含 ✗ 图标和红色着色
- Edge case: 无 phase（Unphased）的 agent 正常显示

**Verification:**
- 渲染输出包含 ANSI 转义码
- 现有单元测试不受影响（它们测试纯文本版本）

---

- [ ] U3. **Widget 实时状态栏**

**Goal:** 在 workflow 运行期间，在输入框上方显示带边框的树状实时进度状态栏，按 phase 分组显示 agent 状态。

**Requirements:** R2, R3, R4

**Dependencies:** U1, U4

**Files:**
- Modify: `src/display.ts`（新增 `renderWorkflowWidgetLines(snapshot, width)` 函数）
- Modify: `src/workflow-tool.ts`（在 execute 中注册/更新/清除 widget）

**Approach:**
- 在 `execute` 开始时通过 `ctx.ui.setWidget("workflow-status", factory, { placement: "aboveEditor" })` 注册
- factory 的 render(width) 函数用 box-drawing 字符绘制边框 + 内部树状结构
- 树状结构层次：
  - 第一层：phase（`✓`/`▶`/`○` + phase 名称）
  - 第二层：agent（`#N ●`/`✓`/`✗` + label + 耗时）
- 标题行：`╭─ Workflow: {name} ────── {done}/{total} done ─╮`
- 只显示最近 N 个 phase（避免 widget 过高），已完成 phase 折叠为一行
- 每次 onAgentStart/onAgentEnd/onPhase 时触发 widget 重绘
- 使用 1s setInterval 刷新耗时数字
- workflow 完成/失败/abort 后清除 widget 和定时器
- 用 globalThis symbol key 存储定时器引用，防止 /reload 泄漏

**Patterns to follow:**
- pi-interactive-subagents `index.ts:587-636` 的 widget 注册 + box-drawing 渲染模式
- pi-interactive-subagents `index.ts:911-918` 的 setInterval 刷新 + /reload 防护模式

**Test scenarios:**
- Happy path: workflow 运行中 widget 显示树状结构，phase + agent 层次清晰
- Happy path: agent 完成后状态图标从 ● 变为 ✓，耗时固定
- Happy path: 新 phase 开始时 widget 显示 ▶ 标记
- Edge case: 无 phase（Unphased）时只显示 agent 列表
- Edge case: 多于 6 个 agent 时只显示最近的，前面折叠为 `… N earlier`
- Edge case: 终端宽度 < 50 列时标题行截断但不崩溃
- Error path: ctx.hasUI 为 false 时不注册 widget

**Verification:**
- Widget 在 workflow 启动时注册（通过 ctx.ui.setWidget 调用）
- Widget 在 workflow 结束时清除
- 定时器在清除时被 clearInterval
- 现有测试不受影响

---

- [ ] U4. **耗时格式化工具函数**

**Goal:** 提供统一的耗时格式化函数，供 Widget 和 renderResult 共用。

**Requirements:** R4

**Dependencies:** None

**Files:**
- Modify: `src/display.ts`（新增 `formatElapsed(ms: number): string` 函数）

**Approach:**
- `< 1000ms` → `<1s`
- `1s - 59s` → `Ns`
- `60s - 3599s` → `Nm Ns`
- `>= 3600s` → `Nh Nm`
- 参考 subagent 的 `formatElapsedDuration` 但更简洁

**Patterns to follow:**
- pi-interactive-subagents `status.ts:formatElapsedDuration`

**Test scenarios:**
- Happy path: 45000 → "45s"，125000 → "2m 5s"
- Edge case: 0 → "<1s"，负数 → "<1s"

**Verification:**
- 单元测试覆盖各种时间范围

---

- [ ] U5. **清理与集成测试**

**Goal:** 确保所有渲染路径正常工作，现有测试通过，biome 无报错。

**Requirements:** R6

**Dependencies:** U1, U2, U3, U4

**Files:**
- Modify: `tests/workflow-display.test.ts`（增加 themed 渲染测试）
- Run: `npm run build && npm run test:unit && npx biome check .`

**Approach:**
- 为 `renderWorkflowThemed` 新增测试（验证输出包含 ANSI 转义码）
- 为 `formatElapsed` 新增测试
- 确保 `renderWorkflowText`（纯文本版本）的现有测试不受影响
- 运行完整构建和 lint

**Test scenarios:**
- Happy path: 所有现有测试通过
- Happy path: 新增 themed 渲染测试通过
- Edge case: 无 theme 降级（如果 theme 未传入）

**Verification:**
- `npm run build` 无 TypeScript 错误
- `npm run test:unit` 全部通过
- `npx biome check .` 无报错

---

## System-Wide Impact

- **Interaction graph:** Widget 注册/清除需要 `ctx.ui` 访问，当前 `execute` 中已有 `ctx` 参数
- **Error propagation:** Widget 渲染失败不应阻断 workflow 执行（用 try/catch 保护）
- **State lifecycle risks:** Widget 的 setInterval 需要在 workflow 完成/abort 时清除，防止内存泄漏
- **API surface parity:** 不影响 workflow 工具的 content 输出（大 agent 看到的不变）
- **Unchanged invariants:** `renderWorkflowText`（纯文本版本）保持不变，流式 onUpdate 内容不变

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Widget API 在某些环境下不可用（`ctx.hasUI === false`） | Widget 逻辑有 `if (!ctx.hasUI) return` 守护 |
| setInterval 泄漏 | 用 globalThis symbol key 存储，/reload 时清除（参考 subagent） |
| 终端不支持 ANSI 着色 | theme API 内部处理降级，无需额外处理 |
| Box-drawing 字符在某些字体下错位 | 可接受风险，和 subagent 一致 |

---

## 任务分配策略

### 依赖与冲突判断

- U1（时间戳）和 U4（格式化函数）无依赖，可并行
- U2（renderResult 着色）依赖 U1（需要时间戳数据）
- U3（Widget）依赖 U1（需要时间戳）和 U4（需要格式化函数）
- U5（集成测试）依赖所有前置任务
- U2 和 U3 都修改 `display.ts` 和 `workflow-tool.ts`，有文件冲突

### 推荐执行批次

1. **批次 1（可并行）**
   - subagent 1：U1 — 填充 startedAt/finishedAt（修改 workflow-tool.ts）
   - subagent 2：U4 — 耗时格式化函数（修改 display.ts 底部，无冲突区）

2. **主 agent 协调点**
   - 汇总变更
   - 检查 display.ts 是否有冲突
   - 统一执行 `npm run build`

3. **批次 2（串行）**
   - subagent 3：U2 — renderResult 着色（需要 U1 的时间戳 + 修改 display.ts 和 workflow-tool.ts）
   - 原因：U2 和 U3 都大面积修改 display.ts，不宜并行

4. **主 agent 协调点**
   - 执行 `npm run build && npm run test:unit`

5. **批次 3（串行）**
   - subagent 4：U3 — Widget 实时状态栏（修改 display.ts 和 workflow-tool.ts）

6. **主 agent 协调点**
   - 执行 `npm run build && npm run test:unit`

7. **批次 4**
   - 主 agent 直接执行 U5：集成测试 + biome check + 最终验证

### subagent 限制

- subagent 只负责实现、阅读、分析、局部修改或产出建议
- subagent **禁止**执行编译（`npm run build`、`tsc`）
- subagent **禁止**执行测试（`npm run test:unit`）
- subagent **禁止**执行提交（`git commit`、`git push`）
- 编译、测试、提交统一由主 agent 执行
