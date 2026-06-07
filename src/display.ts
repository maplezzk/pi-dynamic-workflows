import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowMeta } from "./workflow.js";

export type WorkflowAgentStatus = "queued" | "running" | "done" | "error" | "skipped";

export interface WorkflowAgentSnapshot {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: WorkflowAgentStatus;
  resultPreview?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface WorkflowSnapshot {
  name: string;
  description?: string;
  phases: string[];
  currentPhase?: string;
  logs: string[];
  agents: WorkflowAgentSnapshot[];
  agentCount: number;
  runningCount: number;
  doneCount: number;
  errorCount: number;
  durationMs?: number;
  result?: unknown;
  resultFile?: string;
  startedAt?: number;
}

export interface WorkflowDisplay {
  update(snapshot: WorkflowSnapshot): void;
  complete(snapshot: WorkflowSnapshot): void;
  clear(): void;
}

export interface WorkflowDisplayOptions {
  key?: string;
  placement?: "aboveEditor" | "belowEditor";
  maxAgents?: number;
  maxLogs?: number;
  showStatus?: boolean;
  showResultPreviews?: boolean;
}

export function createWorkflowSnapshot(meta: WorkflowMeta): WorkflowSnapshot {
  return {
    name: meta.name,
    description: meta.description,
    phases: meta.phases?.map((p) => p.title) ?? [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
  };
}

export function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const runningCount = snapshot.agents.filter((agent) => agent.status === "running").length;
  const doneCount = snapshot.agents.filter((agent) => agent.status === "done").length;
  const errorCount = snapshot.agents.filter((agent) => agent.status === "error").length;
  return { ...snapshot, agentCount: snapshot.agents.length, runningCount, doneCount, errorCount };
}

export function createWidgetWorkflowDisplay(
  ctx: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions = {},
): WorkflowDisplay {
  const key = options.key ?? "workflow";
  const placement = options.placement ?? "belowEditor";
  const showStatus = options.showStatus ?? false;

  const render = (snapshot: WorkflowSnapshot, completed = false) => {
    if (!ctx.hasUI) return;
    if (showStatus) ctx.ui.setStatus(key, statusLine(snapshot, completed));
    ctx.ui.setWidget(key, renderWorkflowLines(snapshot, options), { placement });
  };

  return {
    update(snapshot) {
      render(snapshot, false);
    },
    complete(snapshot) {
      render(snapshot, true);
    },
    clear() {
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, undefined);
      ctx.ui.setWidget(key, undefined);
    },
  };
}

export function createToolUpdateWorkflowDisplay(
  onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined,
  ctx?: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions & { streamToolUpdates?: boolean } = {},
): WorkflowDisplay {
  const widget = ctx ? createWidgetWorkflowDisplay(ctx, options) : undefined;
  const streamToolUpdates = options.streamToolUpdates ?? !ctx?.hasUI;

  const emit = (snapshot: WorkflowSnapshot, completed = false) => {
    if (streamToolUpdates) {
      onUpdate?.({
        content: [{ type: "text", text: renderWorkflowText(snapshot, completed, options) }],
        details: snapshot,
      });
    }
    if (completed) widget?.complete(snapshot);
    else widget?.update(snapshot);
  };

  return {
    update(snapshot) {
      emit(snapshot, false);
    },
    complete(snapshot) {
      emit(snapshot, true);
    },
    clear() {
      widget?.clear();
    },
  };
}

