declare module "@earendil-works/pi-coding-agent" {
  export interface ContextUsage {
    tokens: number | null;
    contextWindow: number;
  }

  export interface SystemPromptOptions {
    contextFiles?: Array<{ content?: string }>;
    skills?: Array<{ name?: string; description?: string }>;
  }

  export interface ModelInfo {
    id: string;
    name?: string;
    provider: string;
  }

  export interface SessionEntry {
    type: string;
    customType?: string;
    data?: unknown;
  }

  export interface SessionManager {
    getBranch(): SessionEntry[];
  }

  export interface ExtensionUI {
    notify(message: string, level: "info" | "warning" | "error"): void;
    setStatus(key: string, value: string | undefined): void;
    theme: Theme;
  }

  export interface ExtensionContext {
    hasUI: boolean;
    ui: ExtensionUI;
    model?: ModelInfo;
    sessionManager: SessionManager;
    getContextUsage(): ContextUsage | null;
    getSystemPromptOptions(): SystemPromptOptions;
    getSystemPrompt(): string;
    isIdle(): boolean;
    abort(): void;
    compact(options: { onError?: (error: Error) => void }): void;
  }

  export interface ExtensionCommandContext extends ExtensionContext {
    waitForIdle(): Promise<void>;
  }

  export interface CompactionPreparation {
    fileOps?: unknown;
    firstKeptEntryId?: string;
    tokensBefore?: number;
  }

  export interface SessionBeforeCompactEvent {
    preparation: CompactionPreparation;
  }

  export interface ToolDef {
    name: string;
    description: string;
    parameters?: unknown;
  }

  export interface MessageOptions {
    customType: string;
    content: string;
    display: boolean;
    details?: unknown;
  }

  export interface SendMessageOptions {
    triggerTurn?: boolean;
  }

  export interface MessageRendererMessage {
    details?: unknown;
  }

  export interface Theme {
    fg(color: string, text: string): string;
    bold(text: string): string;
  }

  export interface RendererResult {
    render(width: number): string[];
    invalidate(): void;
  }

  export interface AgentToolUpdateCallback<T> {
    (update: T): void;
  }

  export interface AgentToolResult<T = unknown> {
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  }

  export interface ExtensionAPI {
    on(
      event: "turn_end",
      handler: (event: unknown, ctx: ExtensionContext) => Promise<void>,
    ): void;
    on(
      event: "session_before_compact",
      handler: (event: SessionBeforeCompactEvent) => Promise<unknown>,
    ): void;
    on(
      event: "session_compact",
      handler: (event: unknown, ctx: ExtensionContext) => Promise<void>,
    ): void;
    on(
      event: "before_agent_start",
      handler: (
        event: { systemPrompt: string },
        ctx: ExtensionContext,
      ) => Promise<{ systemPrompt?: string } | undefined>,
    ): void;
    on(
      event: "session_start",
      handler: (event: unknown, ctx: ExtensionContext) => Promise<void>,
    ): void;
    on(
      event: "turn_start",
      handler: (event: { turnIndex?: number }, ctx: ExtensionContext) => Promise<void>,
    ): void;
    on(
      event: "tool_execution_end",
      handler: (event: { toolName?: string }, ctx: ExtensionContext) => Promise<void>,
    ): void;
    on(
      event: "session_tree",
      handler: (event: unknown, ctx: ExtensionContext) => Promise<void>,
    ): void;
    on(
      event: "tool_call",
      handler: (
        event: { toolName: string; input: unknown },
        ctx: ExtensionContext,
      ) => Promise<{ block: true; reason: string } | undefined>,
    ): void;
    registerTool(tool: {
      name: string;
      label: string;
      description: string;
      promptSnippet?: string;
      promptGuidelines?: string[];
      parameters: unknown;
      execute(
        toolCallId: string,
        params: any,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<unknown>,
        ctx?: ExtensionContext,
      ): Promise<AgentToolResult>;
      renderShell?: "default" | "self";
    }): void;
    registerCommand(
      name: string,
      command: {
        description: string;
        getArgumentCompletions?: (
          prefix: string,
        ) => Array<{ value: string; label: string }> | null;
        handler: (args: string | undefined, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ): void;
    registerMessageRenderer(
      type: string,
      renderer: (
        message: MessageRendererMessage,
        options: unknown,
        theme: Theme,
      ) => RendererResult | undefined,
    ): void;
    registerShortcut(
      key: string,
      shortcut: {
        description: string;
        handler: (ctx: ExtensionContext) => Promise<void>;
      },
    ): void;
    sendMessage(message: MessageOptions, options?: SendMessageOptions): void;
    sendUserMessage(text: string): void;
    appendEntry<T>(customType: string, data: T): void;
    registerFlag(
      name: string,
      options: { description: string; type: "boolean"; default?: boolean },
    ): void;
    getFlag(name: string): unknown;
    getActiveTools(): string[];
    getAllTools(): ToolDef[];
    setActiveTools(toolNames: string[]): void;
  }
}
