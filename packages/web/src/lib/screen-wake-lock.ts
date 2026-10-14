let holders = 0;
let sentinel: WakeLockSentinel | null = null;
let pending = false;

function sync(): void {
  if (holders === 0 || pending || sentinel) return;
  if (document.visibilityState !== "visible") return;
  const wakeLock = navigator.wakeLock;
  if (!wakeLock) return;
  pending = true;
  void (async () => wakeLock.request("screen"))().then(
    (acquired) => {
      pending = false;
      if (holders === 0) {
        void acquired.release().catch(() => {});
        return;
      }
      sentinel = acquired;
      acquired.addEventListener(
        "release",
        () => {
          if (sentinel === acquired) sentinel = null;
        },
        { once: true },
      );
    },
    () => {
      pending = false;
    },
  );
}

function handleVisibilityChange(): void {
  sync();
}

export function holdScreenWakeLock(): () => void {
  holders += 1;
  if (holders === 1) document.addEventListener("visibilitychange", handleVisibilityChange);
  sync();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders > 0) return;
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    const held = sentinel;
    sentinel = null;
    if (held) void held.release().catch(() => {});
  };
}
