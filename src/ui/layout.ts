import { FRAME_DURATION_MS } from "../core/types";

/**
 * True for phones / tablets / DevTools device mode.
 * Width-only — pointer/hover heuristics were locking scroll on desktop
 * touchscreens and some windowed browsers.
 */
export function isMobileLayout(): boolean {
  return window.matchMedia("(max-width: 1024px)").matches;
}

function isLandscape(): boolean {
  return window.matchMedia("(orientation: landscape)").matches;
}

/** Keep a shell element's mobile/landscape classes in sync with the viewport. */
export function bindShellLayout(
  shell: HTMLElement,
  onChange?: (mobile: boolean) => void,
): () => void {
  const sync = () => {
    const mobile = isMobileLayout();
    shell.classList.toggle("shell-mobile", mobile);
    shell.classList.toggle("shell-landscape", mobile && isLandscape());
    document.documentElement.classList.toggle("gbc-mobile", mobile);
    onChange?.(mobile);
  };
  sync();
  const mqWidth = window.matchMedia("(max-width: 1024px)");
  const mqOrient = window.matchMedia("(orientation: landscape)");
  mqWidth.addEventListener("change", sync);
  mqOrient.addEventListener("change", sync);
  window.addEventListener("resize", sync);
  return () => {
    mqWidth.removeEventListener("change", sync);
    mqOrient.removeEventListener("change", sync);
    window.removeEventListener("resize", sync);
  };
}

const MAX_FRAME_DT_MS = 50;
const MAX_CATCH_UP_FRAMES = 6;

/**
 * Wall-clock frame pacing: accumulate time and return how many frames to run.
 * Resets the accumulator if it drifts more than two frame periods behind.
 */
export function takeFrameBudget(
  accumulatorMs: number,
  dtMs: number,
  speed = 1,
): { frames: number; accumulatorMs: number } {
  const dt = Math.min(dtMs, MAX_FRAME_DT_MS);
  let acc = accumulatorMs + dt * speed;
  let frames = 0;
  const maxCatchUp = MAX_CATCH_UP_FRAMES * speed;
  while (acc >= FRAME_DURATION_MS && frames < maxCatchUp) {
    acc -= FRAME_DURATION_MS;
    frames++;
  }
  if (acc > FRAME_DURATION_MS * 2) acc = 0;
  return { frames, accumulatorMs: acc };
}
