/**
 * One Euro filter (Casiez et al., 2012): adaptive low-pass. Strong smoothing when the signal is
 * still (no jitter), little smoothing when it moves fast (low latency).
 */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private tPrev = 0;

  constructor(
    public minCutoff = 1.0, // Hz
    public beta = 0.02,
    public dCutoff = 1.0, // Hz, for the derivative
  ) {}

  reset() {
    this.x = null;
    this.dx = 0;
  }

  /** t in seconds. */
  filter(value: number, t: number) {
    if (this.x === null) {
      this.x = value;
      this.tPrev = t;
      return value;
    }
    const dt = Math.max(1e-3, t - this.tPrev);
    this.tPrev = t;
    const dRaw = (value - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (dRaw - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

function alpha(cutoff: number, dt: number) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}
