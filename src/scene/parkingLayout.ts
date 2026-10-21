import { ROAD, VEHICLE } from '../config';

export interface ParkedCar {
  x: number; // centre
  z: number;
  length: number;
  color: number;
}

export interface FreeSpace {
  id: string;
  xStart: number;
  xEnd: number;
  isTarget: boolean;
}

const COLORS = [0x8a8f96, 0x1d2a3a, 0xe8e6e1, 0x5a1d1d, 0x2b2b2b, 0x3c5a6e, 0xb8b2a5, 0x6b7a4f, 0x101215, 0x9a3b2a];

type Item = { kind: 'car'; length: number } | { kind: 'gap'; length: number; id?: string; target?: boolean };

/** Builds the right-hand parking row. The target space starts at x = 0. */
export function buildParkingRow(targetLength = VEHICLE.length + 1.0) {
  const before: Item[] = [
    { kind: 'car', length: 4.3 }, { kind: 'gap', length: 0.9 },
    { kind: 'car', length: 4.0 }, { kind: 'gap', length: 3.4, id: 'short' },
    { kind: 'car', length: 4.5 }, { kind: 'gap', length: 1.1 },
    { kind: 'car', length: 4.2 }, { kind: 'gap', length: 0.8 },
    { kind: 'car', length: 4.4 },
  ];
  const after: Item[] = [
    { kind: 'car', length: 4.2 }, { kind: 'gap', length: 1.0 },
    { kind: 'car', length: 3.9 }, { kind: 'gap', length: 6.6, id: 'wide' },
    { kind: 'car', length: 4.6 }, { kind: 'gap', length: 0.9 },
    { kind: 'car', length: 4.1 }, { kind: 'gap', length: 1.2 },
    { kind: 'car', length: 4.3 },
  ];

  const z = ROAD.curbZ - 0.22 - 0.9;
  const cars: ParkedCar[] = [];
  const spaces: FreeSpace[] = [];
  let colorIdx = 0;

  // Walk backwards from the target space for the cars behind it
  let x = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const it = before[i];
    if (it.kind === 'car') cars.push({ x: x - it.length / 2, z, length: it.length, color: COLORS[colorIdx++ % COLORS.length] });
    else if (it.id) spaces.push({ id: it.id, xStart: x - it.length, xEnd: x, isTarget: false });
    x -= it.length;
  }
  spaces.push({ id: 'target', xStart: 0, xEnd: targetLength, isTarget: true });
  x = targetLength;
  for (const it of after) {
    if (it.kind === 'car') cars.push({ x: x + it.length / 2, z, length: it.length, color: COLORS[colorIdx++ % COLORS.length] });
    else if (it.id) spaces.push({ id: it.id, xStart: x, xEnd: x + it.length, isTarget: false });
    x += it.length;
  }
  return { cars, spaces };
}

/** Opposite side row, for visual density only. */
export function buildOppositeRow(): ParkedCar[] {
  const z = -(ROAD.curbZ - 0.22 - 0.9);
  const cars: ParkedCar[] = [];
  let x = -70;
  let i = 3;
  while (x < 70) {
    const length = 3.9 + ((i * 37) % 7) / 10;
    cars.push({ x: x + length / 2, z, length, color: COLORS[i % COLORS.length] });
    x += length + 0.8 + ((i * 13) % 5) / 5;
    if (i % 4 === 0) x += 6;
    i++;
  }
  return cars;
}
