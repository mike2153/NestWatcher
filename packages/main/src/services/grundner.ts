type GrundnerColumn = 'type_data' | 'customer_id';

// NOTE: sheetIdMode is currently a placeholder setting.
// We always use type_data as the canonical material key.
export function getGrundnerLookupColumn(): GrundnerColumn {
  return 'type_data';
}

export function resolveMaterialKey(_column: GrundnerColumn, row: { typeData: number | null; customerId: string | null }): string | null {
  if (row.typeData == null) return null;
  return String(row.typeData);
}

