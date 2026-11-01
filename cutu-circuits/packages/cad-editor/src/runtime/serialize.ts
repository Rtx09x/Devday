// Worker-safe mesh serializers for the formats Replicad does not emit natively.
// STL and STEP come straight from the kernel (shape.blobSTL / shape.blobSTEP);
// OBJ and 3MF we synthesize from the merged triangle mesh here.

interface MergedMesh {
  vertices: number[];
  triangles: number[];
  normals?: number[];
}

export function objFromMesh(mesh: MergedMesh, name = 'model'): string {
  const lines: string[] = [`# Exported by CutuCircuits Replicad`, `o ${name}`];
  const { vertices, triangles, normals } = mesh;
  for (let i = 0; i < vertices.length; i += 3) {
    lines.push(`v ${vertices[i]} ${vertices[i + 1]} ${vertices[i + 2]}`);
  }
  const hasNormals = !!normals && normals.length === vertices.length;
  if (hasNormals) {
    for (let i = 0; i < normals!.length; i += 3) {
      lines.push(`vn ${normals![i]} ${normals![i + 1]} ${normals![i + 2]}`);
    }
  }
  for (let i = 0; i < triangles.length; i += 3) {
    // OBJ indices are 1-based.
    const a = triangles[i] + 1;
    const b = triangles[i + 1] + 1;
    const c = triangles[i + 2] + 1;
    lines.push(
      hasNormals ? `f ${a}//${a} ${b}//${b} ${c}//${c}` : `f ${a} ${b} ${c}`
    );
  }
  return lines.join('\n') + '\n';
}

// --- Minimal stored (uncompressed) ZIP for the 3MF OPC container --------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** Build a stored-mode (no compression) ZIP. Adequate for 3MF OPC packages. */
function buildZip(entries: ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (value: number) => new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
  const u32 = (value: number) =>
    new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const localHeader = concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(size),
      u32(size),
      u16(nameBytes.length),
      u16(0),
    ]);
    chunks.push(localHeader, nameBytes, entry.data);

    const centralHeader = concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(size),
      u32(size),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
    ]);
    central.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + entry.data.length;
  }

  const centralStart = offset;
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralSize),
    u32(centralStart),
    u16(0),
  ]);

  return concat([...chunks, ...central, end]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Returns a base64-encoded 3MF (zip) container for the merged mesh. */
export function threeMFFromMesh(mesh: MergedMesh, name = 'model'): string {
  const { vertices, triangles } = mesh;
  const vertexXml: string[] = [];
  for (let i = 0; i < vertices.length; i += 3) {
    vertexXml.push(`<vertex x="${vertices[i]}" y="${vertices[i + 1]}" z="${vertices[i + 2]}"/>`);
  }
  const triangleXml: string[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    triangleXml.push(`<triangle v1="${triangles[i]}" v2="${triangles[i + 1]}" v3="${triangles[i + 2]}"/>`);
  }
  const modelXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<resources><object id="1" type="model" name="${name}"><mesh>` +
    `<vertices>${vertexXml.join('')}</vertices>` +
    `<triangles>${triangleXml.join('')}</triangles>` +
    `</mesh></object></resources>` +
    `<build><item objectid="1"/></build></model>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>` +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" ` +
    `Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>` +
    `</Relationships>`;

  const encoder = new TextEncoder();
  const zip = buildZip([
    { name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
    { name: '_rels/.rels', data: encoder.encode(rels) },
    { name: '3D/3dmodel.model', data: encoder.encode(modelXml) },
  ]);
  return bytesToBase64(zip);
}
