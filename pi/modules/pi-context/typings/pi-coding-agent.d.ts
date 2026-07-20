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

  export interface SessionManager {
    getBranch(): unknown;
  }

  export interface ExtensionUI {
    notify(message: string, level: "info" | "warning" | "error"): void;
  }

  export interface ExtensionContext {
    hasUI: boolean;
    ui: ExtensionUI;
    model?: ModelInfo;
    sessionManager: SessionManager;
    getContextUsage(): ContextUsage | null;
    getSystemPromptOptions(): SystemPromptOptions;
    getSystemPrompt(): string;
    compact(options: { onError?: (error: Error) => void }): void;
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
    registerTool(tool: {
      name: string;
      label: string;
      description: string;
      parameters: unknown;
      execute(
        toolCallId: string,
        params: any,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<unknown>,
        ctx?: ExtensionContext,
      ): Promise<AgentToolResult>;
    }): void;
    registerCommand(
      name: string,
      command: {
        description: string;
        handler: (args: string | undefined, ctx: ExtensionContext) => Promise<void>;
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
    getActiveTools(): string[];
    getAllTools(): ToolDef[];
  }
}
