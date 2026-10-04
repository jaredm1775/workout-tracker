export interface RestTimerState {
  startedAt: number;
  prescribed: number;
}

export function remainingSeconds(state: RestTimerState, now = Date.now()): number {
  const elapsed = Math.floor((now - state.startedAt) / 1000);
  return state.prescribed - elapsed;
}

export function elapsedSeconds(startedAt: number, now = Date.now()): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

export function formatClock(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? "+" : "";
  const abs = Math.abs(totalSeconds);
  const minutes = Math.floor(abs / 60);
  const seconds = abs % 60;
  return `${sign}${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export async function requestWakeLock(): Promise<WakeLockSentinel | null> {
  try {
    if ("wakeLock" in navigator) {
      return await navigator.wakeLock.request("screen");
    }
  } catch {
    return null;
  }
  return null;
}

export function vibrateDone(): void {
  try {
    navigator.vibrate?.([200, 80, 200]);
  } catch {
    /* ignore */
  }
}
