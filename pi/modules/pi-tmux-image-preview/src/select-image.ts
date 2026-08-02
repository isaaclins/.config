import type { ImageBlock, TextBlock } from "./types.ts";

const MAX_NOTE_LENGTH = 120;

export type ToolResultLike = {
  toolName: string;
  isError?: boolean;
  content: unknown;
};

export function findRenderableImage(content: unknown): ImageBlock | undefined {
  if (!Array.isArray(content)) return undefined;
  return content.find(
    (part): part is ImageBlock =>
      Boolean(part && part.type === "image" && part.data && part.mimeType),
  );
}

export function selectToolResultImage(
  event: ToolResultLike,
): ImageBlock | undefined {
  if (event.isError) return undefined;
  return findRenderableImage(event.content);
}

export function textBlocksOnly(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is TextBlock => Boolean(part && part.type === "text"))
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

export function previewNote(toolName: string, content: unknown): string {
  const text = textBlocksOnly(content);
  if (toolName === "read") {
    return text || "Read image file";
  }

  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const summary = firstLine ? truncate(firstLine, MAX_NOTE_LENGTH) : "";
  return summary ? `${toolName}: ${summary}` : `${toolName} image`;
}
