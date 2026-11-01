import { useMemo, useState } from 'react';
import type { BomProjection, BomProjectionLine } from '../circuit/bomProjection.ts';
import { buildSupplierSearchReference } from '../circuit/externalReferences.ts';

type SortKey = 'ref' | 'quantity' | 'value' | 'footprint' | 'status';
const PAGE_SIZE = 50;

function copyText(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) return Promise.reject(new Error('Clipboard access is unavailable in this host.'));
  return navigator.clipboard.writeText(value);
}

function sortedLines(lines: BomProjectionLine[], sort: SortKey): BomProjectionLine[] {
  return [...lines].sort((a, b) => {
    if (sort === 'quantity') return b.quantity - a.quantity || a.refs[0].ref.localeCompare(b.refs[0].ref);
    if (sort === 'value') return a.comment.localeCompare(b.comment) || a.refs[0].ref.localeCompare(b.refs[0].ref);
    if (sort === 'footprint') return a.footprint.localeCompare(b.footprint) || a.refs[0].ref.localeCompare(b.refs[0].ref);
    if (sort === 'status') return b.blockedRefs - a.blockedRefs || a.refs[0].ref.localeCompare(b.refs[0].ref);
    return a.refs[0].ref.localeCompare(b.refs[0].ref);
  });
}

