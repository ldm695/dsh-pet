/**
 * Parse a single byte range for the Electron asset bridge.
 * Invalid and multi-range requests intentionally fall back to a full response.
 * @param {string | null} header
 * @param {number} totalBytes
 * @returns {{start: number, end: number} | 'unsatisfiable' | null}
 */
function parseRange(header, totalBytes) {
  if (!header || totalBytes <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (startText === '' && endText === '') return null;

  if (startText === '') {
    const suffixLength = Number(endText);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, totalBytes - suffixLength), end: totalBytes - 1 };
  }

  const start = Number(startText);
  const end = endText === '' ? totalBytes - 1 : Number(endText);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= totalBytes) return 'unsatisfiable';
  return { start, end: Math.min(end, totalBytes - 1) };
}

module.exports = { parseRange };
