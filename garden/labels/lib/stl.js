// STL read/write. Meshes throughout the web app are flat Float32Arrays of
// triangle vertex positions: [x0,y0,z0, x1,y1,z1, x2,y2,z2, ...], 9 floats per
// triangle, in millimetres.

/** Parse an ASCII or binary STL (ArrayBuffer) into a flat Float32Array. */
export function parseStl(buffer) {
  const view = new DataView(buffer);
  // Binary STLs may begin with "solid", so detect by the exact-size rule.
  if (buffer.byteLength >= 84) {
    const n = view.getUint32(80, true);
    if (buffer.byteLength === 84 + n * 50) return parseBinary(view, n);
  }
  return parseAscii(new TextDecoder().decode(buffer));
}

function parseBinary(view, n) {
  const out = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    const base = 84 + i * 50 + 12; // skip the stored normal
    for (let j = 0; j < 9; j++) out[i * 9 + j] = view.getFloat32(base + j * 4, true);
  }
  return out;
}

function parseAscii(text) {
  const vals = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  let m;
  while ((m = re.exec(text))) vals.push(+m[1], +m[2], +m[3]);
  vals.length -= vals.length % 9; // drop any trailing partial facet
  return new Float32Array(vals);
}

/** Concatenate several flat triangle arrays into one. */
export function mergeTriangles(...parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Encode a flat triangle array as a binary STL (Uint8Array). */
export function writeBinaryStl(tris, name = 'label') {
  const n = tris.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const view = new DataView(buf);
  const header = new TextEncoder().encode(`labelgen ${name}`.slice(0, 80));
  new Uint8Array(buf, 0, header.length).set(header);
  view.setUint32(80, n, true);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50;
    const t = i * 9;
    const [nx, ny, nz] = facetNormal(tris, t);
    view.setFloat32(o, nx, true);
    view.setFloat32(o + 4, ny, true);
    view.setFloat32(o + 8, nz, true);
    for (let j = 0; j < 9; j++) view.setFloat32(o + 12 + j * 4, tris[t + j], true);
    // attribute byte count stays 0
  }
  return new Uint8Array(buf);
}

function facetNormal(a, t) {
  const ux = a[t + 3] - a[t], uy = a[t + 4] - a[t + 1], uz = a[t + 5] - a[t + 2];
  const vx = a[t + 6] - a[t], vy = a[t + 7] - a[t + 1], vz = a[t + 8] - a[t + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const mag = Math.hypot(nx, ny, nz);
  return mag ? [nx / mag, ny / mag, nz / mag] : [0, 0, 0];
}

/** Axis-aligned bounds: { min: [x,y,z], max: [x,y,z] }. */
export function bounds(tris) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = tris[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/** Return a translated copy of a flat triangle array. */
export function translate(tris, dx, dy, dz) {
  const out = new Float32Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) {
    out[i] = tris[i] + dx;
    out[i + 1] = tris[i + 1] + dy;
    out[i + 2] = tris[i + 2] + dz;
  }
  return out;
}
