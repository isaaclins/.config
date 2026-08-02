import {
  convertToPng,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  getCellDimensions,
  getImageDimensions,
  Text,
} from "@earendil-works/pi-tui";
import { downscalePngWithSips } from "./image-resize.ts";
import { PreviewStore } from "./preview-store.ts";
import {
  previewNote,
  selectToolResultImage,
} from "./select-image.ts";
import {
  buildDeleteSequence,
  buildPlaceholderLines,
  buildTransmitSequence,
  randomImageId,
  tmuxEnvironment,
  tmuxPassthroughEnabled,
} from "./protocol.ts";
import type {
  CellSize,
  ImageBlock,
  ImageDimensions,
  PreviewTheme,
  StoredImagePreview,
  TmuxImagePreviewData,
  TmuxSupport,
} from "./types.ts";

const MAX_PREVIEWS = 16;
const DEFAULT_MAX_WIDTH_CELLS = 60;
const MAX_PREVIEW_SOURCE_DIMENSION_PX = 1600;
const CUSTOM_ENTRY_TYPE = "pi-tmux-image-preview:entry";

const previews = new PreviewStore(MAX_PREVIEWS);
const transmittedImageIds = new Set<number>();
const emittedDiagnostics = new Set<string>();
let cachedTmuxSupport: TmuxSupport | undefined;

function isInTmux(): boolean {
  return (
    Boolean(process.env.TMUX) ||
    (process.env.TERM ?? "").toLowerCase().startsWith("tmux")
  );
}

function detectTmuxSupport(): TmuxSupport {
  if (cachedTmuxSupport) return cachedTmuxSupport;
  if (!isInTmux() || !tmuxPassthroughEnabled()) {
    cachedTmuxSupport = "unsupported";
    return cachedTmuxSupport;
  }

  const termProgram = (tmuxEnvironment("TERM_PROGRAM") ?? "").toLowerCase();
  cachedTmuxSupport =
    termProgram === "ghostty" || termProgram === "kitty"
      ? "kitty"
      : "unsupported";
  return cachedTmuxSupport;
}

function supportDiagnostic(): string | undefined {
  if (!isInTmux()) return undefined;
  if (!tmuxPassthroughEnabled()) {
    return "Image preview needs `set -g allow-passthrough on` in tmux.conf, followed by a tmux server restart.";
  }

  const termProgram = tmuxEnvironment("TERM_PROGRAM");
  if (!termProgram) {
    return "Image preview could not detect the outer terminal. Add TERM_PROGRAM to tmux update-environment and reattach the client.";
  }
  if (!["ghostty", "kitty"].includes(termProgram.toLowerCase())) {
    return `Image preview supports Ghostty or Kitty outside tmux; detected ${termProgram}.`;
  }
  return undefined;
}

function isTmuxImagePreviewData(data: unknown): data is TmuxImagePreviewData {
  return Boolean(
    data &&
      typeof data === "object" &&
      typeof (data as TmuxImagePreviewData).previewId === "string",
  );
}

function calculateImageCellSize(
  imageDimensions: ImageDimensions,
  maxWidthCells: number,
  maxHeightCells: number,
  cellDimensions: { widthPx: number; heightPx: number },
): CellSize {
  const imageWidth = Math.max(1, imageDimensions.widthPx);
  const imageHeight = Math.max(1, imageDimensions.heightPx);
  const widthScale =
    (Math.max(1, maxWidthCells) * cellDimensions.widthPx) / imageWidth;
  const heightScale =
    (Math.max(1, maxHeightCells) * cellDimensions.heightPx) / imageHeight;
  const scale = Math.min(widthScale, heightScale);
  return {
    columns: Math.max(
      1,
      Math.min(
        maxWidthCells,
        Math.ceil((imageWidth * scale) / cellDimensions.widthPx),
      ),
    ),
    rows: Math.max(
      1,
      Math.min(
        maxHeightCells,
        Math.ceil((imageHeight * scale) / cellDimensions.heightPx),
      ),
    ),
  };
}

