export type ImageBlock = { type: "image"; data?: string; mimeType?: string };
export type TextBlock = { type: "text"; text?: string };

export type StoredImagePreview = {
  data: string;
  mimeType: string;
  imageId: number;
  note: string;
};

export type TmuxImagePreviewData = {
  previewId: string;
};

export type TmuxSupport = "kitty" | "unsupported";

export type ImageDimensions = {
  widthPx: number;
  heightPx: number;
};

export type CellSize = {
  columns: number;
  rows: number;
};

export type PreviewTheme = {
  fg(color: "toolOutput", text: string): string;
};