export function renderWorkflowLines(snapshot: WorkflowSnapshot, options: WorkflowDisplayOptions = {}): string[] {
  const maxAgents = options.maxAgents ?? 8;
  const maxLogs = options.maxLogs ?? 2;
  const showResultPreviews = options.showResultPreviews ?? false;
  const state =
    snapshot.errorCount > 0
      ? `, ${snapshot.errorCount} errors`
      : snapshot.runningCount > 0
        ? `, ${snapshot.runningCount} running`
        : "";
  const lines = [`◆ Workflow: ${snapshot.name} (${snapshot.doneCount}/${snapshot.agentCount} done${state})`];

  const agentPhaseNames = snapshot.agents
    .map((agent) => agent.phase)
    .filter((phase): phase is string => Boolean(phase));
  const phaseNames = unique([
    ...snapshot.phases,
    ...(snapshot.currentPhase ? [snapshot.currentPhase] : []),
    ...agentPhaseNames,
  ]);
  const rendered = new Set<WorkflowAgentSnapshot>();

  for (const phase of phaseNames) {
    const agents = snapshot.agents.filter((agent) => agent.phase === phase);
    if (agents.length === 0 && snapshot.currentPhase !== phase) continue;
    for (const agent of agents) rendered.add(agent);
    const done = agents.filter((agent) => agent.status === "done").length;
    const running = agents.filter((agent) => agent.status === "running").length;
    const errors = agents.filter((agent) => agent.status === "error").length;
    const skipped = agents.filter((agent) => agent.status === "skipped").length;
    const complete = agents.length > 0 && done + errors + skipped === agents.length;
    const marker = running > 0 || (!complete && snapshot.currentPhase === phase) ? "▶" : complete ? "✓" : " ";
    lines.push(
      `  ${marker} ${phase} ${done}/${agents.length}${running ? ` · ${running} running` : ""}${errors ? ` · ${errors} errors` : ""}${skipped ? ` · ${skipped} skipped` : ""}`,
    );

    const visibleAgents = agents.slice(-maxAgents);
    for (const agent of visibleAgents) {
      const order = `#${agent.id}`;
      const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
      const err = agent.status === "error" && agent.error ? ` [${shorten(agent.error, 80)}]` : "";
      lines.push(`    ${order} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${result}${err}`);
    }
    if (agents.length > visibleAgents.length)
      lines.push(`    … ${agents.length - visibleAgents.length} earlier agents`);
  }

  const unphased = snapshot.agents.filter((agent) => !rendered.has(agent));
  if (unphased.length) {
    lines.push("  Unphased");
    for (const agent of unphased.slice(-maxAgents)) {
      const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
      const err = agent.status === "error" && agent.error ? ` [${shorten(agent.error, 80)}]` : "";
      lines.push(`    #${agent.id} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${result}${err}`);
    }
  }

  const visibleLogs = snapshot.logs.slice(-maxLogs);
  if (visibleLogs.length) {
    if (lines.length > 1) lines.push("");
    for (const log of visibleLogs) lines.push(`  log: ${log}`);
  }

  // 附加最终结果文件路径
  if (snapshot.resultFile && snapshot.runningCount === 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`  📄 总结果：${snapshot.resultFile}`);
  }

  return lines;
}

export function renderWorkflowText(
  snapshot: WorkflowSnapshot,
  completed = false,
  options: WorkflowDisplayOptions = {},
): string {
  const header = completed ? "Workflow completed" : "Workflow running";
  return [header, ...renderWorkflowLines(snapshot, options)].join("\n");
}

// 仿 pi-interactive-subagents 的 formatStatusLine：
// 每行一个 agent 状态，格式：`{label} {state detail} {elapsed}.`
export function formatAgentStatusLine(agent: WorkflowAgentSnapshot, now = Date.now()): string {
  const label = shorten(agent.label, 64);
  const elapsed = agent.startedAt ? ((agent.finishedAt ?? now) - agent.startedAt) / 1000 : 0;
  const elapsedText = `${elapsed.toFixed(1)}s`;
  if (agent.status === "running") {
    return `${label} running ${elapsedText}, active.`;
  }
  if (agent.status === "done") {
    return `${label} finished in ${elapsedText}.`;
  }
  if (agent.status === "error") {
    return `${label} failed after ${elapsedText}${agent.error ? ` (${shorten(agent.error, 60)})` : ""}.`;
  }
  if (agent.status === "skipped") {
    return `${label} skipped.`;
  }
  return `${label} queued.`;
}

// 汇总所有 active agent（queued + running），其他只输出当前 phase 的进行中 agent
export function formatWorkflowStatusAggregate(
  snapshot: WorkflowSnapshot,
  lineLimit = 4,
  now = Date.now(),
): { lines: string[]; overflow: number } {
  const running = snapshot.agents.filter((a) => a.status === "running");
  const queued = snapshot.agents.filter((a) => a.status === "queued");
  const recent = [...running, ...queued].slice(0, lineLimit);
  const lines = recent.map((a) => formatAgentStatusLine(a, now));
  const overflow = Math.max(0, running.length + queued.length - recent.length);
  return { lines, overflow };
}

function statusLine(snapshot: WorkflowSnapshot, completed: boolean): string {
  if (completed) return `workflow ✓ ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount}`;
  if (snapshot.runningCount > 0)
    return `workflow ${snapshot.name}: ${snapshot.runningCount} running, ${snapshot.doneCount}/${snapshot.agentCount} done`;
  return `workflow ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount} done`;
}

