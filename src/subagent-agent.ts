/**
 * SubagentWorkflowAgent — workflow backend backed by pi-interactive-subagents.
 *
 * Activated when PI_WORKFLOW_BACKEND=subagent.  Uses launchSubagent / watchSubagent
 * to run each agent() call as a separate tmux-pane subagent with real tool access.
 * Structured output is enforced via the subagent's structured_output tool (ajv validation)
 * rather than the in-memory session's structured_output mechanism.
 */

// ── types lifted from pi-interactive-subagents ──
interface SubagentCtx {
  sessionManager: {
    getSessionFile(): string | null;
    getSessionId(): string;
    getSessionDir(): string;
  };
  cwd: string;
  model?: unknown;
  modelRegistry?: unknown;
  [key: string]: unknown;
}

/** Mirror of pi-interactive-subagents' RunningSubagent (subset we care about). */
interface RunningSubagent {
  id: string;
  name: string;
  surface: string;
  sessionFile: string;
  startTime: number;
}

/** Mirror of pi-interactive-subagents' SubagentResult. */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  exitCode: number;
  elapsed: number;
  structuredOutput?: unknown;
}

// ── subagent API (lazily resolved from globalThis) ──
interface SubagentApi {
  launchSubagent(
    params: Record<string, unknown>,
    ctx: SubagentCtx,
    options?: { surface?: string },
  ): Promise<RunningSubagent>;
  watchSubagent(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult>;
}

function getSubagentApi(): SubagentApi {
  const api = (globalThis as any).__pi_subagents;
  if (!api) {
    throw new Error(
      "PI_WORKFLOW_BACKEND=subagent 需要 pi-interactive-subagents 扩展。\n" +
        "安装: pi install pi-interactive-subagents",
    );
  }
  return api as SubagentApi;
}

// ── options ──
export interface SubagentWorkflowAgentOptions {
  cwd?: string;
  /** Pi extension context (passed from workflow-tool execute callback). */
  launchCtx: SubagentCtx;
  /** Model override for subagent sessions (string id, not Model object). */
  model?: string;
  /** Extra instructions prepended to every agent() prompt. */
  instructions?: string;
}

export interface AgentRunOptions {
  label?: string;
  schema?: unknown;
  signal?: AbortSignal;
  instructions?: string;
}

export type AgentRunResult = unknown;

// ── agent ──
export class SubagentWorkflowAgent {
  private readonly cwd: string;
  private readonly launchCtx: SubagentCtx;
  private readonly model?: string;
  private readonly instructions?: string;

  constructor(options: SubagentWorkflowAgentOptions) {
    this.cwd = options.cwd ?? process.cwd();
    this.launchCtx = options.launchCtx;
    this.model = options.model;
    this.instructions = options.instructions;
  }

  async run(prompt: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    const api = getSubagentApi();

    const taskParts = [
      this.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt,
    ].filter(Boolean);
    const task = taskParts.join("\n\n");

    const running = await api.launchSubagent(
      {
        name: options.label ?? "workflow-agent",
        task,
        model: this.model,
        cwd: this.cwd,
        ...(options.schema ? { structuredOutputSchema: options.schema } : {}),
      },
      this.launchCtx,
    );

    // Create abort signal that combines caller's signal with module-level abort
    const abortController = new AbortController();
    let removeAbort: (() => void) | undefined;
    if (options.signal) {
      if (options.signal.aborted) {
        throw new Error("Subagent was aborted");
      }
      const onAbort = () => abortController.abort();
      options.signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => options.signal?.removeEventListener("abort", onAbort);
    }

    try {
      const result = await api.watchSubagent(running, abortController.signal);

      if (options.signal?.aborted) throw new Error("Subagent was aborted");

      if (options.schema) {
        if (result.structuredOutput === undefined) {
          throw new Error("Subagent finished without calling structured_output");
        }
        return result.structuredOutput as AgentRunResult;
      }

      return result.summary as AgentRunResult;
    } finally {
      removeAbort?.();
    }
  }
}
