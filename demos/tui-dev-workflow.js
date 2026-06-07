export const meta = {
  name: "workflow_tui_dev",
  description: "Workflow TUI 渲染优化 — 按计划执行 U1-U4 开发 + Review",
  phases: [
    { title: "批次1：时间戳 + 格式化函数" },
    { title: "批次2：renderResult 着色" },
    { title: "批次3：Widget 状态栏" },
    { title: "Review" },
  ],
};

const PLAN_PATH =
  "/Users/zzk/CliProject/PiExtensions/pi-dynamic-workflows/docs/plans/2026-06-07-001-feat-workflow-tui-rendering-plan.md";
const PROJECT_DIR = "/Users/zzk/CliProject/PiExtensions/pi-dynamic-workflows";

const CONTEXT = `
项目目录：${PROJECT_DIR}
计划文件：${PLAN_PATH}

## 关键约束
- 你只负责写代码，禁止执行编译、测试、提交
- 所有文件路径使用绝对路径
- 遵循项目现有代码风格（TypeScript, biome 格式化）
- 修改前先读取目标文件了解当前状态
`;

const THEME_API_CONTEXT = `
## Theme API 参考
- theme.fg(color, text) — 前景色：accent, success, error, dim, muted, toolTitle, toolOutput, text
- theme.bg(color, text) — 背景色：toolPendingBg, toolSuccessBg, toolErrorBg
- theme.bold(text) — 加粗
- theme.italic(text) — 斜体

## pi-tui 组件
- Text(text, paddingX, paddingY, bgFn?) — 多行文本+自动换行
- Box(paddingX, paddingY, bgFn?) — 容器，addChild()

## Widget API
ctx.ui.setWidget("name", (_tui, _theme) => ({
  invalidate() {},
  render(width: number): string[] { return lines; }
}), { placement: "aboveEditor" });
`;

// ============================================================
// 批次 1：U1 + U4 并行（无文件冲突）
// ============================================================
phase("批次1：时间戳 + 格式化函数");

const [u1Result, u4Result] = await parallel([
  // U1: 填充 startedAt/finishedAt
  () =>
    agent(
      `你是一名 TypeScript 开发者。执行计划 U1：填充 startedAt/finishedAt 时间戳。

${CONTEXT}

## 任务
修改 ${PROJECT_DIR}/src/workflow-tool.ts：
- 在 onAgentStart 回调中，push agent snapshot 时添加 \`startedAt: Date.now()\`
- 在 onAgentEnd 回调中，找到 agent 后添加 \`finishedAt: Date.now()\`

## 步骤
1. 读取 ${PROJECT_DIR}/src/workflow-tool.ts 找到 onAgentStart 和 onAgentEnd 回调
2. 在 onAgentStart 中 snapshot.agents.push({...}) 里加 startedAt: Date.now()
3. 在 onAgentEnd 中 agent.status 赋值附近加 agent.finishedAt = Date.now()
4. 输出你修改的完整代码片段

注意：startedAt 和 finishedAt 字段已在 WorkflowAgentSnapshot 接口中定义，不需要改接口。`,
      {
        label: "U1: startedAt/finishedAt",
        schema: {
          type: "object",
          properties: {
            filesModified: { type: "array", items: { type: "string" } },
            summary: { type: "string" },
            success: { type: "boolean" },
          },
          required: ["filesModified", "summary", "success"],
        },
      },
    ),

  // U4: 耗时格式化函数
  () =>
    agent(
      `你是一名 TypeScript 开发者。执行计划 U4：创建耗时格式化工具函数。

${CONTEXT}

## 任务
修改 ${PROJECT_DIR}/src/display.ts，在文件末尾（export function preview 之后）添加一个新的导出函数：

\`\`\`typescript
export function formatElapsed(ms: number): string {
  // < 1000 → "<1s"
  // 1000-59999 → "Ns"（如 "45s"）
  // 60000-3599999 → "Nm Ns"（如 "2m 5s"）
  // >= 3600000 → "Nh Nm"（如 "1h 23m"）
  // 负数或 NaN → "<1s"
}
\`\`\`

## 步骤
1. 读取 ${PROJECT_DIR}/src/display.ts 找到文件末尾
2. 在最后添加 formatElapsed 函数
3. 输出完整的函数代码`,
      {
        label: "U4: formatElapsed",
        schema: {
          type: "object",
          properties: {
            filesModified: { type: "array", items: { type: "string" } },
            summary: { type: "string" },
            success: { type: "boolean" },
          },
          required: ["filesModified", "summary", "success"],
        },
      },
    ),
]);

log(`批次1完成: U1=${u1Result?.success ? "✓" : "✗"} U4=${u4Result?.success ? "✓" : "✗"}`);

// ============================================================
// 批次 2：U2 renderResult 着色（依赖 U1）
// ============================================================
phase("批次2：renderResult 着色");