function statusIcon(status: WorkflowAgentStatus): string {
  switch (status) {
    case "queued":
      return "○";
    case "running":
      return "●";
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "skipped":
      return "-";
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function shorten(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function preview(value: unknown, max = 200): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "<1s";
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600000) {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

export interface WorkflowTheme {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

export function renderWorkflowThemed(
  snapshot: WorkflowSnapshot,
  theme: WorkflowTheme,
  options: WorkflowDisplayOptions = {},
): string {
  const showResultPreviews = options.showResultPreviews ?? false;
  const maxAgents = options.maxAgents ?? 8;

  const elapsed = snapshot.durationMs ? formatElapsed(snapshot.durationMs) : "";
  const agentSummary = `${snapshot.agentCount} agents`;
  const durationPart = elapsed ? ` · ${elapsed}` : "";

  const lines: string[] = [];

  // Header: ▸ {name} — {agentCount} agents · {duration}
  lines.push(
    `${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(snapshot.name))} ${theme.fg("dim", `— ${agentSummary}${durationPart}`)}`,
  );
  lines.push("");

  // Group agents by phase
  const agentPhaseNames = snapshot.agents
    .map((agent) => agent.phase)
    .filter((phase): phase is string => Boolean(phase));
  const phaseNames = unique([
    ...snapshot.phases,
    ...(snapshot.currentPhase ? [snapshot.currentPhase] : []),
    ...agentPhaseNames,
  ]);
  const rendered = new Set<WorkflowAgentSnapshot>();

  for (const phase of phaseNames) {
    const agents = snapshot.agents.filter((agent) => agent.phase === phase);
    if (agents.length === 0 && snapshot.currentPhase !== phase) continue;
    for (const agent of agents) rendered.add(agent);

    const done = agents.filter((a) => a.status === "done").length;
    const running = agents.filter((a) => a.status === "running").length;
    const errors = agents.filter((a) => a.status === "error").length;
    const skipped = agents.filter((a) => a.status === "skipped").length;
    const complete = agents.length > 0 && done + errors + skipped === agents.length;

    // Phase icon
    let phaseIcon: string;
    if (complete) {
      phaseIcon = theme.fg("success", "✓");
    } else if (running > 0 || snapshot.currentPhase === phase) {
      phaseIcon = theme.fg("accent", "▶");
    } else {
      phaseIcon = theme.fg("dim", "○");
    }

    // Phase duration: first agent startedAt → last agent finishedAt
    const phaseElapsed = computePhaseDuration(agents);
    const phaseDurationText = phaseElapsed ? theme.fg("dim", formatElapsed(phaseElapsed)) : "";

    lines.push(`  ${phaseIcon} ${phase}${phaseDurationText ? `  ${phaseDurationText}` : ""}`);

    // Agents in this phase
    const visibleAgents = agents.slice(-maxAgents);
    for (const agent of visibleAgents) {
      const order = `#${agent.id}`;
      const icon = themedStatusIcon(agent.status, theme);
      const label = theme.fg("toolOutput", shorten(agent.label, 48));
      const agentElapsed = computeAgentDuration(agent);
      const agentDurationText = agentElapsed ? `  ${theme.fg("dim", formatElapsed(agentElapsed))}` : "";
      const err =
        agent.status === "error" && agent.error ? ` ${theme.fg("error", `[${shorten(agent.error, 60)}]`)}` : "";
      lines.push(`    ${order} ${icon} ${label}${agentDurationText}${err}`);

      // Result preview (file path)
      if (showResultPreviews && agent.resultPreview) {
        lines.push(`         ${theme.fg("muted", agent.resultPreview)}`);
      }
    }
    if (agents.length > visibleAgents.length) {
      lines.push(`    ${theme.fg("dim", `… ${agents.length - visibleAgents.length} earlier agents`)}`);
    }
  }

  // Unphased agents
  const unphased = snapshot.agents.filter((agent) => !rendered.has(agent));
  if (unphased.length) {
    lines.push(`  ${theme.fg("dim", "Unphased")}`);
    for (const agent of unphased.slice(-maxAgents)) {
      const icon = themedStatusIcon(agent.status, theme);
      const label = theme.fg("toolOutput", shorten(agent.label, 48));
      const agentElapsed = computeAgentDuration(agent);
      const agentDurationText = agentElapsed ? `  ${theme.fg("dim", formatElapsed(agentElapsed))}` : "";
      const err =
        agent.status === "error" && agent.error ? ` ${theme.fg("error", `[${shorten(agent.error, 60)}]`)}` : "";
      lines.push(`    #${agent.id} ${icon} ${label}${agentDurationText}${err}`);
      if (showResultPreviews && agent.resultPreview) {
        lines.push(`         ${theme.fg("muted", agent.resultPreview)}`);
      }
    }
  }

  // Result file
  if (snapshot.resultFile) {
    lines.push("");
    lines.push(`  ${theme.fg("muted", `📄 ${snapshot.resultFile}`)}`);
  }

  return lines.join("\n");
}

function themedStatusIcon(status: WorkflowAgentStatus, theme: WorkflowTheme): string {
  switch (status) {
    case "done":
      return theme.fg("success", "✓");
    case "error":
      return theme.fg("error", "✗");
    case "running":
      return theme.fg("accent", "●");
    case "queued":
      return theme.fg("dim", "○");
    case "skipped":
      return theme.fg("dim", "-");
  }
}

/**
 * 渲染带边框的 Widget 状态栏行（用于 aboveEditor widget）。
 * 使用 box-drawing 字符和硬编码 ANSI 色彩。
 */
export function renderWorkflowWidgetLines(snapshot: WorkflowSnapshot, width: number): string[] {
  const ACCENT = "\x1b[38;2;77;163;255m";
  const RST = "\x1b[0m";
  const GREEN = "\x1b[32m";
  const CYAN = "\x1b[36m";
  const RED = "\x1b[31m";
  const DIM = "\x1b[90m";

  const MAX_VISIBLE_AGENTS = 6;
  const boxWidth = Math.max(50, width);
  const innerWidth = boxWidth - 2; // exclude │ on each side

  // CJK 双宽字符检测
  const charWidth = (code: number): number => {
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x2fffd) ||
      (code >= 0x30000 && code <= 0x3fffd)
    )
      return 2;
    return 1;
  };

  const strWidth = (str: string): number => {
    let w = 0;
    for (const ch of str) {
      w += charWidth(ch.codePointAt(0) ?? 0);
    }
    return w;
  };

  // Helper: pad content line to fit inside box
  const padLine = (content: string, rawLen: number): string => {
    const padding = Math.max(0, innerWidth - rawLen);
    return `${ACCENT}│${RST}${content}${" ".repeat(padding)}${ACCENT}│${RST}`;
  };

  // Title line: ╭─ Workflow: {name} ──── {done}/{total} done ─╮
  const titleText = ` Workflow: ${snapshot.name} `;
  const statsText = ` ${snapshot.doneCount}/${snapshot.agentCount} done `;
  const fillLen = Math.max(1, boxWidth - 2 - titleText.length - statsText.length - 2); // -2 for ╭╮, -2 for ─ on edges
  const topLine = `${ACCENT}╭─${titleText}${"─".repeat(fillLen)}${statsText}─╮${RST}`;

  // Bottom line
  const bottomLine = `${ACCENT}╰${"─".repeat(boxWidth - 2)}╯${RST}`;

  const lines: string[] = [topLine];

  // Group agents by phase
  const agentPhaseNames = snapshot.agents.map((a) => a.phase).filter((p): p is string => Boolean(p));
  const phaseNames = unique([
    ...snapshot.phases,
    ...(snapshot.currentPhase ? [snapshot.currentPhase] : []),
    ...agentPhaseNames,
  ]);
  const rendered = new Set<WorkflowAgentSnapshot>();

  for (const phase of phaseNames) {
    const agents = snapshot.agents.filter((a) => a.phase === phase);
    for (const a of agents) rendered.add(a);

    const done = agents.filter((a) => a.status === "done").length;
    const running = agents.filter((a) => a.status === "running").length;
    const errors = agents.filter((a) => a.status === "error").length;
    const skipped = agents.filter((a) => a.status === "skipped").length;
    const complete = agents.length > 0 && done + errors + skipped === agents.length;

    // Phase icon
    let phaseIcon: string;
    if (complete) {
      phaseIcon = `${GREEN}✓${RST}`;
    } else if (running > 0 || snapshot.currentPhase === phase) {
      phaseIcon = `${CYAN}▶${RST}`;
    } else {
      phaseIcon = `${DIM}○${RST}`;
    }

    const phaseContent = `  ${phaseIcon} ${phase}`;
    const phaseRawLen = 2 + 1 + 1 + strWidth(phase); // "  " + icon + " " + name
    lines.push(padLine(phaseContent, phaseRawLen));

    // Agents in this phase
    const visibleAgents = agents.slice(-MAX_VISIBLE_AGENTS);
    for (const agent of visibleAgents) {
      const order = `#${agent.id}`;
      const { icon } = widgetStatusIcon(agent.status);
      const label = shorten(agent.label, innerWidth - 20);
      const agentElapsed = computeAgentDuration(agent);
      const elapsedText = agentElapsed ? formatElapsed(agentElapsed) : "";

      // 右侧状态文字 + 耗时
      const statusLabel =
        agent.status === "done"
          ? "done"
          : agent.status === "running"
            ? "running"
            : agent.status === "error"
              ? "error"
              : "";
      const rightText = elapsedText ? `${statusLabel} ${elapsedText}` : statusLabel;
      const leftPart = `    ${order} ${icon} ${label}`;
      const leftRawLen = 4 + order.length + 1 + 1 + 1 + strWidth(label);
      const statusColor =
        agent.status === "done" ? GREEN : agent.status === "running" ? CYAN : agent.status === "error" ? RED : DIM;
      const rightPart = rightText ? `${statusColor}${rightText}${RST}` : "";
      const rightRawLen = rightText.length;

      const gapLen = Math.max(1, innerWidth - leftRawLen - rightRawLen);
      const agentLine = `${leftPart}${" ".repeat(gapLen)}${rightPart}`;
      const agentRawLen = leftRawLen + gapLen + rightRawLen;
      lines.push(padLine(agentLine, agentRawLen));
    }
    if (agents.length > visibleAgents.length) {
      const moreText = `    … ${agents.length - visibleAgents.length} earlier`;
      lines.push(padLine(`  ${DIM}${moreText}${RST}`, 2 + moreText.length));
    }
  }

  // Unphased agents
  const unphased = snapshot.agents.filter((a) => !rendered.has(a));
  if (unphased.length) {
    const visibleAgents = unphased.slice(-MAX_VISIBLE_AGENTS);
    for (const agent of visibleAgents) {
      const order = `#${agent.id}`;
      const { icon } = widgetStatusIcon(agent.status);
      const label = shorten(agent.label, innerWidth - 20);
      const agentElapsed = computeAgentDuration(agent);
      const elapsedText = agentElapsed ? formatElapsed(agentElapsed) : "";

      const statusLabel =
        agent.status === "done"
          ? "done"
          : agent.status === "running"
            ? "running"
            : agent.status === "error"
              ? "error"
              : "";
      const rightText = elapsedText ? `${statusLabel} ${elapsedText}` : statusLabel;
      const leftPart = `    ${order} ${icon} ${label}`;
      const leftRawLen = 4 + order.length + 1 + 1 + 1 + strWidth(label);
      const statusColor =
        agent.status === "done" ? GREEN : agent.status === "running" ? CYAN : agent.status === "error" ? RED : DIM;
      const rightPart = rightText ? `${statusColor}${rightText}${RST}` : "";
      const rightRawLen = rightText.length;

      const gapLen = Math.max(1, innerWidth - leftRawLen - rightRawLen);
      const agentLine = `${leftPart}${" ".repeat(gapLen)}${rightPart}`;
      const agentRawLen = leftRawLen + gapLen + rightRawLen;
      lines.push(padLine(agentLine, agentRawLen));
    }
    if (unphased.length > visibleAgents.length) {
      const moreText = `    … ${unphased.length - visibleAgents.length} earlier`;
      lines.push(padLine(`  ${DIM}${moreText}${RST}`, 2 + moreText.length));
    }
  }

  lines.push(bottomLine);
  return lines;
}

function widgetStatusIcon(status: WorkflowAgentStatus): { icon: string; iconRaw: string } {
  const GREEN = "\x1b[32m";
  const CYAN = "\x1b[36m";
  const RED = "\x1b[31m";
  const DIM = "\x1b[90m";
  const RST = "\x1b[0m";
  switch (status) {
    case "done":
      return { icon: `${GREEN}✓${RST}`, iconRaw: "✓" };
    case "running":
      return { icon: `${CYAN}●${RST}`, iconRaw: "●" };
    case "error":
      return { icon: `${RED}✗${RST}`, iconRaw: "✗" };
    case "queued":
      return { icon: `${DIM}○${RST}`, iconRaw: "○" };
    case "skipped":
      return { icon: `${DIM}-${RST}`, iconRaw: "-" };
  }
}

function computePhaseDuration(agents: WorkflowAgentSnapshot[]): number | undefined {
  const starts = agents.map((a) => a.startedAt).filter((t): t is number => t != null);
  const ends = agents.map((a) => a.finishedAt).filter((t): t is number => t != null);
  if (starts.length === 0 || ends.length === 0) return undefined;
  const duration = Math.max(...ends) - Math.min(...starts);
  return duration > 0 ? duration : undefined;
}

function computeAgentDuration(agent: WorkflowAgentSnapshot): number | undefined {
  if (!agent.startedAt) return undefined;
  const end = agent.finishedAt ?? Date.now();
  const duration = end - agent.startedAt;
  return duration > 0 ? duration : undefined;
}
