declare module "@earendil-works/pi-coding-agent" {
  export interface ToolResult {
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
  }

  export interface ToolDefinition {
    name: string;
    label?: string;
    description: string;
    promptSnippet?: string;
    parameters: unknown;
    execute(
      toolCallId: string,
      params: any,
      signal?: AbortSignal,
      onUpdate?: (partial: ToolResult) => void,
    ): Promise<ToolResult>;
  }

  export interface ExtensionAPI {
    registerTool(tool: ToolDefinition): void;
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  }

  export interface ExtensionContext {
    hasUI: boolean;
  }
}
