import { execSync } from "node:child_process";

const CHUNK_SIZE = 4096;

const ROW_DIACRITICS = [
  "\u0305", "\u030D", "\u030E", "\u0310", "\u0312",
  "\u033D", "\u033E", "\u033F", "\u0346", "\u034A",
  "\u034B", "\u034C", "\u0350", "\u0351", "\u0352",
  "\u0357", "\u035B", "\u0363", "\u0364", "\u0365",
  "\u0366", "\u0367", "\u0368", "\u0369", "\u036A",
  "\u036B", "\u036C", "\u036D", "\u036E", "\u036F",
  "\u0483", "\u0484", "\u0485", "\u0486", "\u0487",
  "\u0592", "\u0593", "\u0594", "\u0595", "\u0597",
  "\u0598", "\u0599", "\u059C", "\u059D", "\u059E",
  "\u059F", "\u05A0", "\u05A1", "\u05A8", "\u05A9",
  "\u05AB", "\u05AC", "\u05AF", "\u05C4", "\u0610",
  "\u0611", "\u0612", "\u0613", "\u0614", "\u0615",
  "\u0616", "\u0617", "\u0618", "\u0619", "\u061A",
  "\u0653", "\u0654", "\u0657", "\u0658", "\u06D6",
  "\u06D7", "\u06D8", "\u06D9", "\u06DA", "\u06DB",
  "\u06DC", "\u06DF", "\u06E0", "\u06E1", "\u06E2",
  "\u06E4", "\u06E7", "\u06E8", "\u06EB", "\u06EC",
];

export const PLACEHOLDER = "\u{10EEEE}";

export function run(command: string): string | null {
  try {
    return execSync(command, {
      encoding: "utf8",
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function tmuxPassthroughEnabled(): boolean {
  const output = run("tmux show-options -g allow-passthrough");
  return /allow-passthrough\s+(on|all)/.test(output ?? "");
}

export function tmuxEnvironment(name: string): string | null {
  const session = run(`tmux show-environment ${name}`);
  const global = session ? null : run(`tmux show-environment -g ${name}`);
  const output = session ?? global;
  const match = output?.match(new RegExp(`^${name}=(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

export function wrapTmuxPassthrough(sequence: string): string {
  return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

export function randomImageId(): number {
  return Math.floor(Math.random() * 0xfffffe) + 1;
}

export function buildTransmitSequence(
  base64: string,
  imageId: number,
  columns: number,
  rows: number
): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < base64.length; offset += CHUNK_SIZE) {
    const chunk = base64.slice(offset, offset + CHUNK_SIZE);
    const first = offset === 0;
    const last = offset + CHUNK_SIZE >= base64.length;
    const more = last ? 0 : 1;
    const params = first
      ? `a=T,f=100,q=2,U=1,i=${imageId},c=${columns},r=${rows},m=${more}`
      : `m=${more}`;
    chunks.push(`\x1b_G${params};${chunk}\x1b\\`);
  }

  if (chunks.length === 0) {
    chunks.push(
      `\x1b_Ga=T,f=100,q=2,U=1,i=${imageId},c=${columns},r=${rows},m=0;\x1b\\`
    );
  }

  return wrapTmuxPassthrough(chunks.join(""));
}

export function buildDeleteSequence(imageId: number): string {
  return wrapTmuxPassthrough(`\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`);
}

export function buildPlaceholderLines(
  imageId: number,
  columns: number,
  rows: number
): string[] {
  const red = (imageId >> 16) & 255;
  const green = (imageId >> 8) & 255;
  const blue = imageId & 255;
  const colorOn = `\x1b[38;2;${red};${green};${blue}m`;
  const colorOff = "\x1b[39m";

  return Array.from({ length: rows }, (_, row) => {
    const diacritic = ROW_DIACRITICS[row] ?? ROW_DIACRITICS[0];
    return `${colorOn}${PLACEHOLDER}${diacritic}${PLACEHOLDER.repeat(
      Math.max(0, columns - 1)
    )}${colorOff}`;
  });
}
