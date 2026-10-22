import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

export type TimeOfDay = 'day' | 'evening';
export type Quality = 'high' | 'low';

const PRESETS: Record<TimeOfDay, {
  hdri: string; exposure: number; sunColor: number; sunIntensity: number; sunDir: [number, number, number];
  envIntensity: number; fog: number; lamps: number;
}> = {
  day: {
    hdri: `${import.meta.env.BASE_URL}hdri/day.hdr`, exposure: 0.95, sunColor: 0xfff3e2, sunIntensity: 2.6, sunDir: [-0.45, 0.8, 0.4],
    envIntensity: 1.0, fog: 0xc9d6e2, lamps: 0,
  },
  evening: {
    hdri: `${import.meta.env.BASE_URL}hdri/evening.hdr`, exposure: 0.6, sunColor: 0xff9a5c, sunIntensity: 0.7, sunDir: [-0.9, 0.12, 0.35],
    envIntensity: 0.55, fog: 0x3a3a4a, lamps: 3,
  },
};

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly sun = new THREE.DirectionalLight(0xffffff, 2.5);
  /** Emissive materials that light up in the evening (street lamps, windows). */
  readonly nightMaterials: THREE.MeshStandardMaterial[] = [];
  time: TimeOfDay = 'day';
  quality: Quality = 'high';

  private pmrem: THREE.PMREMGenerator;
  private envCache = new Map<TimeOfDay, { env: THREE.Texture; bg: THREE.Texture }>();
  private hdrLoader = new HDRLoader();

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft is no longer supported; radius softens the edges
    this.renderer.shadowMap.autoUpdate = false; // updated once per frame in main
    container.appendChild(this.renderer.domElement);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const c = this.sun.shadow.camera;
    c.left = -28; c.right = 28; c.top = 28; c.bottom = -28; c.near = 1; c.far = 120;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 2.5;
    this.scene.add(this.sun, this.sun.target);
    this.scene.fog = new THREE.Fog(0xc9d6e2, 90, 260);
    this.setQuality('high');
  }

  async setTime(t: TimeOfDay) {
    this.time = t;
    const p = PRESETS[t];
    this.renderer.toneMappingExposure = p.exposure;
    this.sun.color.setHex(p.sunColor);
    this.sun.intensity = p.sunIntensity;
    (this.scene.fog as THREE.Fog).color.setHex(p.fog);
    this.scene.environmentIntensity = p.envIntensity;
    for (const m of this.nightMaterials) m.emissiveIntensity = p.lamps * (m.userData.nightScale ?? 1);

    let e = this.envCache.get(t);
    if (!e) {
      try {
        const hdr = await this.hdrLoader.loadAsync(p.hdri);
        hdr.mapping = THREE.EquirectangularReflectionMapping;
        e = { env: this.pmrem.fromEquirectangular(hdr).texture, bg: hdr };
        this.envCache.set(t, e);
      } catch (err) {
        console.warn('HDRI not loaded, using flat background', err);
        this.scene.background = new THREE.Color(p.fog);
        return;
      }
    }
    if (this.time !== t) return; // switched again while loading
    this.scene.environment = e.env;
    this.scene.background = e.bg;
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.renderer.setPixelRatio(q === 'high' ? Math.min(window.devicePixelRatio, 2) : 1);
    this.renderer.shadowMap.enabled = q === 'high';
    this.sun.castShadow = q === 'high';
    // Force materials to recompile with/without shadows
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      for (const mm of Array.isArray(m) ? m : [m]) mm.needsUpdate = true;
    });
  }

  /** Keep the shadow frustum centred on the player car. */
  followSun(x: number, z: number) {
    const d = PRESETS[this.time].sunDir;
    this.sun.position.set(x + d[0] * 60, d[1] * 60, z + d[2] * 60);
    this.sun.target.position.set(x, 0, z);
  }

  resize(w = window.innerWidth, h = window.innerHeight) {
    this.renderer.setSize(w, h);
  }
}
