let ikaTxTail: Promise<void> = Promise.resolve();

/**
 * serializes IKA / Sui coin-consuming flows to avoid object-version races when
 * multiple requests try to split and spend the same coin objects concurrently.
 */
export async function runSerializedIkaTx<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = ikaTxTail;
  ikaTxTail = prev.then(() => gate);
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}
