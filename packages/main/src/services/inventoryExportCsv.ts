import type { GrundnerRow, InventoryExportFieldKey, InventoryExportTemplate } from '../../../shared/src';

function formatTimestampForCsv(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;

  const pad2 = (n: number) => String(n).padStart(2, '0');

  const hours = pad2(d.getHours());
  const minutes = pad2(d.getMinutes());
  const day = pad2(d.getDate());
  const month = pad2(d.getMonth() + 1);
  const year = String(d.getFullYear());

  // Requested format: hh:mm dd.mm.yyyy
  return `${hours}:${minutes} ${day}.${month}.${year}`;
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

function formatGrundnerField(row: GrundnerRow, field: InventoryExportFieldKey, mode: 'standard' | 'custom'): string {
  switch (field) {
    case 'typeData':
      return row.typeData != null ? String(row.typeData) : '';
    case 'customerId':
      return row.customerId ?? '';
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
      formatGrundnerField(row, 'typeData', 'standard'),
      formatGrundnerField(row, 'customerId', 'standard'),
      formatGrundnerField(row, 'lengthMm', 'standard'),
      formatGrundnerField(row, 'widthMm', 'standard'),
      formatGrundnerField(row, 'thicknessMm', 'standard'),
      formatGrundnerField(row, 'preReserved', 'standard'),
      formatGrundnerField(row, 'stock', 'standard'),
      formatGrundnerField(row, 'reservedStock', 'standard'),
      formatGrundnerField(row, 'stockAvailable', 'standard'),
      formatGrundnerField(row, 'lastUpdated', 'standard')
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
    const values = enabledColumns.map((col) => formatGrundnerField(row, col.field, 'custom'));
    lines.push(values.map((v) => escapeCsvCell(normalizeCellValue(v), delimiter)).join(delimiter));
  }

  return `\uFEFF${lines.join('\r\n')}`;
}
