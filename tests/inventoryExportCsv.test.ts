import { describe, it, expect } from 'vitest';

import type { GrundnerRow } from '../packages/shared/src';
import { InventoryExportSettingsSchema } from '../packages/shared/src';
import { buildGrundnerCustomCsv, buildGrundnerStandardCsv } from '../packages/main/src/services/inventoryExportCsv';

describe('inventory export CSV', () => {
  it('builds a standard CSV with UTF-8 BOM and CRLF', () => {
    const rows: GrundnerRow[] = [
      {
        id: 1,
        typeData: 123,
        customerId: 'CUST',
        lengthMm: 1000,
        widthMm: 500,
        thicknessMm: 18,
        stock: 10,
        stockAvailable: 8,
        reservedStock: 2,
        preReserved: 0,
        lastUpdated: 'not-a-date'
      }
    ];

    const csv = buildGrundnerStandardCsv(rows);

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.includes('\r\n')).toBe(true);

    // Standard export is always comma-delimited.
    expect(csv).toContain('Type,Customer ID,Length,Width,Thickness');
    expect(csv).toContain('123,CUST,1000,500,18');

    // Invalid timestamp is passed through unchanged.
    expect(csv).toContain('not-a-date');
  });

  it('builds a custom CSV using the template delimiter and column mapping', () => {
    const settings = InventoryExportSettingsSchema.parse({
      template: {
        delimiter: ';',
        columns: [
          { enabled: true, header: 'MyType', field: 'typeData' },
          { enabled: false, header: 'Hidden', field: 'stock' },
          { enabled: true, header: 'MyCustomer', field: 'customerId' }
        ]
      },
      scheduled: {
        enabled: true,
        intervalSeconds: 30,
        onlyOnChange: true,
        folderPath: 'C:\\exports',
        fileName: 'inventory.csv'
      }
    });

    const rows: GrundnerRow[] = [
      {
        id: 1,
        typeData: 123,
        customerId: 'ACME;"Inc"',
        lengthMm: null,
        widthMm: null,
        thicknessMm: null,
        stock: 10,
        stockAvailable: null,
        reservedStock: null,
        preReserved: null,
        lastUpdated: null
      }
    ];

    const csv = buildGrundnerCustomCsv(rows, settings.template);

    expect(csv.startsWith('\uFEFF')).toBe(true);

    // Header uses user-defined column names.
    expect(csv).toContain('MyType;MyCustomer');

    // The value containing delimiter/quotes must be quoted and quotes doubled.
    expect(csv).toContain('123;"ACME;""Inc"""');
  });

  it('rejects invalid delimiter and missing extension when scheduled export enabled', () => {
    const res = InventoryExportSettingsSchema.safeParse({
      template: {
        delimiter: ',,',
        columns: [{ enabled: true, header: 'Type', field: 'typeData' }]
      },
      scheduled: {
        enabled: true,
        intervalSeconds: 30,
        onlyOnChange: true,
        folderPath: 'C:\\exports',
        fileName: 'inventory'
      }
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      const messages = res.error.issues.map((i) => i.message).join(' | ');
      expect(messages).toMatch(/Delimiter/);
      expect(messages).toMatch(/extension/);
    }
  });
});
