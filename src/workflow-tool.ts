import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { WorkflowTheme } from "./display.js";
import {
  createToolUpdateWorkflowDisplay,
  createWorkflowSnapshot,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  renderWorkflowThemed,
  renderWorkflowWidgetLines,
  type WorkflowSnapshot,
} from "./display.js";
import { parseWorkflowScript, runWorkflow, type WorkflowRunResult } from "./workflow.js";

const workflowToolSchema = Type.Object({
  script: Type.Optional(
    Type.String({
      description: [
        "Raw JavaScript workflow script, with no Markdown fences.",
        "First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }.",
        "Use phase('Name'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), log(message), args, and budget.",
        "parallel() requires functions, not promises: await parallel(items.map(item => () => agent(...))).",
      ].join(" "),
    }),
  ),
  file: Type.Optional(
    Type.String({
      description:
        "Absolute or relative path to a .js workflow file. Reads the file and executes it as the workflow script.",
    }),
  ),
  args: Type.Optional(
    Type.Any({ description: "Optional JSON value exposed to the workflow script as global `args`." }),
  ),
});

export type WorkflowToolInput = {
  script?: string;
  file?: string;
  args?: unknown;
};

const workflowDisplayOptions = {
  key: "workflow",
  streamToolUpdates: true,
  maxAgents: 4,
  maxLogs: 1,
  showResultPreviews: true,
} as const;

export interface WorkflowToolOptions {
  cwd?: string;
  concurrency?: number;
  pi?: { sendMessage: (message: any, options?: any) => void };
}

let runningWorkflow: { name: string; abortController: AbortController; cleanWidget?: () => void } | null = null;

/**
 * 取消正在运行的异步 workflow。
 * 返回取消结果，供 workflow_cancel 工具和 session_shutdown 使用。
 */
