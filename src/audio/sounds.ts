/**
 * Glide sounds, synthesised with the Web Audio API: only short confirmations, never continuous.
 * Panned towards the side of the active mirror (−1 left … +1 right).
 */
export class GlideAudio {
  volume = 0.6;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private nextBeep = 0;

  constructor() {
    // Browsers start audio only after a user gesture
    const unlock = () => {
      this.ensure();
      void this.ctx?.resume();
    };
    window.addEventListener('keydown', unlock);
    window.addEventListener('pointerdown', unlock);
  }

  private ensure() {
    if (this.ctx) return this.ctx;
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  setVolume(v: number) {
    this.volume = v;
  }

  /** One soft tone with a short attack and exponential decay. */
  private tone(freq: number, at: number, dur: number, gain: number, pan: number, type: OscillatorType = 'sine') {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== 'running' || this.volume <= 0) return;
    this.master.gain.value = this.volume;
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    osc.connect(env).connect(panner).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** In target / point reached: two short rising notes. */
  confirm(side: 'left' | 'right' | null) {
    const pan = side === 'left' ? -0.7 : side === 'right' ? 0.7 : 0;
    this.tone(1046, 0, 0.09, 0.22, pan);
    this.tone(1568, 0.075, 0.14, 0.2, pan);
  }

  /** P accepted: a single soft click-tone. */
  parkOn() {
    this.tone(660, 0, 0.12, 0.25, 0, 'triangle');
    this.tone(1320, 0, 0.06, 0.06, 0);
  }

  /** Autonomous start ("Avvia"): three rising notes. */
  start() {
    [523, 659, 784].forEach((f, i) => this.tone(f, i * 0.09, 0.16, 0.18, 0));
  }

  /** End of the manoeuvre (P engaged): a resolving two-note chime. */
  end() {
    this.tone(784, 0, 0.25, 0.18, 0);
    this.tone(523, 0.16, 0.5, 0.2, 0);
    this.tone(1046, 0.16, 0.4, 0.05, 0);
  }

  /**
   * Parking sensors, only in the last centimetres: short beeps, faster when closer, never a
   * continuous tone. Call every frame with the distance (m) or null when nothing is close.
   */
  sensors(distance: number | null, side: 'left' | 'right' | null, now: number, range = 0.3) {
    if (distance === null || distance > range) return;
    if (now < this.nextBeep) return;
    const u = Math.max(0, Math.min(1, (distance - 0.05) / (range - 0.05)));
    this.nextBeep = now + 0.13 + 0.45 * u;
    this.tone(1900, 0, 0.06, 0.12, side === 'left' ? -0.4 : side === 'right' ? 0.4 : 0, 'square');
  }
}
