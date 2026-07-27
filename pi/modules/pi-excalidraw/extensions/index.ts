import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  agentRequest,
  assertRoomId,
  fileMetadata,
  loadConfig,
  ownershipFields,
  type AgentResponse,
  type HomeClientConfig,
  type RoomSummary,
} from "../src/home-client.ts";

/**
 * Pi extension entry point for @isaaclins/pi-excalidraw.
 *
 * Ports Disclaw's home Excalidraw MCP surface (create/attach/batch-create/
 * describe/clear/export) to native Pi tools. Disclaw spawns
 * compose/excalidraw-agent/src/mcp.js over stdio on the homeserver; Pi runs on
 * the laptop, so the same HTTP calls go through SSH instead. Tool names and
 * semantics stay 1:1 with the MCP tools so guidance written for one applies to
 * the other.
 */

const ELEMENTS_SCHEMA = Type.Array(Type.Any(), {
  description:
    "Excalidraw-style elements. Shapes: {type:'rectangle'|'ellipse'|'diamond', x, y, width?, height?, text?, backgroundColor?, strokeColor?}. Text: {type:'text', x, y, text, fontSize?}. Arrows: {type:'arrow', start:{id:'<elementId>'}, end:{id:'<elementId>'}, text?, orthogonal?} or explicit {x, y, points:[[0,0],[dx,dy]]}. Shape 'text' becomes a bound label; ids you set are used for arrow binding.",
});

function summarize(title: string, room: RoomSummary | undefined, extra?: Record<string, unknown>): string {
  const lines = [title];
  if (room) {
    lines.push(
      "",
      `room: ${room.id}`,
      `title: ${room.title}`,
      `elements: ${room.elementCount}`,
      `preview (public, read-only): ${room.publicReadOnlyUrl}`,
      `edit (SSO login): ${room.authenticatedEditUrl}`,
    );
  }
  if (extra) lines.push("", JSON.stringify(extra, null, 2));
  return lines.join("\n");
}

function ok(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text", text }], details };
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `Excalidraw error: ${message}` }], details: { error: message } };
}

