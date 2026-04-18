import { createReadStream } from 'fs';
import { createInterface } from 'readline';

export async function streamJsonLines(
  filePath: string,
  onLine: (line: string) => void | Promise<void>,
): Promise<void> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      await onLine(line);
    }
  } finally {
    rl.close();
  }
}
