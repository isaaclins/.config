import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function downscalePngWithSips(
  base64Data: string,
  maxDimensionPx: number,
): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;

  const directory = await mkdtemp(join(tmpdir(), "pi-tmux-image-preview-"));
  const imagePath = join(directory, "preview.png");

  try {
    await writeFile(imagePath, Buffer.from(base64Data, "base64"));
    await execFileAsync(
      "/usr/bin/sips",
      ["-Z", String(maxDimensionPx), imagePath],
      { timeout: 10_000 },
    );
    return (await readFile(imagePath)).toString("base64");
  } catch {
    return undefined;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
