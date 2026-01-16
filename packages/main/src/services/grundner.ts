import { loadConfig } from './config';

type GrundnerColumn = 'type_data' | 'customer_id';


export function getGrundnerLookupColumn(): GrundnerColumn {
  const cfg = loadConfig();
  return cfg.test.sheetIdMode === 'customer_id' ? 'customer_id' : 'type_data';
}



export function resolveMaterialKey(column: GrundnerColumn, row: { typeData: number | null; customerId: string | null }): string | null {
  if (column === 'customer_id') {
    return row.customerId?.trim() ?? null;
  }
  if (row.typeData == null) return null;
  return String(row.typeData);
}