export default function (pi: ExtensionAPI) {
  const config: HomeClientConfig = loadConfig();
  let activeRoom: string | undefined;

  pi.on("session_start", async () => {
    activeRoom = undefined;
  });

  const roomFrom = (params: { room?: string }): string | undefined => {
    const room = params.room?.trim() || activeRoom;
    return room ? assertRoomId(room) : undefined;
  };

  const remember = (response: AgentResponse): RoomSummary | undefined => {
    if (response.room?.id) activeRoom = response.room.id;
    return response.room;
  };

  const ensureRoom = async (params: { room?: string; title?: string; forUser?: string }, signal?: AbortSignal) => {
    const existing = roomFrom(params);
    if (existing) return existing;
    const created = await agentRequest(config, "POST", "/api/rooms", {
      title: params.title || "Pi diagram",
      ...ownershipFields(config, params.forUser),
    }, signal);
    return remember(created)!.id;
  };

  pi.registerTool({
    name: "excalidraw_create_board",
    label: "Excalidraw: create board",
    description:
      "Create a new board in the home.isaaclins.com Excalidraw editor and make it the active board. Returns a public read-only preview URL and an SSO-gated edit URL. Use this whenever a diagram, architecture sketch, flow, or visual explanation would beat prose.",
    promptSnippet: "Create a home Excalidraw board for visual explanations, diagrams, and architecture sketches.",
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Board title shown in the board library" })),
      forUser: Type.Optional(Type.String({
        description:
          "home.isaaclins.com SSO username who should own the board (defaults to the configured owner, normally 'isaaclins'). Pass another handle when building the board for someone else.",
      })),
      elements: Type.Optional(ELEMENTS_SCHEMA),
      files: Type.Optional(Type.Any({ description: "Excalidraw binary files map for image elements" })),
      appState: Type.Optional(Type.Any({ description: "Excalidraw app state to persist with the scene" })),
    }),
    async execute(_id, params, signal) {
      try {
        const response = await agentRequest(config, "POST", "/api/rooms", {
          title: params.title || "Pi diagram",
          elements: params.elements,
          files: params.files,
          appState: params.appState,
          ...ownershipFields(config, params.forUser),
        }, signal);
        const room = remember(response);
        return ok(summarize("Created Excalidraw board.", room), { room });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "excalidraw_attach_board",
    label: "Excalidraw: attach board",
    description:
      "Attach to an existing home Excalidraw room, preview, edit, or /excalidraw/boards/... link so it becomes the active board and can be inspected or extended. Use this when Isaac sends a home Excalidraw link and asks to add to or explain it.",
    parameters: Type.Object({
      roomUrl: Type.String({ description: "A home.isaaclins.com excalidraw preview/edit/board/app#room link" }),
      title: Type.Optional(Type.String()),
      forUser: Type.Optional(Type.String({ description: "SSO username to register the board to" })),
      elements: Type.Optional(ELEMENTS_SCHEMA),
    }),
    async execute(_id, params, signal) {
      try {
        const response = await agentRequest(config, "POST", "/api/attach", {
          roomUrl: params.roomUrl,
          title: params.title,
          elements: params.elements,
          ...ownershipFields(config, params.forUser),
        }, signal);
        const room = remember(response);
        return ok(summarize("Attached Excalidraw board.", room), { room });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "excalidraw_add_elements",
    label: "Excalidraw: add elements",
    description:
      "Append or replace elements on a board (creates one first if none is active). Shape labels, arrow binding, and Excalidraw defaults are filled in server-side, so send only the meaningful fields.",
    promptSnippet: "Draw shapes, labels, and bound arrows onto the active home Excalidraw board.",
    parameters: Type.Object({
      elements: ELEMENTS_SCHEMA,
      room: Type.Optional(Type.String({ description: "Board id; defaults to the active board" })),
      mode: Type.Optional(Type.Union([Type.Literal("append"), Type.Literal("replace")], {
        description: "append (default) keeps existing elements; replace swaps the whole scene",
      })),
      title: Type.Optional(Type.String()),
      files: Type.Optional(Type.Any()),
      appState: Type.Optional(Type.Any()),
    }),
    async execute(_id, params, signal) {
      try {
        const room = await ensureRoom(params, signal);
        const response = await agentRequest(config, "POST", `/api/rooms/${encodeURIComponent(room)}/elements`, {
          elements: params.elements,
          mode: params.mode || "append",
          title: params.title,
          files: params.files,
          appState: params.appState,
        }, signal);
        const updated = remember(response);
        return ok(summarize("Updated Excalidraw board.", updated), { room: updated });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "excalidraw_describe_board",
    label: "Excalidraw: describe board",
    description:
      "Read back a board: metadata plus every current element, so layout can be checked and refined before sharing the link.",
    parameters: Type.Object({
      room: Type.Optional(Type.String({ description: "Board id; defaults to the active board" })),
    }),
    async execute(_id, params, signal) {
      try {
        const room = roomFrom(params);
        if (!room) return fail(new Error("No active Excalidraw board. Create or attach one first."));
        const response = await agentRequest(config, "GET", `/api/rooms/${encodeURIComponent(room)}`, undefined, signal);
        const summary = remember(response);
        return ok(
          summarize("Current Excalidraw board.", summary, {
            elements: response.elements,
            files: fileMetadata(response.files as Record<string, any>),
            appState: response.appState,
          }),
          { room: summary, elementCount: summary?.elementCount },
        );
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "excalidraw_clear_board",
    label: "Excalidraw: clear board",
    description: "Mark every element on a board deleted, leaving the board and its links intact.",
    parameters: Type.Object({
      room: Type.Optional(Type.String({ description: "Board id; defaults to the active board" })),
    }),
    async execute(_id, params, signal) {
      try {
        const room = roomFrom(params);
        if (!room) return fail(new Error("No active Excalidraw board. Create or attach one first."));
        const response = await agentRequest(config, "POST", `/api/rooms/${encodeURIComponent(room)}/clear`, {}, signal);
        return ok(summarize("Cleared Excalidraw board.", remember(response)));
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "excalidraw_board_url",
    label: "Excalidraw: share URL",
    description:
      "Return the public read-only preview URL and the SSO edit URL for a board, creating one if none exists. These home URLs are the only diagram links to share; never link excalidraw.com.",
    parameters: Type.Object({
      room: Type.Optional(Type.String({ description: "Board id; defaults to the active board" })),
      title: Type.Optional(Type.String()),
      forUser: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal) {
      try {
        const room = await ensureRoom(params, signal);
        const response = await agentRequest(config, "GET", `/api/rooms/${encodeURIComponent(room)}`, undefined, signal);
        const summary = remember(response);
        return ok(summarize("Home Excalidraw URLs.", summary), { room: summary });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "excalidraw_list_boards",
    label: "Excalidraw: list boards",
    description: "List the Excalidraw rooms the home agent bridge currently knows about, newest first.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max boards to list (default 20)" })),
    }),
    async execute(_id, params, signal) {
      try {
        const response = await agentRequest(config, "GET", "/api/rooms", undefined, signal);
        const rooms = (response.rooms || []).slice(0, params.limit ?? 20);
        const text = rooms.length
          ? rooms.map((room) => `- ${room.id}  ${room.title} (${room.elementCount} elements)\n  ${room.publicReadOnlyUrl}`).join("\n")
          : "No boards on the bridge yet.";
        return ok(text, { count: rooms.length });
      } catch (error) {
        return fail(error);
      }
    },
  });
}
