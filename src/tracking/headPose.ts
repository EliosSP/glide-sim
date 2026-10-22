const DEG = 180 / Math.PI;

/**
 * Head angles from the face transformation matrix (4×4, column-major, camera space:
 * x right in the raw camera image, y up, z towards the viewer). The face's forward axis is the
 * third column. The raw image is not mirrored: the user's right is the camera's −x.
 */
export function poseFromMatrix(d: ArrayLike<number>) {
  const r = (row: number, col: number) => d[col * 4 + row];
  const fx = r(0, 2);
  const fy = r(1, 2);
  const fz = r(2, 2);
  return {
    yaw: -Math.atan2(fx, fz) * DEG, // turning right moves the nose towards the camera's −x
    pitch: Math.asin(Math.max(-1, Math.min(1, fy))) * DEG,
    roll: Math.atan2(r(1, 0), r(0, 0)) * DEG,
  };
}