export function cancelRunningWorkflow(): { cancelled: boolean; name?: string } {
  if (!runningWorkflow) return { cancelled: false };
  const { name, cleanWidget } = runningWorkflow;
  runningWorkflow.abortController.abort();
  // 立即清理 widget，不等 Promise 链 catch
  if (cleanWidget) cleanWidget();
  return { cancelled: true, name };
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition<typeof workflowToolSchema, any> {
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Execute a deterministic JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), and pipeline().",
      "script is required raw JavaScript. It must start with export const meta = { name, description } and must call agent() at least once; phases are optional metadata.",
    ].join(" "),
    promptSnippet:
      "Run a deterministic JavaScript workflow. Required script header: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. Use phase(title) at runtime to create progress groups.",
    promptGuidelines: [
      "Use workflow only when the user explicitly asks for a workflow, workflows, fan-out, or multi-agent orchestration.",
      "For workflow, always pass one raw JavaScript string in the required script parameter; do not include Markdown fences or prose around the script.",
      "For workflow, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description' }`; meta.name and meta.description are required non-empty strings, and meta.phases is optional metadata for a stable upfront outline.",
      "For workflow, write plain JavaScript after the meta export. Do not use TypeScript syntax, imports, require(), fs, Date.now(), Math.random(), or new Date().",
      "For workflow, available globals are agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd, process.cwd(), and budget. Every workflow must call agent() at least once; do not use workflow only to declare phases or return a static object.",
      "For workflow, call phase(title) when a new group of work starts. Phase names may be conditional or built in a loop; do not predeclare speculative phases just in case.",
      "For workflow, prefer it for decomposable work: repository inspection, independent research/checks, multi-perspective review, or fan-out/fan-in synthesis. Do not use it for a single quick file read/edit or when ordinary tools are enough.",
      "For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order.",
      "For workflow, pipeline(items, ...stages) runs each item through stages sequentially, while different items may run concurrently. Each stage receives (previousValue, originalItem, index).",
      "For workflow, every agent() call should include a unique short label option, 2-5 words, such as { label: 'repo inventory' } or { label: 'source modules' }; unique labels make live status and error reporting readable.",
      "For workflow, failed agent(), parallel(), or pipeline() branches return null and log the failure unless the workflow is aborted. Check for nulls before synthesizing conclusions.",
      "For workflow, include a final synthesis/assertion agent when combining multiple subagent results; return a compact JSON-serializable value with ok/verdict plus the important outputs.",
      "For workflow, if agent() needs machine-readable output, pass a plain JSON Schema via opts.schema; agent() will return the validated object. Use JSON Schema syntax, not TypeScript or TypeBox constructors.",
      "For workflow, do not assume the parent assistant has repository code context inside subagents; include enough task context and relevant paths in each agent prompt.",
    ],
    parameters: workflowToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // 从 file 或 script 获取脚本内容
      let rawScript: string;
      if (params.file) {
        const filePath = params.file.startsWith("/") ? params.file : join(ctx.cwd ?? "/", params.file);
        rawScript = readFileSync(filePath, "utf8");
      } else if (params.script) {
        rawScript = params.script;
      } else {
        throw new Error(
          "workflow requires either a `script` (JavaScript string) or `file` (path to .js file) argument",
        );
      }
      const script = normalizeWorkflowScript(rawScript);
      const parsed = parseWorkflowScript(script);

      // === 异步模式 ===
      const isAsync = process.env.PI_WORKFLOW_ASYNC === "true" && options.pi;
      if (isAsync) {
        if (runningWorkflow) {
          throw new Error(`已有 workflow 在运行: ${runningWorkflow.name}`);
        }

        let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
        snapshot.startedAt = Date.now();
        const bgAbortController = new AbortController();
        const name = parsed.meta.name;
        const workflowCwd = options.cwd ?? ctx.cwd;

        // Widget 实时状态栏
        const { updateWidget, clearWidget } = setupWidget(ctx, () => snapshot);

        // 存储清理函数供 cancelRunningWorkflow() 立即清理
        runningWorkflow = { name, abortController: bgAbortController, cleanWidget: clearWidget };

        const update = () => {
          snapshot = recomputeWorkflowSnapshot(snapshot);
          // 异步模式下 tool 已返回，onUpdate 通道已失效，仅通过 widget 推送状态
          updateWidget();
        };

        // 后台 Promise 链
        runWorkflow(script, {
          ...createWorkflowRunOptions({
            cwd: workflowCwd,
            args: params.args,
            signal: bgAbortController.signal,
            concurrency: options.concurrency,
            ctx,
          }),
          ...createWorkflowCallbacks({
            snapshot: () => snapshot,
            setSnapshot: (s) => {
              snapshot = s;
            },
            update,
            signal: bgAbortController.signal,
            cwd: workflowCwd,
            metaName: parsed.meta.name,
          }),
        })
          .then((result) => {
            if (result.agentCount === 0) {
              throw new Error(
                "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
              );
            }
            snapshot.result = result.result;
            snapshot.durationMs = result.durationMs;
            snapshot = recomputeWorkflowSnapshot(snapshot);
            clearWidget();

            const outFile = writeResultFile(workflowCwd, result.meta.name, result.result);
            snapshot.resultFile = outFile;

            runningWorkflow = null;

            options.pi?.sendMessage(
              {
                customType: "workflow_result",
                content: `Workflow ${name} completed with ${result.agentCount} agent(s) in ${result.durationMs}ms.\n结果已写入: ${outFile}`,
                display: true,
                details: snapshot,
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((error) => {
            clearWidget();
            runningWorkflow = null;

            const aborted = isAbortError(error);
            const errMsg = error instanceof Error ? error.message : String(error);
            for (const agent of snapshot.agents) {
              if (agent.status === "running") {
                agent.status = aborted ? "skipped" : "error";
                agent.error = aborted ? "cancelled" : errMsg;
              }
            }
            snapshot = recomputeWorkflowSnapshot(snapshot);

            if (aborted) {
              options.pi?.sendMessage(
                {
                  customType: "workflow_result",
                  content: `Workflow ${name} 已取消`,
                  display: true,
                  details: { ...snapshot, cancelled: true },
                },
                { triggerTurn: true, deliverAs: "steer" },
              );
            } else {
              options.pi?.sendMessage(
                {
                  customType: "workflow_result",
                  content: `Workflow ${name} failed: ${errMsg}`,
                  display: true,
                  details: { ...snapshot, error: errMsg },
                },
                { triggerTurn: true, deliverAs: "steer" },
              );
            }
          });

        return {
          content: [{ type: "text", text: `Workflow ${name} 已启动，后台执行中...` }],
          details: { name, status: "started" },
        };
      }

      // === 同步模式（原逻辑）===
      let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
      const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, workflowDisplayOptions);

      snapshot.startedAt = Date.now();

      const workflowCwd = options.cwd ?? ctx.cwd;
      const { updateWidget, clearWidget } = setupWidget(ctx, () => snapshot);

      const update = () => {
        snapshot = recomputeWorkflowSnapshot(snapshot);
        display.update(snapshot);
        updateWidget();
      };

      let result: WorkflowRunResult;
      try {
        result = await runWorkflow(script, {
          ...createWorkflowRunOptions({
            cwd: workflowCwd,
            args: params.args,
            signal,
            concurrency: options.concurrency,
            ctx,
          }),
          ...createWorkflowCallbacks({
            snapshot: () => snapshot,
            setSnapshot: (s) => {
              snapshot = s;
            },
            update,
            signal,
            cwd: workflowCwd,
            metaName: parsed.meta.name,
          }),
        });
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          for (const agent of snapshot.agents) {
            if (agent.status === "running") {
              agent.status = "skipped";
              agent.error = "aborted";
            }
          }
          snapshot = recomputeWorkflowSnapshot(snapshot);
          display.complete(snapshot);
          clearWidget();
          throw new Error("Workflow was aborted");
        }
        clearWidget();
        throw error;
      }

      if (result.agentCount === 0) {
        throw new Error(
          "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
        );
      }

      snapshot.result = result.result;
      snapshot.durationMs = result.durationMs;
      snapshot = recomputeWorkflowSnapshot(snapshot);
      display.complete(snapshot);
      clearWidget();

      // 写入结果文件
      const outFile = writeResultFile(workflowCwd, result.meta.name, result.result);
      snapshot.resultFile = outFile;

      return {
        content: [
          {
            type: "text",
            text: `Workflow ${result.meta.name} completed with ${result.agentCount} agent(s) in ${result.durationMs}ms.\n结果已写入: ${outFile}`,
          },
        ],
        details: {
          ...snapshot,
          meta: result.meta,
          phases: result.phases,
          logs: result.logs,
          result: result.result,
          resultFile: outFile,
          durationMs: result.durationMs,
        },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const snapshot = result.details as WorkflowSnapshot | undefined;
      if (snapshot?.name) {
        if (!isPartial) {
          return new Text(
            renderWorkflowThemed(snapshot, theme as unknown as WorkflowTheme, workflowDisplayOptions),
            0,
            0,
          );
        }
        return new Text(renderWorkflowText(snapshot, false, workflowDisplayOptions), 0, 0);
      }
      const text = result.content?.[0];
      return new Text(text?.type === "text" ? text.text : theme.fg("muted", "workflow"), 0, 0);
    },
  });
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!args || typeof args !== "object")
    throw new Error("workflow requires an object argument with a script or file parameter");
  const value = args as Record<string, unknown>;
  if (typeof value.file !== "string" && typeof value.script !== "string")
    throw new Error("workflow requires `script` (JavaScript string) or `file` (path to .js file)");
  return value as WorkflowToolInput;
}

function normalizeWorkflowScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  return text;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}

// --- 提取的共享辅助函数 ---

/** 设置 Widget 实时状态栏，返回 updateWidget/clearWidget */
function setupWidget(
  ctx: any,
  getSnapshot: () => WorkflowSnapshot,
): { updateWidget: () => void; clearWidget: () => void } {
  const WIDGET_KEY = Symbol.for("pi-workflow-widget-interval");
  let widgetInterval: ReturnType<typeof setInterval> | null = null;

  // 清除旧定时器（/reload 防护）
  const prev = (globalThis as any)[WIDGET_KEY];
  if (prev) clearInterval(prev);

  const updateWidget = () => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(
      "workflow-status",
      (_tui: any, _theme: any) => ({
        invalidate() {},
        render(w: number) {
          return renderWorkflowWidgetLines(getSnapshot(), w);
        },
      }),
      { placement: "aboveEditor" },
    );
  };

  updateWidget();
  widgetInterval = setInterval(updateWidget, 1000);
  (globalThis as any)[WIDGET_KEY] = widgetInterval;

  const clearWidget = () => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
    }
    (globalThis as any)[WIDGET_KEY] = null;
    if (ctx.hasUI) ctx.ui.setWidget("workflow-status", undefined);
  };

  return { updateWidget, clearWidget };
}

