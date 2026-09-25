// Batch 3MF writer, ported from labelgen.py's _write_batch_3mf: flat
// top-level objects (Bambu Studio won't surface component names), label+text
// merged into one body with per-triangle materials, and four base materials
// so each part type can be mapped to a filament once for the whole batch.

import { zipSync, strToU8 } from '../vendor/fflate.module.js';

export const MATERIAL_COLORS = {
  label: '#E6E6E6FF',  // off-white
  text: '#1A1A1AFF',   // near-black
  holder: '#404040FF', // dark gray
  rail: '#808080FF',   // medium gray
};
const PINDEX = { label: 0, text: 1, holder: 2, rail: 3 };
const GROUP_ID = 100;

const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (v) => String(Math.round(v * 1e6) / 1e6);

/** <object> XML from [[tris, materialName], ...] with shared vertices. */
function objectXml(id, name, parts) {
  const index = new Map();
  const verts = [];
  const tris = [];
  for (const [arr, mat] of parts) {
    const p = PINDEX[mat];
    for (let t = 0; t < arr.length; t += 9) {
      const ids = [];
      for (let k = 0; k < 9; k += 3) {
        const key = `${num(arr[t + k])} ${num(arr[t + k + 1])} ${num(arr[t + k + 2])}`;
        let i = index.get(key);
        if (i === undefined) {
          i = verts.length;
          index.set(key, i);
          const [x, y, z] = key.split(' ');
          verts.push(`        <vertex x="${x}" y="${y}" z="${z}"/>`);
        }
        ids.push(i);
      }
      if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) continue; // degenerate
      tris.push(`        <triangle v1="${ids[0]}" v2="${ids[1]}" v3="${ids[2]}" pid="${GROUP_ID}" p1="${p}" p2="${p}" p3="${p}"/>`);
    }
  }
  return `    <object id="${id}" type="model" name="${esc(name)}" pid="${GROUP_ID}" pindex="${PINDEX[parts[0][1]]}">
      <mesh>
        <vertices>
${verts.join('\n')}
        </vertices>
        <triangles>
${tris.join('\n')}
        </triangles>
      </mesh>
    </object>
`;
}

/**
 * kits: [{ safe, label, text, holder?, rail? }] (already laid out).
 * Returns the .3mf file as a Uint8Array.
 */
export function write3mf(kits) {
  const objects = [];
  const items = [];
  let id = 1;
  for (const kit of kits) {
    objects.push(objectXml(id, `body_${kit.safe}`, [[kit.label, 'label'], [kit.text, 'text']]));
    items.push(id++);
    for (const part of ['holder', 'rail']) {
      if (!kit[part]) continue;
      objects.push(objectXml(id, `${part}_${kit.safe}`, [[kit[part], part]]));
      items.push(id++);
    }
  }
  const materials = Object.keys(PINDEX)
    .map((n) => `      <base name="${n[0].toUpperCase() + n.slice(1)}" displaycolor="${MATERIAL_COLORS[n]}"/>`)
    .join('\n');

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">LabelGen Batch</metadata>
  <resources>
    <basematerials id="${GROUP_ID}">
${materials}
    </basematerials>
${objects.join('')}  </resources>
  <build>
${items.map((i) => `    <item objectid="${i}"/>`).join('\n')}
  </build>
</model>
`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model),
  });
}
