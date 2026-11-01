/** Read local ASCII or binary STL vertices for a convex collision hull. No renderer or DOM. */
export function stlVertices(data: ArrayBuffer): Float32Array {
  const view = new DataView(data);
  const count = data.byteLength >= 84 ? view.getUint32(80, true) : 0;
  if (count > 0 && 84 + count * 50 === data.byteLength) {
    if (count > 500_000) throw new Error("STL exceeds 500,000 triangles");
    const out = new Float32Array(count * 9);
    for (let i = 0; i < count; i++)
      for (let j = 0; j < 9; j++)
        out[i * 9 + j] = view.getFloat32(84 + i * 50 + 12 + j * 4, true);
    if (out.some((n) => !Number.isFinite(n)))
      throw new Error("STL contains nonfinite vertices");
    return out;
  }
  const text = new TextDecoder().decode(data);
  if (!/^\s*solid\b/i.test(text)) throw new Error("Invalid STL");
  const values: number[] = [];
  const pattern = /\bvertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/gi;
  let m;
  while ((m = pattern.exec(text))) {
    values.push(Number(m[1]), Number(m[2]), Number(m[3]));
    if (values.length > 4_500_000)
      throw new Error("STL exceeds 500,000 triangles");
  }
  if (
    values.length < 9 ||
    values.length % 9 ||
    values.some((n) => !Number.isFinite(n))
  )
    throw new Error("Invalid ASCII STL vertices");
  return new Float32Array(values);
}
