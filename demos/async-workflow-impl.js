export const meta = {
  name: 'async_workflow_impl',
  description: '实现 workflow 异步化 — fire-and-forget + steer 通知',
  phases: [
    { title: '核心实现' },
    { title: '并行扩展' },
    { title: '中断支持' },
    { title: '代码审查' },
    { title: '修复' },
  ],
};

const PROJECT = '/Users/zzk/CliProject/PiExtensions/pi-dynamic-workflows';
const PLAN_PATH = `${PROJECT}/docs/plans/2026-06-07-002-feat-async-workflow-plan.md`;

const SHARED_CONTEXT = `
项目路径: ${PROJECT}
关键文件:
- src/workflow-tool.ts: workflow 工具主文件（312 行）
- extensions/workflow.ts: 扩展注册入口（14 行）
- src/display.ts: 渲染逻辑
- src/workflow.ts: runWorkflow 执行引擎

当前 workflow 工具是同步的：execute() handler 阻塞直到所有 agent 完成。
目标：新增异步模式，通过 PI_WORKFLOW_ASYNC=true 环境变量启用。

异步模式行为：
1. execute() 立即返回 "已启动" 确认
2. 后台 Promise 链执行 workflow（独立 AbortController）
3. Widget 在工具返回后继续存活，setInterval 每秒刷新
4. 完成后通过 pi.sendMessage({ customType: "workflow_result", ... }, { triggerTurn: true, deliverAs: "steer" }) 唤醒主 agent
5. 注册 registerMessageRenderer("workflow_result") 自定义渲染结果
6. 已有 workflow 运行时拒绝新调用

核心 API 参考（来自 pi-interactive-subagents 的成熟模式）：
- pi.sendMessage({ customType: string, content: string, display: boolean, details: T }, { triggerTurn: true, deliverAs: "steer" })
- pi.registerMessageRenderer(customType, (message, options, theme) => Text)
- ctx.ui.setWidget(key, factory, { placement: "aboveEditor" }) — 工具返回后 Widget 继续存活

subagent 限制：禁止执行编译(tsc/npm run build)、测试(npm test)、提交(git commit/push)。只负责写代码。
`;

// ============================================================
// Phase 1: U1 — 异步执行核心逻辑
// ============================================================
phase("核心实现");

const u1Result = await agent(`
${SHARED_CONTEXT}

## 任务：U1 — 实现异步执行核心逻辑

修改 ${PROJECT}/src/workflow-tool.ts 和 ${PROJECT}/extensions/workflow.ts。

### 具体要求：

1. 在 workflow-tool.ts 的 createWorkflowTool 函数中：
   - 添加模块级状态 \`let runningWorkflow: { name: string; abortController: AbortController } | null = null;\`
   - 在 execute handler 开头检测 \`process.env.PI_WORKFLOW_ASYNC === "true"\`
   - 异步模式下：
     a. 如果 runningWorkflow 非空，抛错 "已有 workflow 在运行: {name}"
     b. 完成脚本解析（parseWorkflowScript）和 snapshot 初始化后
     c. 创建独立 AbortController（不使用工具的 signal）
     d. 设置 runningWorkflow = { name, abortController }
     e. 初始化 Widget（同步模式的 Widget 代码直接复用）
     f. 将 runWorkflow + 后续逻辑放入独立 Promise 链（不 await），在 .then() 中：
        - 完成 snapshot 计算 + 写入结果文件
        - 清除 Widget
        - 设置 runningWorkflow = null
        - 调用 pi.sendMessage 推送结果（见下方）
     g. .catch() 中：
        - 清除 Widget
        - 设置 runningWorkflow = null
        - 推送错误 steer 消息
     h. 立即返回 { content: [{ type: "text", text: "Workflow {name} 已启动，后台执行中..." }], details: { name, status: "started" } }
   - 同步模式：代码完全不变

2. 在 workflow-tool.ts 的 WorkflowToolOptions 接口中：
   - pi 字段类型扩展：\`pi?: { sendMessage: (message: any, options?: any) => void; registerMessageRenderer?: (type: string, renderer: any) => void }\`

3. 在 extensions/workflow.ts 中：
   - 在 registerTool 之后，注册消息渲染器：
     \`\`\`
     pi.registerMessageRenderer("workflow_result", (message, options, theme) => {
       const snapshot = message.details;
       if (snapshot?.name) {
         return new Text(renderWorkflowThemed(snapshot, theme, workflowDisplayOptions), 0, 0);
       }
       return new Text(message.content || "workflow completed", 0, 0);
     });
     \`\`\`
   - 需要从 src/index.js 导入 renderWorkflowThemed 和相关依赖

4. steer 消息格式：
   \`\`\`
   pi.sendMessage(
     {
       customType: "workflow_result",
       content: \\\`Workflow \${name} completed with \${agentCount} agent(s) in \${durationMs}ms.\\n结果已写入: \${outFile}\\\`,
       display: true,
       details: snapshot, // 完整 snapshot 对象
     },
     { triggerTurn: true, deliverAs: "steer" }
   );
   \`\`\`

5. 在 src/index.ts 中确保导出了 renderWorkflowThemed 和 workflowDisplayOptions（如果还没导出的话）

注意：
- options.pi 可能不存在（同步模式不需要），异步模式下如果 options.pi 不存在应该回退到同步模式
- AbortController 在 VM 沙箱中传递 signal 时使用 bgAbortController.signal 替代工具的 signal 参数
- 保持所有现有代码不变，只添加新的异步路径
`, { label: 'U1 异步核心' });

