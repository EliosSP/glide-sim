const HELP =
  '↑/↓ acceleratore/freno · ←/→ volante · R retro · D marcia · Spazio freno forte · ' +
  'Z/X (tieni premuto) guarda specchietto sx/dx · W retrovisore · Q/E freccia sx/dx · P Park Assist · ' +
  "Invio avvia · A passa all'assistito · M finisco a mano · " +
  'C cambia vista · V split · F schermo intero · N scenario vuoto/animato · T segui la testa (Shift+T calibra) · ' +
  'trascina: gira la testa (doppio clic: centra) · H nasconde · G (o F1) parametri · Esc/Backspace reset';

/** Debug overlay (hidden with H). */
export class Hud {
  private box = document.createElement('div');
  private help = document.createElement('div');
  private labels = [document.createElement('div'), document.createElement('div')];
  visible = true;

  constructor() {
    this.box.className = 'hud';
    this.help.className = 'help';
    this.help.textContent = HELP;
    for (const l of this.labels) l.className = 'split-label hidden';
    this.labels[0].style.left = '12px';
    this.labels[1].style.left = 'calc(50% + 12px)';
    document.body.append(this.box, this.help, ...this.labels);
  }

  toggle() {
    this.setVisible(!this.visible);
  }

  setVisible(v: boolean) {
    this.visible = v;
    this.box.classList.toggle('hidden', !this.visible);
    this.help.classList.toggle('hidden', !this.visible);
  }

  setSplitLabels(left: string | null, right: string | null) {
    const show = this.visible && left !== null;
    this.labels[0].classList.toggle('hidden', !show);
    this.labels[1].classList.toggle('hidden', !show);
    if (left) this.labels[0].textContent = left;
    if (right) this.labels[1].textContent = right;
  }

  set(lines: string[]) {
    if (this.visible) this.box.textContent = lines.join('\n');
  }
}
