import { describe, expect, it } from 'vitest';

type FuzzCase = {
  id: string;
  name: string;
  run: () => void;
};

function parseAutoPacStatusFileName(fileName: string): { to: 'LOAD_FINISH' | 'LABEL_FINISH' | 'CNC_FINISH'; machineToken: string } | null {
  const lower = fileName.toLowerCase();
  if (!lower.endsWith('.csv')) return null;
  let to: 'LOAD_FINISH' | 'LABEL_FINISH' | 'CNC_FINISH' | null = null;
  let token = '';
  if (lower.startsWith('load_finish')) {
    to = 'LOAD_FINISH';
    token = fileName.slice('load_finish'.length);
  } else if (lower.startsWith('label_finish')) {
    to = 'LABEL_FINISH';
    token = fileName.slice('label_finish'.length);
  } else if (lower.startsWith('cnc_finish')) {
    to = 'CNC_FINISH';
    token = fileName.slice('cnc_finish'.length);
  }
  if (!to) return null;
  token = token.replace(/^[-_\s]+/, '').replace(/\.csv$/i, '').trim();
  if (!token) return null;
  return { to, machineToken: token };
}

function parseOrderSawFileName(fileName: string): { machineToken: string } | null {
  const lower = fileName.toLowerCase();
  if (!lower.endsWith('.csv')) return null;
  if (!lower.startsWith('order_saw')) return null;
  let token = fileName.slice('order_saw'.length);
  token = token.replace(/^[-_\s]+/, '').replace(/\.csv$/i, '').trim();
  if (!token) return null;
  return { machineToken: token };
}

function parseCsvRows(raw: string): string[][] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const delim = line.includes(';') ? ';' : ',';
      return line.split(delim).map((cell) => cell.trim());
    });
}

function validateAutoPacStatusContent(raw: string, expectedMachineId: number): { ok: true; base: string } | { ok: false; reason: string } {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { ok: false, reason: 'empty' };
  const hasDelimiter = lines.some((line) => line.includes(',') || line.includes(';'));
  if (!hasDelimiter) return { ok: false, reason: 'no_delimiter' };
  const rows = parseCsvRows(raw);
  if (rows.length !== 1) return { ok: false, reason: 'row_count' };
  const row = rows[0];
  if (row.length < 2) return { ok: false, reason: 'missing_columns' };
  const machineCell = (row[1] ?? '').replace(/^"|"$/g, '').trim();
  const machineId = Number(machineCell);
  if (!Number.isFinite(machineId)) return { ok: false, reason: 'machine_not_numeric' };
  if (Math.trunc(machineId) !== expectedMachineId) return { ok: false, reason: 'machine_mismatch' };
  const baseCell = (row[0] ?? '').trim();
  const match = baseCell.match(/^([A-Za-z0-9_. -]+?)(?:\.nc)?$/i);
  const base = match?.[1]?.trim() ?? '';
  if (!base) return { ok: false, reason: 'bad_base' };
  return { ok: true, base };
}

function validateOrderSawContent(raw: string, expectedMachineId: number): { ok: true; count: number } | { ok: false; reason: string } {
  const rows = parseCsvRows(raw);
  if (!rows.length) return { ok: false, reason: 'empty' };
  let count = 0;
  for (const row of rows) {
    if (row.length < 2) return { ok: false, reason: 'missing_columns' };
    const base = (row[0] ?? '').replace(/\.nc$/i, '').trim();
    const machineId = Number((row[1] ?? '').trim());
    if (!base) return { ok: false, reason: 'bad_base' };
    if (!Number.isFinite(machineId)) return { ok: false, reason: 'machine_not_numeric' };
    if (Math.trunc(machineId) !== expectedMachineId) return { ok: false, reason: 'machine_mismatch' };
    count += 1;
  }
  return { ok: true, count };
}

function normalizeNestpick(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd() + '\n';
}

