/** Demo subtitles: one short line at the bottom of the (16:9) picture. */
export class Subtitles {
  private box = document.createElement('div');

  constructor() {
    this.box.className = 'subtitle hidden';
    document.body.append(this.box);
  }

  set(text: string | null, rect: DOMRect) {
    this.box.classList.toggle('hidden', !text);
    if (!text) return;
    this.box.textContent = text;
    // Follow the letterboxed canvas: bottom 7%, font from its height
    this.box.style.left = `${rect.left + rect.width * 0.1}px`;
    this.box.style.width = `${rect.width * 0.8}px`;
    this.box.style.bottom = `${window.innerHeight - rect.bottom + rect.height * 0.07}px`;
    this.box.style.fontSize = `${Math.max(14, rect.height * 0.032)}px`;
  }
}

/** Test mode: participant and trial number, small in the bottom-left corner. */
export class TrialIndicator {
  private box = document.createElement('div');
  visible = false;

  constructor() {
    this.box.className = 'trial-indicator hidden';
    document.body.append(this.box);
  }

  show(v: boolean) {
    this.visible = v;
    this.box.classList.toggle('hidden', !v);
  }

  set(participant: string, trial: number) {
    this.box.textContent = `${participant || '—'} · prova ${trial}`;
  }
}

/** What a video bubble points at. */
export type NoteAnchor = 'mirrors' | 'display' | 'closest' | 'fastest' | 'start' | 'space' | 'car';

/** What the video overlay shows (no subtitles): one short bubble at a time, next to the touch point it talks about. */
export interface VideoOverlayState {
  note: { text: string; anchor: NoteAnchor } | null;
}

export const VIDEO_OVERLAY_OFF: VideoOverlayState = { note: null };

/** Video overlay: a small white speech bubble with black text, its tail on the anchor point (0..1 on the picture). */
export class VideoOverlay {
  private root = document.createElement('div');
  private bubble = document.createElement('div');
  private text = document.createElement('span');
  private tail = document.createElement('i');
  private dot = document.createElement('div');
  private opacity = 0; // faded here, per frame (not in CSS), so it follows the simulation clock when recording frame by frame

  constructor() {
    this.root.className = 'video-overlay hidden';
    this.bubble.className = 'video-bubble';
    this.bubble.append(this.text, this.tail);
    this.dot.className = 'video-dot';
    this.root.append(this.dot, this.bubble);
    document.body.append(this.root);
  }

  set(state: VideoOverlayState | null, rect: DOMRect, anchor: { x: number; y: number } | null, dt: number) {
    this.root.classList.toggle('hidden', !state);
    if (!state) return;
    Object.assign(this.root.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, fontSize: `${rect.height / 45}px` });
    const show = !!state.note && !!anchor;
    this.opacity += ((show ? 1 : 0) - this.opacity) * Math.min(1, dt * 9);
    this.bubble.style.opacity = this.dot.style.opacity = String(this.opacity < 0.01 ? 0 : this.opacity);
    if (!state.note || !anchor) return;
    if (this.text.textContent !== state.note.text) this.text.textContent = state.note.text;
    const ax = anchor.x * rect.width;
    const ay = anchor.y * rect.height;
    const gap = rect.height / 45 * 1.1;
    const w = this.bubble.offsetWidth;
    const h = this.bubble.offsetHeight;
    // Below the point, or above it in the lower half of the picture; kept inside the picture, the tail stays on the point
    const below = ay < rect.height * 0.55;
    const left = Math.min(rect.width - w - 8, Math.max(8, ax - w / 2));
    this.bubble.style.left = `${left}px`;
    this.bubble.style.top = `${below ? ay + gap : ay - gap - h}px`;
    this.bubble.classList.toggle('below', below);
    this.tail.style.left = `${Math.min(w - 14, Math.max(14, ax - left))}px`;
    this.dot.style.left = `${ax}px`;
    this.dot.style.top = `${ay}px`;
  }
}