const u2Result = await agent(
  `你是一名 TypeScript 开发者。执行计划 U2：为 workflow 的 renderResult 添加主题着色。

${CONTEXT}
${THEME_API_CONTEXT}

## 任务
1. 在 ${PROJECT_DIR}/src/display.ts 中新增函数 \`renderWorkflowThemed\`
2. 在 ${PROJECT_DIR}/src/workflow-tool.ts 的 renderResult 中调用它

## renderWorkflowThemed 设计

\`\`\`typescript
export function renderWorkflowThemed(
  snapshot: WorkflowSnapshot,
  theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
  options: WorkflowDisplayOptions = {},
): string
\`\`\`

输出格式（带 theme 着色）：
\`\`\`
▸ {name} — {agentCount} agents · {duration}

  {phaseIcon} {phaseName}                    {phaseDuration}
    #{id} {statusIcon} {label}               {agentDuration}
         📄 {resultPreview}   （如果有文件路径）
  ...

  📄 {resultFile}
\`\`\`

着色规则：
- \`▸\` → theme.fg("accent", "▸")
- workflow name → theme.fg("toolTitle", theme.bold(name))
- agent count + duration → theme.fg("dim", ...)
- phase name → 无特殊着色（默认文本色）
- phase icon: ✓完成→theme.fg("success"), ▶进行中→theme.fg("accent"), ○等待→theme.fg("dim")
- agent ✓ → theme.fg("success"), ✗ → theme.fg("error"), ● → theme.fg("accent")
- agent label → theme.fg("toolOutput", ...)
- agent duration → theme.fg("dim", ...)
- 文件路径 → theme.fg("muted", ...)
- 总结果文件 → theme.fg("muted", ...)

## 步骤
1. 读取 ${PROJECT_DIR}/src/display.ts 了解现有结构
2. 读取 ${PROJECT_DIR}/src/workflow-tool.ts 了解 renderResult 当前逻辑
3. 在 display.ts 中添加 renderWorkflowThemed 函数
4. 在 display.ts 中导出它（检查 index.ts 是否需要更新导出）
5. 修改 workflow-tool.ts 的 renderResult：当 !isPartial 时使用 renderWorkflowThemed，isPartial 时保持原样

注意：
- 使用已有的 formatElapsed 函数格式化耗时（从 display.ts 导入）
- snapshot.agents 中的 startedAt/finishedAt 可能为 undefined，需要防御
- 保持 renderWorkflowText（纯文本版本）不变，它仍供 onUpdate 流式通道使用
- 渲染时计算 phase duration = 该 phase 最后一个 agent 的 finishedAt - 第一个 agent 的 startedAt`,
  {
    label: "U2: renderResult themed",
    schema: {
      type: "object",
      properties: {
        filesModified: { type: "array", items: { type: "string" } },
        summary: { type: "string" },
        success: { type: "boolean" },
      },
      required: ["filesModified", "summary", "success"],
    },
  },
);

log(`批次2完成: U2=${u2Result?.success ? "✓" : "✗"}`);

// ============================================================
// 批次 3：U3 Widget 实时状态栏（依赖 U1, U4）
// ============================================================
phase("批次3：Widget 状态栏");

