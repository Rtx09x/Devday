export interface ExternalReference {
  label: string;
  url: string;
  kind: 'supplier-search';
}

const MAX_PART_NUMBER_LENGTH = 160;

function boundedPartNumber(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PART_NUMBER_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Small tested registry for generated supplier searches. Generated URLs are
 * always labelled searches; they are never availability or orderability proof.
 */
export function buildSupplierSearchReference(provider: string, value: string): ExternalReference | undefined {
  const partNumber = boundedPartNumber(value);
  if (!partNumber) return undefined;
  const normalizedProvider = provider.trim().toLowerCase();
  const url = normalizedProvider === 'lcsc'
    ? new URL('https://www.lcsc.com/search')
    : normalizedProvider === 'jlcpcb'
      ? new URL('https://jlcpcb.com/parts/componentSearch')
      : undefined;
  if (!url) return undefined;
  if (normalizedProvider === 'jlcpcb') url.searchParams.set('isSearch', 'true');
  url.searchParams.set(normalizedProvider === 'jlcpcb' ? 'searchTxt' : 'q', partNumber);
  if (normalizedProvider === 'jlcpcb') {
    return { label: 'Search JLCPCB', url: url.href, kind: 'supplier-search' };
  }
  url.searchParams.set('type', '1');
  return { label: 'Search LCSC', url: url.href, kind: 'supplier-search' };
}
