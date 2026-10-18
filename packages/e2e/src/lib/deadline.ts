export interface DeadlineOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  label?: string;
}

/** Bound an entire async operation, even when it ignores AbortSignal. */
export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  opts: DeadlineOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const label = opts.label ?? 'operation';
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      controller.abort();
    }, Math.max(0, timeoutMs));
  });
  let rejectExternal!: (error: Error) => void;
  const externalAbort = new Promise<never>((_resolve, reject) => {
    rejectExternal = reject;
  });
  const external = opts.signal;
  const abortFromExternal = () => {
    controller.abort();
    rejectExternal(
      external?.reason instanceof Error ? external.reason : new Error(`${label} aborted`),
    );
  };
  if (external?.aborted) abortFromExternal();
  else external?.addEventListener('abort', abortFromExternal, { once: true });

  const work = Promise.resolve().then(() => operation(controller.signal));
  try {
    return await Promise.race([work, timeout, externalAbort]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    external?.removeEventListener('abort', abortFromExternal);
  }
}
