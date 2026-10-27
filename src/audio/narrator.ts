import NARRATION from '../modes/narration.json';

export type LineId = keyof typeof NARRATION;

/** Text of a narration line (also the subtitle: the exact transcript of the voice). */
export const lineText = (id: LineId) => NARRATION[id];

/**
 * Demo voice-over: one mp3 per line in public/voice/<id>.mp3, played one after the other.
 * The subtitle changes when a line actually starts. A missing file (or voice off) shows the
 * subtitle at once and does not hold the demo, so the demo works before the audio exists.
 */
export class Narrator {
  enabled = true;
  volume = 0.9;
  /** Called when a line starts (subtitle), or with null when the voice is reset. */
  onLine: (text: string | null) => void = () => {};

  private clips = new Map<LineId, HTMLAudioElement>();
  private missing = new Set<LineId>();
  private queue: LineId[] = [];
  private playing: HTMLAudioElement | null = null;

  constructor() {
    for (const id of Object.keys(NARRATION) as LineId[]) {
      const a = new Audio(`${import.meta.env.BASE_URL}voice/${id}.mp3`);
      a.preload = 'auto';
      a.addEventListener('error', () => this.missing.add(id));
      this.clips.set(id, a);
    }
  }

  /** True while a line is playing or waiting in the queue. */
  get busy() {
    return this.playing !== null || this.queue.length > 0;
  }

  say(id: LineId) {
    this.queue.push(id);
    if (!this.playing) this.next();
  }

  stop() {
    this.queue = [];
    if (this.playing) {
      this.playing.pause();
      this.playing.currentTime = 0;
    }
    this.playing = null;
    this.onLine(null);
  }

  private next(): void {
    const id = this.queue.shift();
    if (!id) {
      this.playing = null;
      return;
    }
    this.onLine(lineText(id));
    const a = this.clips.get(id)!;
    if (!this.enabled || this.missing.has(id)) return this.next();
    a.volume = this.volume;
    a.currentTime = 0;
    this.playing = a;
    a.onended = () => this.next();
    a.play().catch((e: DOMException) => {
      // Blocked by the browser (no click yet): this line without voice. Anything else: file unusable.
      if (e.name !== 'NotAllowedError') this.missing.add(id);
      this.next();
    });
  }
}
