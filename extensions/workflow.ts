import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { cancelRunningWorkflow, createWorkflowTool, renderWorkflowThemed } from "../src/index.js";

export default function extension(pi: ExtensionAPI) {
  const workflowTool = createWorkflowTool({ pi });
  pi.registerTool(workflowTool);

  // 异步模式：注册 workflow_cancel 工具
  if (process.env.PI_WORKFLOW_ASYNC === "true") {
    const cancelTool = defineTool({
      name: "workflow_cancel",
      label: "Cancel Workflow",
      description: "取消正在后台运行的 workflow",
      promptSnippet: "Cancel a running background workflow.",
      parameters: Type.Object({}),
      async execute() {
        const result = cancelRunningWorkflow();
        if (result.cancelled) {
          return {
            content: [{ type: "text", text: `Workflow ${result.name} 取消请求已发送` }],
          };
        }
        return {
          content: [{ type: "text", text: "当前没有正在运行的 workflow" }],
        };
      },
      renderCall(_args, theme) {
        return new Text(theme.fg("toolTitle", theme.bold("workflow_cancel")), 0, 0);
      },
    });
    pi.registerTool(cancelTool);
  }

  // 注册异步模式的结果消息渲染器
  pi.registerMessageRenderer("workflow_result", (message: any, _options: any, theme: any) => {
    const snapshot = message.details;
    if (!snapshot?.name) return undefined;

    return {
      render(width: number): string[] {
        const hasError = snapshot.errorCount > 0;
        const bgFn = hasError
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const icon = hasError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const status = hasError ? "completed with errors" : "completed";
        const elapsed = snapshot.durationMs ? `${Math.round(snapshot.durationMs / 1000)}s` : "?";

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(`Workflow: ${snapshot.name}`))} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;

        const contentLines = [header, ""];
        const themed = renderWorkflowThemed(snapshot, theme, {
          key: "workflow",
          streamToolUpdates: true,
          maxAgents: 4,
          maxLogs: 1,
          showResultPreviews: true,
        });
        contentLines.push(...themed.split("\n"));

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    const toolNames = [workflowTool.name];
    if (process.env.PI_WORKFLOW_ASYNC === "true") toolNames.push("workflow_cancel");
    for (const name of toolNames) {
      if (!active.includes(name)) {
        pi.setActiveTools([...pi.getActiveTools(), name]);
      }
    }
  });

  // 会话关闭时取消运行中的异步 workflow
  pi.on("session_shutdown", () => {
    cancelRunningWorkflow();
  });
}