/** 创建 runWorkflow 的基础选项（不含回调） */
function createWorkflowRunOptions(opts: {
  cwd: string;
  args?: unknown;
  signal?: AbortSignal;
  concurrency?: number;
  ctx: any;
}) {
  return {
    cwd: opts.cwd,
    args: opts.args,
    signal: opts.signal,
    concurrency: opts.concurrency,
    session: {
      modelRegistry: opts.ctx.modelRegistry,
      model: opts.ctx.model,
    },
    subagent: {
      launchCtx: opts.ctx as any,
      cwd: opts.cwd,
    },
  };
}

/** 创建 runWorkflow 的回调选项 */
function createWorkflowCallbacks(opts: {
  snapshot: () => WorkflowSnapshot;
  setSnapshot: (s: WorkflowSnapshot) => void;
  update: () => void;
  signal?: AbortSignal;
  cwd: string;
  metaName: string;
}) {
  const recordPhase = (title: string | undefined) => {
    if (!title) return;
    const snap = opts.snapshot();
    if (!snap.phases.includes(title)) snap.phases.push(title);
  };

  return {
    onLog(message: string) {
      opts.snapshot().logs.push(message);
      opts.update();
    },
    onPhase(title: string) {
      const snap = opts.snapshot();
      snap.currentPhase = title;
      recordPhase(title);
      opts.update();
    },
    onAgentStart(event: { label: string; phase?: string; prompt: string }) {
      if (opts.signal?.aborted) throw new Error("Workflow was aborted");
      recordPhase(event.phase);
      const snap = opts.snapshot();
      snap.agents.push({
        id: snap.agents.length + 1,
        label: event.label,
        phase: event.phase,
        prompt: event.prompt,
        status: "running",
        startedAt: Date.now(),
      });
      opts.update();
    },
    onAgentEnd(event: { label: string; phase?: string; result: unknown; error?: string }) {
      const snap = opts.snapshot();
      const agent = [...snap.agents].reverse().find((item) => item.label === event.label && item.status === "running");
      if (agent) {
        agent.status = event.result === null ? "error" : "done";
        agent.finishedAt = Date.now();
        if (event.error) agent.error = event.error;
        if (event.result != null) {
          const agentsDir = join(opts.cwd, ".pi", "workflows", opts.metaName, "agents");
          mkdirSync(agentsDir, { recursive: true });
          const safeLabel = agent.label.replace(/[/\\:*?"<>|\s]+/g, "_").slice(0, 32);
          const agentFile = join(agentsDir, `${String(agent.id).padStart(2, "0")}-${safeLabel}.json`);
          writeFileSync(agentFile, JSON.stringify(event.result, null, 2), "utf8");
          agent.resultPreview = `📄 ${agentFile}`;
        }
      }
      opts.update();
    },
  };
}

/** 写入 workflow 结果文件，返回文件路径 */
function writeResultFile(cwd: string, metaName: string, result: unknown): string {
  const outDir = join(cwd, ".pi", "workflows");
  mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outFile = join(outDir, `${metaName}-${ts}.json`);
  writeFileSync(outFile, JSON.stringify(result ?? null, null, 2), "utf8");
  return outFile;
}
