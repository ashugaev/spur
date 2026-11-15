// execFile's timeout only signals the child; it can still wait forever for
// close (for example, when a descendant inherited a pipe). Do not let an
// observation hold lifecycle locks indefinitely in that case.
export async function observationDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Observation deadline exceeded")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