// ============================================================
// Phase 2: U2 + U3 并行
// ============================================================
phase("并行扩展");

const [u2Result, u3Result] = await parallel([
  () => agent(`
${SHARED_CONTEXT}

## 任务：U2 — Widget 跨工具生命周期管理

读取 ${PROJECT}/src/workflow-tool.ts 的最新内容（U1 已修改过），确认异步模式中 Widget 的生命周期管理正确。

### 检查和补充：

1. 确认异步模式的 Promise 链中：
   - .then() 完成时：先 clearInterval，再 clearWidget（调用 ctx.ui.setWidget("workflow-status", undefined)）
   - .catch() 异常时：同样清除 Widget
   - AbortController.abort() 中断时：同样清除 Widget

2. 确认 Widget 的 setInterval 使用独立的变量管理（不受工具 signal 影响）

3. 如果发现缺失或不正确的清理逻辑，修复它

4. 添加 session_shutdown 事件处理（在 extensions/workflow.ts 中）：
   \`\`\`
   pi.on("session_shutdown", () => {
     // 如果有运行中的 workflow，清理资源
     // 通过某种方式通知 workflow-tool 清理
   });
   \`\`\`
   
   具体方式：在 workflow-tool.ts 中导出一个 \`cleanupRunningWorkflow()\` 函数，session_shutdown 时调用。
   该函数：abort controller + clear widget interval + 设置 runningWorkflow = null

注意：只修改 Widget 生命周期相关代码，不要改动核心异步逻辑或 steer 消息逻辑。
`, { label: 'U2 Widget 生命周期' }),

  () => agent(`
${SHARED_CONTEXT}

## 任务：U3 — 确认 steer 消息推送和渲染器注册

读取 ${PROJECT}/src/workflow-tool.ts 和 ${PROJECT}/extensions/workflow.ts 的最新内容（U1 已修改过），确认：

1. steer 消息推送逻辑是否完整：
   - 成功时推送 "workflow_result" 类型消息
   - 失败时推送带错误信息的消息
   - content 字段包含摘要文本（agent 可读）
   - details 字段包含完整 snapshot（渲染器可用）

2. registerMessageRenderer 是否正确注册：
   - 在 extensions/workflow.ts 中注册
   - 使用 renderWorkflowThemed 渲染 snapshot
   - 处理 snapshot 不存在的降级情况

3. 确保 src/index.ts 导出了渲染器需要的所有符号：
   - renderWorkflowThemed
   - WorkflowTheme（类型）
   - workflowDisplayOptions 或其等价物

如果发现问题，修复代码。如果一切正确，输出确认信息。
`, { label: 'U3 steer 消息' }),
]);

// ============================================================
// Phase 3: U4 — 中断支持
// ============================================================
phase("中断支持");

const u4Result = await agent(`
${SHARED_CONTEXT}

## 任务：U4 — 中断与取消支持

读取 ${PROJECT}/src/workflow-tool.ts 和 ${PROJECT}/extensions/workflow.ts 的最新内容。

### 实现：

1. 在 workflow-tool.ts 中导出 \`cancelRunningWorkflow()\` 函数：
   \`\`\`typescript
   export function cancelRunningWorkflow(): { cancelled: boolean; name?: string } {
     if (!runningWorkflow) return { cancelled: false };
     const { name } = runningWorkflow;
     runningWorkflow.abortController.abort();
     // Widget 清理和 steer 消息会在 Promise 链的 catch 中处理
     return { cancelled: true, name };
   }
   \`\`\`

2. 在 extensions/workflow.ts 中注册 \`workflow_cancel\` 工具：
   - name: "workflow_cancel"
   - label: "Cancel Workflow"
   - description: "取消正在后台运行的 workflow"
   - parameters: 无（Type.Object({})）
   - execute: 调用 cancelRunningWorkflow()，返回结果
   - 只在异步模式启用时注册（检查 PI_WORKFLOW_ASYNC env var）

3. 在 extensions/workflow.ts 的 session_shutdown 中调用 cancelRunningWorkflow()

4. 确保 Promise 链的 catch 中正确处理 abort 错误：
   - 检测 isAbortError
   - 标记 running agents 为 skipped
   - 推送取消通知 steer 消息（content: "Workflow {name} 已取消"）
   - 清除 Widget + runningWorkflow

注意：
- cancelRunningWorkflow 和 cleanupRunningWorkflow（如果 U2 创建了的话）可以合并为一个函数
- workflow_cancel 工具不需要 renderResult（简单文本返回即可）
`, { label: 'U4 中断取消' });