export function BomPanel({
  projection,
  selectedComponentId,
  onSelectRef,
  openExternal,
}: {
  projection: BomProjection;
  selectedComponentId?: string;
  onSelectRef: (sourceComponentId: string) => void;
  openExternal?: (url: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortKey>('ref');
  const [page, setPage] = useState(0);
  const [expandedKey, setExpandedKey] = useState<string>();
  const [copyStatus, setCopyStatus] = useState<string>();
  const normalizedFilter = filter.trim().toLowerCase();
  const filtered = useMemo(() => sortedLines(projection.lines.filter((line) => {
    if (!normalizedFilter) return true;
    return [line.comment, line.footprint, line.manufacturerPartNumber, line.lcscPartNumber,
      ...line.refs.flatMap((ref) => [ref.ref, ...ref.supplierNumbers.flatMap((number) => [number.provider, number.value])]),
      ...line.blockerCodes,
    ].some((value) => value.toLowerCase().includes(normalizedFilter));
  }), sort), [normalizedFilter, projection.lines, sort]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const copy = (label: string, value: string) => {
    void copyText(value).then(() => setCopyStatus(`${label} copied`)).catch((error) => {
      setCopyStatus(error instanceof Error ? error.message : String(error));
    });
  };
  const open = (label: string, url: string) => {
    if (!openExternal) {
      setCopyStatus('External references are unavailable in this CutuCircuits host.');
      return;
    }
    void openExternal(url).then(() => setCopyStatus(`${label} opened externally`)).catch((error) => {
      setCopyStatus(error instanceof Error ? error.message : String(error));
    });
  };

  return (
    <section className="es-bom" aria-label="Bill of materials workspace">
      <header className="es-bom-header">
        <div><small>Derived from the evaluated circuit</small><h2>Bill of materials</h2></div>
        <p>{openExternal
          ? 'Selecting a row does not modify anything. Declared LCSC or JLCPCB part numbers can open a labelled search in your external browser. Generated searches are not sourcing evidence.'
          : 'Selecting a row does not modify anything. External part links are disabled because this CutuCircuits host does not provide a reviewed URL-opening service.'}</p>
      </header>
      <div className="es-bom-summary" aria-label="BOM summary">
        <span><small>Line items</small><b>{projection.summary.lineItems}</b></span>
        <span><small>Placed parts</small><b>{projection.summary.totalParts}</b></span>
        <span className="es-bom-summary-ready"><small>Ready</small><b>{projection.summary.readyParts}</b></span>
        <span className={projection.summary.blockedParts ? 'es-bom-summary-blocked' : ''}><small>Blocked</small><b>{projection.summary.blockedParts}</b></span>
        <span><small>Missing footprint</small><b>{projection.summary.missingFootprint}</b></span>
        <span><small>Supplier issue</small><b>{projection.summary.missingSupplierNumber}</b></span>
        <span><small>Placement issue</small><b>{projection.summary.missingOrInvalidPlacement}</b></span>
      </div>
      <div className="es-bom-controls">
        <label>Filter<input value={filter} onChange={(event) => { setFilter(event.target.value); setPage(0); }} placeholder="Ref, value, footprint, part number, blocker…" /></label>
        <label>Sort<select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
          <option value="ref">Reference</option><option value="quantity">Quantity</option><option value="value">Value</option>
          <option value="footprint">Footprint</option><option value="status">Blocked first</option>
        </select></label>
        <span role="status" aria-live="polite">{copyStatus}</span>
      </div>
      <div className="es-bom-table-wrap">
        <table className="es-bom-table">
          <colgroup>
            <col className="es-bom-col-qty" />
            <col className="es-bom-col-refs" />
            <col className="es-bom-col-value" />
            <col className="es-bom-col-footprint" />
            <col className="es-bom-col-mpn" />
            <col className="es-bom-col-supplier" />
            <col className="es-bom-col-placement" />
            <col className="es-bom-col-status" />
          </colgroup>
          <thead><tr><th>Qty</th><th>Refs</th><th>Value / description</th><th>Footprint</th><th>MPN</th><th>Supplier</th><th>Placement</th><th>Status</th></tr></thead>
          <tbody>
            {visible.map((line) => {
              const expanded = expandedKey === line.key;
              const declaredSupplier = line.lcscPartNumber
                ? { provider: 'lcsc', value: line.lcscPartNumber }
                : line.refs.flatMap((ref) => ref.supplierNumbers)[0];
              const supplier = declaredSupplier?.value ?? '';
              const supplierSearch = declaredSupplier
                ? buildSupplierSearchReference(declaredSupplier.provider, declaredSupplier.value)
                : undefined;
              return [
                <tr key={line.key} className={line.refs.some((ref) => ref.sourceComponentId === selectedComponentId) ? 'es-bom-row-selected' : undefined}>
                  <td>{line.quantity}</td>
                  <td><button className="es-bom-expand" onClick={() => setExpandedKey(expanded ? undefined : line.key)} aria-expanded={expanded}>{line.refs.map((ref) => ref.ref).join(', ')}</button></td>
                  <td>{line.comment || '—'}</td><td>{line.footprint || '—'}</td>
                  <td>{line.manufacturerPartNumber ? <button className="es-bom-copy" onClick={() => copy('MPN', line.manufacturerPartNumber)}>{line.manufacturerPartNumber}</button> : '—'}</td>
                  <td>{supplier ? <span className="es-bom-supplier-actions"><button className="es-bom-copy" onClick={() => copy('Supplier ID', supplier)}>{supplier}</button>{supplierSearch && <button className="es-bom-external" disabled={!openExternal} onClick={() => open(supplierSearch.label, supplierSearch.url)} title="Generated supplier search; not stock, price, authenticity, or orderability evidence">{supplierSearch.label}</button>}</span> : '—'}</td>
                  <td>{line.refs.filter((ref) => ref.placementComplete).length}/{line.quantity}</td>
                  <td><span className={line.blockedRefs ? 'es-bom-blocked' : 'es-bom-ready'}>{line.blockedRefs ? `${line.blockedRefs} blocked` : 'Ready'}</span></td>
                </tr>,
                expanded && <tr key={`${line.key}-detail`} className="es-bom-detail-row"><td colSpan={8}>
                  <div className="es-bom-ref-grid">{line.refs.map((ref) => <article key={ref.sourceComponentId}>
                    <header><button onClick={() => onSelectRef(ref.sourceComponentId)}>{ref.ref}</button><code>{ref.sourceComponentId}</code></header>
                    <p>{ref.placementComplete ? 'Placement present' : 'Placement missing or invalid'} · {ref.readyForAssemblyTemplate ? 'template-ready' : 'blocked'}</p>
                    {ref.supplierNumbers.length > 0 && <p>{ref.supplierNumbers.map((number) => {
                      const search = buildSupplierSearchReference(number.provider, number.value);
                      return <span key={`${number.provider}:${number.value}`} className="es-bom-supplier-actions"><button className="es-bom-copy" onClick={() => copy(`${number.provider} ID`, number.value)}>{number.provider}: {number.value}</button>{search && <button className="es-bom-external" disabled={!openExternal} onClick={() => open(search.label, search.url)}>{search.label}</button>}</span>;
                    })}</p>}
                    {ref.blockers.length > 0 && <ul>{ref.blockers.map((blocker) => <li key={blocker.code}><b>{blocker.code}</b> — {blocker.detail}</li>)}</ul>}
                    <footer><button onClick={() => onSelectRef(ref.sourceComponentId)}>Focus linked part</button><span>Use the existing explicit Ask agent card after focusing.</span></footer>
                  </article>)}</div>
                </td></tr>,
              ];
            })}
            {visible.length === 0 && <tr><td colSpan={8} className="es-bom-empty">No BOM rows match this filter.</td></tr>}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && <footer className="es-bom-pagination"><button disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>Previous</button><span>Page {safePage + 1} of {pageCount}</span><button disabled={safePage + 1 >= pageCount} onClick={() => setPage(safePage + 1)}>Next</button></footer>}
      <footer className="es-bom-limitations">Assembly-ready means only the installed JLC-style footprint, declared LCSC identifier, and evaluated placement fields are complete. It does not prove stock, price, authenticity, orientation, vendor acceptance, manufacturability, or hardware validity.</footer>
    </section>
  );
}
