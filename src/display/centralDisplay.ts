import * as THREE from 'three';

/** Central touchscreen rendered to a canvas texture. Milestone 1: gear and speed only. */
export class CentralDisplay {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  private g: CanvasRenderingContext2D;
  private last = '';

  constructor(screen: THREE.Mesh) {
    this.canvas.width = 1024;
    this.canvas.height = 640;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    screen.material = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false });
  }

  update(gear: string, speedKmh: number) {
    const key = `${gear}|${Math.round(speedKmh)}`;
    if (key === this.last) return;
    this.last = key;
    const g = this.g;
    const { width: w, height: h } = this.canvas;
    g.fillStyle = '#07090b';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#e9eef2';
    g.font = '600 150px system-ui, -apple-system, sans-serif';
    g.textBaseline = 'middle';
    g.fillText(String(Math.round(speedKmh)), 70, 150);
    g.font = '400 40px system-ui, -apple-system, sans-serif';
    g.fillStyle = '#8b97a1';
    g.fillText('km/h', 76, 250);
    // Gear selector
    const gears = ['R', 'D'];
    gears.forEach((x, i) => {
      g.font = '600 56px system-ui, -apple-system, sans-serif';
      g.fillStyle = x === gear ? '#e9eef2' : '#3a444c';
      g.fillText(x, 76 + i * 70, 370);
    });
    this.texture.needsUpdate = true;
  }
}
