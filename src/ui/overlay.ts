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