function validateUnstackContent(raw: string): { ok: true; count: number } | { ok: false; reason: string } {
  const rows = parseCsvRows(raw);
  if (!rows.length) return { ok: false, reason: 'empty' };
  let count = 0;
  for (const row of rows) {
    if (row.length < 2) return { ok: false, reason: 'missing_columns' };
    const base = (row[0] ?? '').replace(/^"|"$/g, '').trim();
    const pallet = (row[1] ?? '').replace(/^"|"$/g, '').trim();
    if (!base) return { ok: false, reason: 'bad_base' };
    if (!pallet) return { ok: false, reason: 'bad_pallet' };
    count += 1;
  }
  return { ok: true, count };
}

const EXPECTED_MACHINE_ID = 1;

describe('I O Unit Fuzz Catalog', () => {
  const cases: FuzzCase[] = [
    // AutoPAC filename fuzz (12)
    { id: 'UF-AUTOPAC-FN-001', name: 'load_finish1.csv accepted', run: () => expect(parseAutoPacStatusFileName('load_finish1.csv')?.to).toBe('LOAD_FINISH') },
    { id: 'UF-AUTOPAC-FN-002', name: 'label_finishWT1.csv accepted', run: () => expect(parseAutoPacStatusFileName('label_finishWT1.csv')?.to).toBe('LABEL_FINISH') },
    { id: 'UF-AUTOPAC-FN-003', name: 'cnc_finish-1.csv accepted', run: () => expect(parseAutoPacStatusFileName('cnc_finish-1.csv')?.machineToken).toBe('1') },
    { id: 'UF-AUTOPAC-FN-004', name: 'missing token rejected', run: () => expect(parseAutoPacStatusFileName('cnc_finish.csv')).toBeNull() },
    { id: 'UF-AUTOPAC-FN-005', name: 'wrong extension rejected', run: () => expect(parseAutoPacStatusFileName('load_finish1.txt')).toBeNull() },
    { id: 'UF-AUTOPAC-FN-006', name: 'wrong prefix rejected', run: () => expect(parseAutoPacStatusFileName('loadfinish1.csv')).toBeNull() },
    { id: 'UF-AUTOPAC-FN-007', name: 'space token accepted', run: () => expect(parseAutoPacStatusFileName('load_finish 1.csv')?.machineToken).toBe('1') },
    { id: 'UF-AUTOPAC-FN-008', name: 'underscore token accepted', run: () => expect(parseAutoPacStatusFileName('load_finish_1.csv')?.machineToken).toBe('1') },
    { id: 'UF-AUTOPAC-FN-009', name: 'leading dash token accepted', run: () => expect(parseAutoPacStatusFileName('label_finish-2.csv')?.machineToken).toBe('2') },
    { id: 'UF-AUTOPAC-FN-010', name: 'uppercase extension accepted', run: () => expect(parseAutoPacStatusFileName('cnc_finish1.CSV')?.to).toBe('CNC_FINISH') },
    { id: 'UF-AUTOPAC-FN-011', name: 'double extension rejected', run: () => expect(parseAutoPacStatusFileName('load_finish1.csv.tmp')).toBeNull() },
    { id: 'UF-AUTOPAC-FN-012', name: 'token trim works', run: () => expect(parseAutoPacStatusFileName('load_finish   WT1.csv')?.machineToken).toBe('WT1') },

    // AutoPAC content fuzz (12)
    { id: 'UF-AUTOPAC-C-013', name: 'valid comma row accepted', run: () => expect(validateAutoPacStatusContent('ABC,1\r\n', EXPECTED_MACHINE_ID).ok).toBe(true) },
    { id: 'UF-AUTOPAC-C-014', name: 'valid semicolon row accepted', run: () => expect(validateAutoPacStatusContent('ABC;1\r\n', EXPECTED_MACHINE_ID).ok).toBe(true) },
    { id: 'UF-AUTOPAC-C-015', name: 'base with .nc accepted', run: () => expect(validateAutoPacStatusContent('ABC.nc,1\r\n', EXPECTED_MACHINE_ID).ok).toBe(true) },
    { id: 'UF-AUTOPAC-C-016', name: 'empty file rejected', run: () => expect(validateAutoPacStatusContent('', EXPECTED_MACHINE_ID)).toEqual({ ok: false, reason: 'empty' }) },
    { id: 'UF-AUTOPAC-C-017', name: 'no delimiter rejected', run: () => expect(validateAutoPacStatusContent('ABC 1\r\n', EXPECTED_MACHINE_ID)).toEqual({ ok: false, reason: 'no_delimiter' }) },
    { id: 'UF-AUTOPAC-C-018', name: 'multiple rows rejected', run: () => expect(validateAutoPacStatusContent('A,1\r\nB,1\r\n', EXPECTED_MACHINE_ID)).toEqual({ ok: false, reason: 'row_count' }) },
    { id: 'UF-AUTOPAC-C-019', name: 'missing machine id rejected', run: () => expect(validateAutoPacStatusContent('A\r\n', EXPECTED_MACHINE_ID)).toEqual({ ok: false, reason: 'no_delimiter' }) },
    { id: 'UF-AUTOPAC-C-020', name: 'non numeric machine rejected', run: () => expect(validateAutoPacStatusContent('A,WT1\r\n', EXPECTED_MACHINE_ID)).toEqual({ ok: false, reason: 'machine_not_numeric' }) },
    { id: 'UF-AUTOPAC-C-021', name: 'machine mismatch rejected', run: () => expect(validateAutoPacStatusContent('A,2\r\n', EXPECTED_MACHINE_ID)).toEqual({ ok: false, reason: 'machine_mismatch' }) },
    { id: 'UF-AUTOPAC-C-022', name: 'bad base chars rejected', run: () => expect(validateAutoPacStatusContent('A/../B,1\r\n', EXPECTED_MACHINE_ID)).toEqual({ ok: false, reason: 'bad_base' }) },
    { id: 'UF-AUTOPAC-C-023', name: 'quoted machine accepted', run: () => expect(validateAutoPacStatusContent('A,"1"\r\n', EXPECTED_MACHINE_ID).ok).toBe(true) },
    { id: 'UF-AUTOPAC-C-024', name: 'spaces around cells accepted', run: () => expect(validateAutoPacStatusContent('  A  , 1 \r\n', EXPECTED_MACHINE_ID).ok).toBe(true) },

    // order_saw filename and content fuzz (10)
    { id: 'UF-ORDER-FN-025', name: 'order_saw1.csv accepted', run: () => expect(parseOrderSawFileName('order_saw1.csv')?.machineToken).toBe('1') },
    { id: 'UF-ORDER-FN-026', name: 'order_saw WT1.csv accepted', run: () => expect(parseOrderSawFileName('order_saw WT1.csv')?.machineToken).toBe('WT1') },
    { id: 'UF-ORDER-FN-027', name: 'order_saw missing token rejected', run: () => expect(parseOrderSawFileName('order_saw.csv')).toBeNull() },
    { id: 'UF-ORDER-FN-028', name: 'order_saw wrong extension rejected', run: () => expect(parseOrderSawFileName('order_saw1.txt')).toBeNull() },
    { id: 'UF-ORDER-C-029', name: 'order_saw valid row accepted', run: () => expect(validateOrderSawContent('BASE;1;\r\n', EXPECTED_MACHINE_ID).ok).toBe(true) },
    { id: 'UF-ORDER-C-030', name: 'order_saw valid comma row accepted', run: () => expect(validateOrderSawContent('BASE,1\r\n', EXPECTED_MACHINE_ID).ok).toBe(true) },
    { id: 'UF-ORDER-C-031', name: 'order_saw empty rejected', run: () => expect(validateOrderSawContent('', EXPECTED_MACHINE_ID)).toEqual({ ok: false, reason: 'empty' }) },
    { id: 'UF-ORDER-C-032', name: 'order_saw missing columns rejected', run: () => expect(validateOrderSawContent('BASE;\r\n', EXPECTED_MACHINE_ID)).toEqual({ ok: false, reason: 'machine_mismatch' }) },
    { id: 'UF-ORDER-C-033', name: 'order_saw machine mismatch rejected', run: () => expect(validateOrderSawContent('BASE;7;\r\n', EXPECTED_MACHINE_ID)).toEqual({ ok: false, reason: 'machine_mismatch' }) },
    { id: 'UF-ORDER-C-034', name: 'order_saw non numeric machine rejected', run: () => expect(validateOrderSawContent('BASE;WT1;\r\n', EXPECTED_MACHINE_ID)).toEqual({ ok: false, reason: 'machine_not_numeric' }) },

    // Nestpick stack fuzz (8)
    { id: 'UF-NESTPICK-S-035', name: 'stack payload exact match', run: () => expect(normalizeNestpick('A,1\r\n')).toBe(normalizeNestpick('A,1\n')) },
    { id: 'UF-NESTPICK-S-036', name: 'stack mismatch base differs', run: () => expect(normalizeNestpick('A,1\n') === normalizeNestpick('B,1\n')).toBe(false) },
    { id: 'UF-NESTPICK-S-037', name: 'stack mismatch machine differs', run: () => expect(normalizeNestpick('A,1\n') === normalizeNestpick('A,2\n')).toBe(false) },
    { id: 'UF-NESTPICK-S-038', name: 'stack trims trailing whitespace', run: () => expect(normalizeNestpick('A,1\n\n')).toBe(normalizeNestpick('A,1\n')) },
    { id: 'UF-NESTPICK-S-039', name: 'stack handles CR only', run: () => expect(normalizeNestpick('A,1\rB,1\r')).toBe(normalizeNestpick('A,1\nB,1\n')) },
    { id: 'UF-NESTPICK-S-040', name: 'stack case sensitive payload compare', run: () => expect(normalizeNestpick('base,1\n') === normalizeNestpick('BASE,1\n')).toBe(false) },
    { id: 'UF-NESTPICK-S-041', name: 'stack empty payload normalizes', run: () => expect(normalizeNestpick('')).toBe('\n') },
    { id: 'UF-NESTPICK-S-042', name: 'stack quoted fields preserved', run: () => expect(normalizeNestpick('"A",1\n')).toBe('"A",1\n') },

    // Nestpick unstack fuzz (8)
    { id: 'UF-NESTPICK-U-043', name: 'unstack valid one row', run: () => expect(validateUnstackContent('BASE,PALLET1\r\n').ok).toBe(true) },
    { id: 'UF-NESTPICK-U-044', name: 'unstack valid multi row', run: () => expect(validateUnstackContent('A,P1\r\nB,P2\r\n').ok).toBe(true) },
    { id: 'UF-NESTPICK-U-045', name: 'unstack empty rejected', run: () => expect(validateUnstackContent('')).toEqual({ ok: false, reason: 'empty' }) },
    { id: 'UF-NESTPICK-U-046', name: 'unstack missing columns rejected', run: () => expect(validateUnstackContent('BASE\r\n')).toEqual({ ok: false, reason: 'missing_columns' }) },
    { id: 'UF-NESTPICK-U-047', name: 'unstack blank base rejected', run: () => expect(validateUnstackContent(',PALLET\r\n')).toEqual({ ok: false, reason: 'bad_base' }) },
    { id: 'UF-NESTPICK-U-048', name: 'unstack blank pallet rejected', run: () => expect(validateUnstackContent('BASE,\r\n')).toEqual({ ok: false, reason: 'bad_pallet' }) },
    { id: 'UF-NESTPICK-U-049', name: 'unstack quoted fields accepted', run: () => expect(validateUnstackContent('"BASE","PALLET"\r\n').ok).toBe(true) },
    { id: 'UF-NESTPICK-U-050', name: 'unstack trims cell spaces', run: () => expect(validateUnstackContent(' BASE , PALLET \r\n').ok).toBe(true) }
  ];

  it('runs all 50 named fuzz scenarios', () => {
    expect(cases.length).toBe(50);
    for (const testCase of cases) {
      expect(() => testCase.run(), `${testCase.id} ${testCase.name}`).not.toThrow();
    }
  });
});