const u3Result = await agent(
  `你是一名 TypeScript 开发者。执行计划 U3：实现 Widget 实时状态栏。

${CONTEXT}
${THEME_API_CONTEXT}

## 任务
在 workflow 运行期间，在输入框上方显示带边框的树状实时进度状态栏。

## 需要修改的文件
1. ${PROJECT_DIR}/src/display.ts — 新增 renderWorkflowWidgetLines 函数
2. ${PROJECT_DIR}/src/workflow-tool.ts — 注册/更新/清除 widget

## Widget 视觉效果

\`\`\`
╭─ Workflow: dev_workflow_demo ────────── 3/10 done ─╮
│  ✓ 规划                                           │
│    #1 ✓ Tech Lead 制定计划                   12s  │
│  ▶ 并行实现                                       │
│    #2 ● 实现 string-utils                    8s  │
│    #3 ● 实现 array-utils                     6s  │
│  ○ Review                                         │
│  ○ 总结                                           │
╰───────────────────────────────────────────────────╯
\`\`\`

## display.ts 新增函数

\`\`\`typescript
export function renderWorkflowWidgetLines(snapshot: WorkflowSnapshot, width: number): string[]
\`\`\`

实现要点：
- 使用 box-drawing 字符：╭ ╮ ╰ ╯ │ ─
- 使用硬编码 ANSI 蓝色边框（参考 subagent 做法）：
  \`const ACCENT = "\\x1b[38;2;77;163;255m"; const RST = "\\x1b[0m";\`
- 状态图标着色：
  - ✓ done: "\\x1b[32m✓\\x1b[0m" (绿色)
  - ● running: "\\x1b[36m●\\x1b[0m" (青色)
  - ✗ error: "\\x1b[31m✗\\x1b[0m" (红色)
  - ▶ phase running: "\\x1b[36m▶\\x1b[0m" (青色)
  - ○ phase pending: "\\x1b[90m○\\x1b[0m" (灰色)
- 标题行格式：\`╭─ Workflow: {name} ──── {done}/{total} done ─╮\`
- 内容行格式：\`│  {phaseIcon} {phaseName}  ...padding...  │\`
- 底部行格式：\`╰─────────────────────────────────────────╯\`
- 最多显示最近 6 个 agent（超过的显示 "… N earlier"）
- Unphased agent 不显示 phase 行，直接显示 agent 列表
- 使用 formatElapsed 格式化耗时
- width 参数用于控制边框宽度（min 50, max width）

## workflow-tool.ts 修改

在 execute 函数中：

1. 开始时注册 widget：
\`\`\`typescript
const WIDGET_KEY = Symbol.for("pi-workflow-widget-interval");
let widgetInterval: ReturnType<typeof setInterval> | null = null;

// 清除旧定时器（/reload 防护）
const prev = (globalThis as any)[WIDGET_KEY];
if (prev) clearInterval(prev);

function updateWidget() {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget("workflow-status", (_tui, _theme) => ({
    invalidate() {},
    render(width: number) {
      return renderWorkflowWidgetLines(snapshot, width);
    }
  }), { placement: "aboveEditor" });
}

updateWidget();
widgetInterval = setInterval(updateWidget, 1000);
(globalThis as any)[WIDGET_KEY] = widgetInterval;
\`\`\`

2. 每次 update() 调用后也调用 updateWidget()

3. 完成/错误时清除：
\`\`\`typescript
if (widgetInterval) { clearInterval(widgetInterval); widgetInterval = null; }
if (ctx.hasUI) ctx.ui.setWidget("workflow-status", undefined);
\`\`\`

## 步骤
1. 读取 ${PROJECT_DIR}/src/display.ts 了解结构
2. 读取 ${PROJECT_DIR}/src/workflow-tool.ts 了解 execute 函数
3. 在 display.ts 添加 renderWorkflowWidgetLines
4. 在 workflow-tool.ts 的 execute 中添加 widget 注册/更新/清除逻辑
5. 确保 ctx.hasUI 守护（没有 UI 时不注册）

注意：
- ctx 变量在 execute 的参数中，类型是 ExtensionContext
- ctx.ui 和 ctx.hasUI 属性可能需要检查是否存在
- snapshot 变量在 execute 作用域内已定义`,
  {
    label: "U3: Widget 状态栏",
    schema: {
      type: "object",
      properties: {
        filesModified: { type: "array", items: { type: "string" } },
        summary: { type: "string" },
        success: { type: "boolean" },
      },
      required: ["filesModified", "summary", "success"],
    },
  },
);

log(`批次3完成: U3=${u3Result?.success ? "✓" : "✗"}`);

// ============================================================
// Review 阶段
// ============================================================
phase("Review");

const reviewResult = await agent(
  `你是一名高级 TypeScript Code Reviewer。请审查以下文件的最新修改。

## 审查范围
- ${PROJECT_DIR}/src/display.ts
- ${PROJECT_DIR}/src/workflow-tool.ts

## 审查标准
1. TypeScript 类型正确性（无 any 泄漏、参数类型匹配）
2. 边界情况处理（undefined 检查、空数组、负数耗时等）
3. 资源管理（setInterval 是否有对应 clearInterval、/reload 防护）
4. 逻辑正确性（box-drawing 宽度计算、ANSI 转义码正确性）
5. 代码风格一致性（与项目现有风格匹配）
6. 功能完整性（是否满足计划中的所有要求）

## 计划要求参考
- R1: renderResult 最终视图使用 theme 着色
- R2: 运行中通过 Widget 显示实时进度
- R3: agent 状态用颜色图标区分
- R4: 显示每个 agent 的耗时
- R5: 文件路径用 dim/muted 颜色降低视觉噪音
- R6: content 文本给大 agent 看的内容不变

## 输出格式
列出发现的所有问题，按严重程度分类（critical/major/minor/nit）。
如果所有代码通过审查，设置 passed: true。`,
  {
    label: "Code Review",
    schema: {
      type: "object",
      properties: {
        passed: { type: "boolean" },
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file: { type: "string" },
              severity: { type: "string", enum: ["critical", "major", "minor", "nit"] },
              line: { type: "string", description: "相关代码行或位置描述" },
              description: { type: "string" },
              suggestion: { type: "string" },
            },
            required: ["file", "severity", "description"],
          },
        },
        summary: { type: "string" },
      },
      required: ["passed", "issues", "summary"],
    },
  },
);

log(`Review 完成: ${reviewResult?.passed ? "✓ 通过" : `✗ ${reviewResult?.issues?.length} 个问题`}`);

return {
  u1: u1Result,
  u4: u4Result,
  u2: u2Result,
  u3: u3Result,
  review: reviewResult,
};