// ============================================================
// Phase 4: 代码审查
// ============================================================
phase("代码审查");

const reviewResult = await agent(`
你是一个严格的代码审查者。审查以下文件的最新内容：

1. ${PROJECT}/src/workflow-tool.ts
2. ${PROJECT}/extensions/workflow.ts
3. ${PROJECT}/src/index.ts

审查标准：
- TypeScript 类型正确性（无 any 滥用，接口一致）
- 异步模式逻辑完整性（启动、执行、完成、错误、中断 全路径覆盖）
- 资源泄漏（setInterval 是否都能被清除，AbortController 是否正确使用）
- 与同步模式的隔离（同步路径不受影响）
- pi.sendMessage 调用格式正确
- 导出/导入完整（extensions/workflow.ts 能正确使用 src/index.ts 的导出）
- registerMessageRenderer 正确注册
- 代码重复/冗余

输出格式（JSON）：
{
  "passed": true/false,
  "issues": [
    {
      "severity": "major|minor|nit",
      "file": "相对路径",
      "location": "函数名或行号附近",
      "description": "问题描述",
      "suggestion": "修复建议"
    }
  ]
}

如果没有 major 或 minor 问题，passed 为 true。
`, {
  label: '代码审查',
  schema: {
    type: "object",
    properties: {
      passed: { type: "boolean" },
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["major", "minor", "nit"] },
            file: { type: "string" },
            location: { type: "string" },
            description: { type: "string" },
            suggestion: { type: "string" }
          },
          required: ["severity", "file", "description", "suggestion"]
        }
      }
    },
    required: ["passed", "issues"]
  }
});

// ============================================================
// Phase 5: 修复（最多 3 轮）
// ============================================================
phase("修复");

let fixRound = 0;
let currentReview = reviewResult;

while (currentReview && !currentReview.passed && fixRound < 3) {
  fixRound++;
  const issues = currentReview.issues.filter(i => i.severity !== "nit");
  
  if (issues.length === 0) break;

  const issueList = issues.map((issue, idx) => 
    `${idx + 1}. [${issue.severity}] ${issue.file} @ ${issue.location || "unknown"}\n   问题: ${issue.description}\n   建议: ${issue.suggestion}`
  ).join("\n\n");

  log(`修复轮次 ${fixRound}/3: ${issues.length} 个问题待修复`);

  const fixResult = await agent(`
${SHARED_CONTEXT}

## 任务：修复代码审查发现的问题（轮次 ${fixRound}/3）

以下是代码审查发现的问题，请逐一修复：

${issueList}

修复文件路径：
- ${PROJECT}/src/workflow-tool.ts
- ${PROJECT}/extensions/workflow.ts
- ${PROJECT}/src/index.ts

要求：
- 精确修复上述问题，不要引入新的改动
- 修复后确认每个问题都已解决
`, { label: `修复轮次${fixRound}` });

  // 再次审查
  currentReview = await agent(`
严格审查修复后的代码。读取：
1. ${PROJECT}/src/workflow-tool.ts
2. ${PROJECT}/extensions/workflow.ts
3. ${PROJECT}/src/index.ts

重点检查之前发现的问题是否已正确修复，以及是否引入了新问题。

输出格式（JSON）：
{
  "passed": true/false,
  "issues": [
    {
      "severity": "major|minor|nit",
      "file": "相对路径",
      "location": "函数名或行号附近",
      "description": "问题描述",
      "suggestion": "修复建议"
    }
  ]
}
`, {
    label: `审查轮次${fixRound}`,
    schema: {
      type: "object",
      properties: {
        passed: { type: "boolean" },
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { type: "string", enum: ["major", "minor", "nit"] },
              file: { type: "string" },
              location: { type: "string" },
              description: { type: "string" },
              suggestion: { type: "string" }
            },
            required: ["severity", "file", "description", "suggestion"]
          }
        }
      },
      required: ["passed", "issues"]
    }
  });
}

log(`开发完成。审查${currentReview?.passed ? "通过" : "未完全通过"}，修复轮次: ${fixRound}`);

return {
  u1: u1Result ? "done" : "failed",
  u2: u2Result ? "done" : "failed",
  u3: u3Result ? "done" : "failed",
  u4: u4Result ? "done" : "failed",
  review: currentReview,
  fixRounds: fixRound,
};
