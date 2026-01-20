import type { GrundnerRow, InventoryExportFieldKey, InventoryExportTemplate } from '../../../shared/src';

function formatTimestampForCsv(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;

  const pad2 = (n: number) => String(n).padStart(2, '0');

  const hours = pad2(d.getHours());
  const minutes = pad2(d.getMinutes());
  const seconds = pad2(d.getSeconds());
  const day = pad2(d.getDate());
  const month = pad2(d.getMonth() + 1);
  const year = String(d.getFullYear());

  // Requested format: hh:mm dd.mm.yyyy
  return `${hours}:${minutes} ${day}.${month}.${year}`;
}

function formatTimestampWithPattern(value: string, pattern: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;

  const pad2 = (n: number) => String(n).padStart(2, '0');
  const hours = pad2(d.getHours());
  const minutes = pad2(d.getMinutes());
  const seconds = pad2(d.getSeconds());
  const day = pad2(d.getDate());
  const month = pad2(d.getMonth() + 1);
  const year4 = String(d.getFullYear());
  const year2 = year4.slice(-2);

  const p = (pattern ?? '').trim();
  if (!p) return formatTimestampForCsv(value);

  // Supported tokens:
  // - Time: hh, mm, ss
  // - Date: dd, mm, yyyy, yy
  // Note: `mm` is ambiguous (minutes vs month). We resolve by context:
  // - minutes if previous token was hh or next token is ss
  // - month if previous token was dd or next token is yy/yyyy
  const tokens = ['yyyy', 'yy', 'hh', 'mm', 'ss', 'dd'] as const;

  const out: string[] = [];
  let i = 0;
  let prevToken: (typeof tokens)[number] | null = null;
  while (i < p.length) {
    let matched: (typeof tokens)[number] | null = null;
    for (const t of tokens) {
      if (p.startsWith(t, i)) {
        matched = t;
        break;
      }
    }
    if (!matched) {
      out.push(p[i]);
      i += 1;
      continue;
    }

    if (matched === 'mm') {
      const rest = p.slice(i + 2);
      const nextToken =
        rest.startsWith('ss') ? 'ss' : rest.startsWith('yyyy') ? 'yyyy' : rest.startsWith('yy') ? 'yy' : null;

      const isMinutes = prevToken === 'hh' || nextToken === 'ss';
      const isMonth = prevToken === 'dd' || nextToken === 'yyyy' || nextToken === 'yy';

      if (isMinutes && !isMonth) out.push(minutes);
      else if (isMonth && !isMinutes) out.push(month);
      else out.push(minutes);
    } else if (matched === 'hh') out.push(hours);
    else if (matched === 'ss') out.push(seconds);
    else if (matched === 'dd') out.push(day);
    else if (matched === 'yyyy') out.push(year4);
    else if (matched === 'yy') out.push(year2);

    prevToken = matched;
    i += matched.length;
  }

  return out.join('');
}

function escapeCsvCell(value: string, delimiter: string): string {
  // Standard CSV escaping: quote the cell if it contains quotes, newlines, or delimiter.
  // Note: delimiter is configurable for the custom export.
  if (value.includes('"')) {
    value = value.replace(/"/g, '""');
  }
  if (value.includes('\r') || value.includes('\n') || value.includes(delimiter) || value.includes('"')) {
    return `"${value}"`;
  }
  return value;
}

function normalizeCellValue(value: unknown): string {
  if (value == null) return '';
  return String(value);
}

function formatGrundnerField(
  row: GrundnerRow,
  field: InventoryExportFieldKey,
  mode: 'standard' | 'custom',
  template: InventoryExportTemplate | null
): string {
  switch (field) {
    case 'typeData':
      return row.typeData != null ? String(row.typeData) : '';
    case 'customerId':
      return row.customerId ?? '';
    case 'materialName':
      return row.materialName ?? '';
    case 'materialNumber':
      return row.materialNumber != null ? String(row.materialNumber) : '';
    case 'lengthMm':
      return row.lengthMm != null ? String(row.lengthMm) : '';
    case 'widthMm':
      return row.widthMm != null ? String(row.widthMm) : '';
    case 'thicknessMm':
      return row.thicknessMm != null ? String(row.thicknessMm) : '';
    case 'preReserved':
      return row.preReserved != null ? String(row.preReserved) : '';
    case 'stock':
      return row.stock != null ? String(row.stock) : '';
    case 'reservedStock':
      return row.reservedStock != null ? String(row.reservedStock) : '';
    case 'stockAvailable':
      return row.stockAvailable != null ? String(row.stockAvailable) : '';
    case 'lastUpdated':
      if (!row.lastUpdated) return '';
      // Standard export is intended for humans to view, so keep the existing UI-friendly timestamp.
      // Custom export is also used by the scheduler for ingestion, so keep it stable/parseable.
      if (mode === 'custom') {
        const pattern = template?.lastUpdatedFormat ?? '';
        return formatTimestampWithPattern(row.lastUpdated, pattern);
      }
      return formatTimestampForCsv(row.lastUpdated);
    default:
      return '';
  }
}

export function buildGrundnerStandardCsv(rows: GrundnerRow[]): string {
  const delimiter = ',';
  const header = [
    'Type',
    'Customer ID',
    'Length',
    'Width',
    'Thickness',
    'Pre-Reserved',
    'Stock',
    'Reserved',
    'Available',
    'Last Updated'
  ];

  const lines: string[] = [];
  lines.push(header.map((h) => escapeCsvCell(h, delimiter)).join(delimiter));

  for (const row of rows) {
    const values = [
      formatGrundnerField(row, 'typeData', 'standard', null),
      formatGrundnerField(row, 'customerId', 'standard', null),
      formatGrundnerField(row, 'lengthMm', 'standard', null),
      formatGrundnerField(row, 'widthMm', 'standard', null),
      formatGrundnerField(row, 'thicknessMm', 'standard', null),
      formatGrundnerField(row, 'preReserved', 'standard', null),
      formatGrundnerField(row, 'stock', 'standard', null),
      formatGrundnerField(row, 'reservedStock', 'standard', null),
      formatGrundnerField(row, 'stockAvailable', 'standard', null),
      formatGrundnerField(row, 'lastUpdated', 'standard', null)
    ];
    lines.push(values.map((v) => escapeCsvCell(normalizeCellValue(v), delimiter)).join(delimiter));
  }

  // Excel-friendly UTF-8 BOM + Windows line endings.
  return `\uFEFF${lines.join('\r\n')}`;
}

export function buildGrundnerCustomCsv(rows: GrundnerRow[], template: InventoryExportTemplate): string {
  const delimiter = template.delimiter || ',';
  const enabledColumns = (template.columns ?? []).filter((col) => col.enabled);

  const lines: string[] = [];
  lines.push(enabledColumns.map((col) => escapeCsvCell(col.header ?? '', delimiter)).join(delimiter));

  for (const row of rows) {
    const values = enabledColumns.map((col) => {
      if (col.kind === 'custom') return col.defaultValue ?? '';
      return formatGrundnerField(row, col.field, 'custom', template);
    });
    lines.push(values.map((v) => escapeCsvCell(normalizeCellValue(v), delimiter)).join(delimiter));
  }

  return `\uFEFF${lines.join('\r\n')}`;
}
