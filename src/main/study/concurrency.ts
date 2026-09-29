/** 有界并发：失败时阻止新批次启动，等待已在途批次结束后再返回。 */
export async function runConcurrentBatches<T>(
  batches: readonly T[],
  concurrency: number,
  run: (batch: T, index: number) => Promise<void>,
  onFirstError: () => void,
): Promise<void> {
  if (batches.length === 0) return;
  let cursor = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (!failed && cursor < batches.length) {
      const index = cursor++;
      try { await run(batches[index]!, index); }
      catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
          onFirstError();
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.trunc(concurrency)), batches.length) }, worker));
  if (failed) throw firstError;
}

export function normalizeHarnessConcurrency(value: number | undefined): 1 | 2 | 3 {
  return value === 1 || value === 3 ? value : 2;
}
