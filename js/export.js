// 3MF and STL writers. 3MF opens directly in Bambu Studio / OrcaSlicer.
import { zipSync, strToU8 } from 'fflate';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

const f = (v) => (Math.round(v * 10000) / 10000).toString();

export function make3MF(mesh, name = 'FitForge part') {
  const { positions, indices } = mesh;
  const parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <metadata name="Application">FitForge</metadata>
 <metadata name="Title">${name.replace(/[<>&"]/g, '')}</metadata>
 <resources>
  <object id="1" type="model" name="${name.replace(/[<>&"]/g, '')}">
   <mesh>
    <vertices>
`);
  const vs = [];
  for (let i = 0; i < positions.length; i += 3) {
    vs.push(`<vertex x="${f(positions[i])}" y="${f(positions[i + 1])}" z="${f(positions[i + 2])}"/>`);
  }
  parts.push(vs.join('\n'));
  parts.push(`
    </vertices>
    <triangles>
`);
  const ts = [];
  for (let i = 0; i < indices.length; i += 3) {
    ts.push(`<triangle v1="${indices[i]}" v2="${indices[i + 1]}" v3="${indices[i + 2]}"/>`);
  }
  parts.push(ts.join('\n'));
  parts.push(`
    </triangles>
   </mesh>
  </object>
 </resources>
 <build>
  <item objectid="1"/>
 </build>
</model>`);
  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(RELS),
    '3D/3dmodel.model': strToU8(parts.join('')),
  }, { level: 6 });
}

export function makeSTL(mesh) {
  const { positions, indices } = mesh;
  const nt = indices.length / 3;
  const buf = new ArrayBuffer(84 + nt * 50);
  const dv = new DataView(buf);
  const header = 'FitForge binary STL';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, nt, true);
  let o = 84;
  for (let t = 0; t < nt; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true);
    o += 12;
    for (const k of [a, b, c]) {
      dv.setFloat32(o, positions[k], true); dv.setFloat32(o + 4, positions[k + 1], true); dv.setFloat32(o + 8, positions[k + 2], true);
      o += 12;
    }
    dv.setUint16(o, 0, true); o += 2;
  }
  return new Uint8Array(buf);
}