async function preparePreviewImage(
  image: ImageBlock,
): Promise<{ data: string; mimeType: "image/png" } | undefined> {
  let data = image.data;
  let mimeType = image.mimeType;
  if (!data || !mimeType) return undefined;

  if (mimeType !== "image/png") {
    const converted = await convertToPng(data, mimeType);
    if (!converted || converted.mimeType !== "image/png") return undefined;
    data = converted.data;
    mimeType = converted.mimeType;
  }

  const dimensions = getImageDimensions(data, mimeType);
  if (!dimensions) return undefined;
  if (
    Math.max(dimensions.widthPx, dimensions.heightPx) >
    MAX_PREVIEW_SOURCE_DIMENSION_PX
  ) {
    const resized = await downscalePngWithSips(
      data,
      MAX_PREVIEW_SOURCE_DIMENSION_PX,
    );
    if (!resized) return undefined;
    data = resized;
  }

  return { data, mimeType: "image/png" };
}

function deleteTransmittedImage(preview: StoredImagePreview | undefined): void {
  if (!preview || !transmittedImageIds.delete(preview.imageId)) return;
  process.stdout.write(buildDeleteSequence(preview.imageId));
}

function renderTmuxKittyImage(
  preview: StoredImagePreview,
  theme: PreviewTheme,
): Text | undefined {
  if (detectTmuxSupport() !== "kitty") return undefined;

  const dimensions = getImageDimensions(preview.data, preview.mimeType);
  if (!dimensions) return undefined;

  const cellDimensions = getCellDimensions();
  const maxHeightCells = Math.max(
    1,
    Math.ceil(
      (DEFAULT_MAX_WIDTH_CELLS * cellDimensions.widthPx) /
        cellDimensions.heightPx,
    ),
  );
  const size = calculateImageCellSize(
    dimensions,
    DEFAULT_MAX_WIDTH_CELLS,
    maxHeightCells,
    cellDimensions,
  );

  if (!transmittedImageIds.has(preview.imageId)) {
    process.stdout.write(
      buildDeleteSequence(preview.imageId) +
        buildTransmitSequence(
          preview.data,
          preview.imageId,
          size.columns,
          size.rows,
        ),
    );
    transmittedImageIds.add(preview.imageId);
  }

  const lines = buildPlaceholderLines(preview.imageId, size.columns, size.rows);
  return new Text(
    `${theme.fg("toolOutput", preview.note)}\n${lines.join("\n")}`,
    0,
    0,
  );
}

export default function piTmuxImagePreview(pi: ExtensionAPI): void {
  pi.registerEntryRenderer(CUSTOM_ENTRY_TYPE, (entry, _options, theme) => {
    if (!isTmuxImagePreviewData(entry.data)) return undefined;
    const preview = previews.get(entry.data.previewId);
    if (!preview) return undefined;
    return renderTmuxKittyImage(preview, theme);
  });

  pi.on("tool_result", async (event, ctx) => {
    const image = selectToolResultImage(event);
    if (!image) return;

    if (detectTmuxSupport() !== "kitty") {
      const diagnostic = supportDiagnostic();
      if (diagnostic && !emittedDiagnostics.has("support")) {
        emittedDiagnostics.add("support");
        ctx.ui.notify(diagnostic, "warning");
      }
      return;
    }

    const prepared = await preparePreviewImage(image);
    if (!prepared) {
      if (!emittedDiagnostics.has("processing")) {
        emittedDiagnostics.add("processing");
        ctx.ui.notify(
          "Image preview could not convert or downscale this image; the read result is still available to the model.",
          "warning",
        );
      }
      return;
    }

    previews.queue(event.toolCallId, {
      data: prepared.data,
      mimeType: prepared.mimeType,
      imageId: randomImageId(),
      note: previewNote(event.toolName, event.content),
    });
  });

  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "toolResult") return;

    const previewId = `${message.toolCallId}:${Date.now()}:${Math.random()
      .toString(16)
      .slice(2)}`;
    const promoted = previews.promote(message.toolCallId, previewId);
    if (!promoted) return;

    deleteTransmittedImage(promoted.evicted);
    pi.appendEntry(CUSTOM_ENTRY_TYPE, { previewId });
  });

  pi.on("session_shutdown", () => {
    for (const preview of previews.clear()) {
      deleteTransmittedImage(preview);
    }
    transmittedImageIds.clear();
    emittedDiagnostics.clear();
    cachedTmuxSupport = undefined;
  });
}
