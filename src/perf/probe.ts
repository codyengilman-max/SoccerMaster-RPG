/**
 * Frame-time probe: a rolling window of per-frame timings split into simulation and render cost.
 * Pure data; the match screen feeds it from its animation loop and `tools/perfBench.ts` feeds it
 * headlessly, so both report the same numbers (docs/PERFORMANCE.md).
 */

export interface FrameSample {
  /** Wall time between this frame and the previous one (ms). */
  frameMs: number;
  /** Time spent in `frame()` (simulation + tactics). */
  simMs: number;
  /** Time spent drawing the canvas. */
  renderMs: number;
  /** Simulation ticks advanced this frame. */
  ticks: number;
}

export interface ProbeSummary {
  frames: number;
  fps: number;
  frameP50: number;
  frameP95: number;
  frameMax: number;
  simP50: number;
  simP95: number;
  renderP50: number;
  renderP95: number;
  /** Frames over the 30 fps floor (33.4 ms). */
  longFrames: number;
  ticks: number;
}

export interface Probe {
  readonly capacity: number;
  sample(s: FrameSample): void;
  summary(): ProbeSummary;
  reset(): void;
}

export const LONG_FRAME_MS = 1000 / 30 + 0.1;

export function createProbe(capacity = 300): Probe {
  const buf: FrameSample[] = [];
  let head = 0;
  return {
    capacity,
    sample(s) {
      if (buf.length < capacity) buf.push(s);
      else {
        buf[head] = s;
        head = (head + 1) % capacity;
      }
    },
    reset() {
      buf.length = 0;
      head = 0;
    },
    summary: () => summarize(buf),
  };
}

export function summarize(samples: readonly FrameSample[]): ProbeSummary {
  if (samples.length === 0) {
    return { frames: 0, fps: 0, frameP50: 0, frameP95: 0, frameMax: 0, simP50: 0, simP95: 0, renderP50: 0, renderP95: 0, longFrames: 0, ticks: 0 };
  }
  const frame = samples.map((s) => s.frameMs).sort((a, b) => a - b);
  const sim = samples.map((s) => s.simMs).sort((a, b) => a - b);
  const render = samples.map((s) => s.renderMs).sort((a, b) => a - b);
  const total = frame.reduce((a, b) => a + b, 0);
  return {
    frames: samples.length,
    fps: total > 0 ? (samples.length / total) * 1000 : 0,
    frameP50: percentile(frame, 0.5),
    frameP95: percentile(frame, 0.95),
    frameMax: frame[frame.length - 1]!,
    simP50: percentile(sim, 0.5),
    simP95: percentile(sim, 0.95),
    renderP50: percentile(render, 0.5),
    renderP95: percentile(render, 0.95),
    longFrames: frame.filter((f) => f > LONG_FRAME_MS).length,
    ticks: samples.reduce((a, s) => a + s.ticks, 0),
  };
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[rank]!;
}

export function formatSummary(s: ProbeSummary): string {
  return `${s.fps.toFixed(0)} fps · frame p50 ${s.frameP50.toFixed(1)} p95 ${s.frameP95.toFixed(1)} ms · sim p95 ${s.simP95.toFixed(2)} · draw p95 ${s.renderP95.toFixed(2)} · long ${s.longFrames}/${s.frames}`;
}
