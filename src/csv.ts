/**
 * Minimal RFC 4180–compliant CSV serialiser with spreadsheet-injection protection.
 *
 * Injection protection: any cell value whose string representation begins with
 *   =  +  -  @  \t  \r
 * is prefixed with a single quote (') so that spreadsheet applications (Excel,
 * Google Sheets, LibreOffice Calc) treat the value as a text literal rather
 * than a formula.
 *
 * RFC 4180 quoting: values that contain a comma, double-quote, CR, or LF are
 * wrapped in double-quotes and any embedded double-quote is escaped as "".
 *
 * Line endings: CRLF as required by RFC 4180.
 */

const INJECTION_RE = /^[=+\-@\t\r]/;
const MUST_QUOTE_RE = /[",\r\n]/;

/** Sanitise and RFC 4180–encode a single cell value. */
export function csvCell(raw: string | number | boolean | null | undefined): string {
  const s = raw === null || raw === undefined ? '' : String(raw);

  // Injection protection: prefix dangerous leading characters with a literal '
  const safe = INJECTION_RE.test(s) ? `'${s}` : s;

  // RFC 4180: wrap in double-quotes and escape inner double-quotes if needed
  if (MUST_QUOTE_RE.test(safe) || safe.includes('"')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/** Serialise one row (array of values) to a CRLF-terminated CSV line. */
export function csvRow(values: (string | number | boolean | null | undefined)[]): string {
  return values.map(csvCell).join(',') + '\r\n';
}

/** Column header names in spec order. */
export const CSV_HEADERS = [
  'contract_id',
  'title',
  'role',
  'counterparty',
  'token',
  'status',
  'total_amount',
  'funded_amount',
  'released_amount',
  'outstanding_amount',
  'dispute_freelancer_bps',
  'created_at',
  'updated_at',
] as const;

export type CsvHeader = (typeof CSV_HEADERS)[number];
