declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionEvent {
    systemPrompt: string;
  }
  export interface ExtensionContext {
    ui: { notify(message: string, level: string): void };
  }
  export interface ToolResult {
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  }
  export interface ExtensionAPI {
    on(
      event: "session_start" | "turn_end" | "agent_end",
      handler: (event?: any, ctx?: ExtensionContext) => Promise<void>,
    ): void;
    on(
      event: "before_agent_start",
      handler: (event: ExtensionEvent, ctx?: ExtensionContext) => Promise<{ systemPrompt: string } | void>,
    ): void;
    registerTool(tool: {
      name: string;
      label: string;
      description: string;
      parameters: unknown;
      execute(toolCallId: string, params: any): Promise<ToolResult>;
    }): void;
    registerCommand(name: string, command: { description: string; handler: (args: string | undefined, ctx: ExtensionContext) => Promise<void> }): void;
  }
}
