import { useEffect, useMemo, useState } from 'react';
import type { Settings, InventoryExportTemplate } from '../../../../shared/src';
import { Button } from '@/components/ui/button';

type GrundnerState = Settings['grundner'];

const DEFAULT_GRUNDNER: GrundnerState = {
  tableColumns: {
    typeData: { visible: true, order: 1 },
    materialName: { visible: false, order: 2 },
    materialNumber: { visible: false, order: 3 },
    customerId: { visible: true, order: 4 },
    lengthMm: { visible: true, order: 5 },
    widthMm: { visible: true, order: 6 },
    thicknessMm: { visible: true, order: 7 },
    stock: { visible: true, order: 8 },
    reservedStock: { visible: true, order: 9 },
    stockAvailable: { visible: true, order: 10 },
    lastUpdated: { visible: true, order: 11 }
  }
};

type ColumnKey = keyof GrundnerState['tableColumns'];
const COLUMN_LABELS: Array<{ key: ColumnKey; label: string }> = [
  { key: 'typeData', label: 'Type' },
  { key: 'materialName', label: 'Material Name' },
  { key: 'materialNumber', label: 'Material Number' },
  { key: 'customerId', label: 'Customer ID' },
  { key: 'lengthMm', label: 'Length' },
  { key: 'widthMm', label: 'Width' },
  { key: 'thicknessMm', label: 'Thickness' },
  { key: 'stock', label: 'Stock' },
  { key: 'reservedStock', label: 'Reserved Stock' },
  { key: 'stockAvailable', label: 'Available' },
  { key: 'lastUpdated', label: 'Last Updated' }
];

type PreviewTableState =
  | { kind: 'empty' }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'error'; message: string };

function parseCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = line[i + 1];
        if (next === '"') {
          current += '"';
          i++;
          continue;
        }
        inQuotes = false;
        continue;
      }

      current += ch;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === delimiter) {
      cells.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  cells.push(current);
  return cells;
}

function parseCsvText(text: string, delimiter: string): string[][] {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.map((line) => parseCsvLine(line, delimiter));
}

function buildPreviewTemplate(visibleKeys: ColumnKey[], tableColumns: GrundnerState['tableColumns']): InventoryExportTemplate {
  const headerFor = (key: ColumnKey): string => COLUMN_LABELS.find((c) => c.key === key)?.label ?? String(key);
  const fieldFor = (key: ColumnKey) => {
    switch (key) {
      case 'typeData':
        return 'typeData' as const;
      case 'customerId':
        return 'customerId' as const;
      case 'materialName':
        return 'materialName' as const;
      case 'materialNumber':
        return 'materialNumber' as const;
      case 'lengthMm':
        return 'lengthMm' as const;
      case 'widthMm':
        return 'widthMm' as const;
      case 'thicknessMm':
        return 'thicknessMm' as const;
      case 'stock':
        return 'stock' as const;
      case 'reservedStock':
        return 'reservedStock' as const;
      case 'stockAvailable':
        return 'stockAvailable' as const;
      case 'lastUpdated':
        return 'lastUpdated' as const;
      default:
        return 'typeData' as const;
    }
  };

  const orderedVisible = visibleKeys
    .filter((k) => tableColumns[k].visible)
    .sort((a, b) => tableColumns[a].order - tableColumns[b].order);

  return {
    delimiter: ',',
    lastUpdatedFormat: 'hh:mm dd.mm.yyyy',
    columns: orderedVisible.map((key) => ({
      kind: 'field' as const,
      enabled: true,
      header: headerFor(key),
      field: fieldFor(key)
    }))
  };
}

export function GrundnerSettings() {
  const [tableColumns, setTableColumns] = useState<GrundnerState['tableColumns']>(DEFAULT_GRUNDNER.tableColumns);
  const [saving, setSaving] = useState(false);
  const [draggingKey, setDraggingKey] = useState<ColumnKey | null>(null);
  const [columnOrderError, setColumnOrderError] = useState<string | null>(null);
  const [previewCsv, setPreviewCsv] = useState<string>('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const normalizeTableColumns = (raw: unknown): GrundnerState['tableColumns'] => {
    const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const out: GrundnerState['tableColumns'] = { ...DEFAULT_GRUNDNER.tableColumns };
    for (const { key } of COLUMN_LABELS) {
      const value = record?.[key as string];
      if (typeof value === 'boolean') {
        out[key] = { ...out[key], visible: value };
        continue;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const col = value as Record<string, unknown>;
        const visible = typeof col.visible === 'boolean' ? col.visible : out[key].visible;
        const order = typeof col.order === 'number' && Number.isInteger(col.order) && col.order >= 1 ? col.order : out[key].order;
        out[key] = { visible, order };
      }
    }
    return out;
  };

  useEffect(() => {
    (async () => {
      const res = await window.api.settings.get();
      if (res.ok) {
        if (res.value.grundner?.tableColumns) {
          setTableColumns(normalizeTableColumns(res.value.grundner.tableColumns));
        }
      }
    })();
  }, []);

  const visibleKeys = useMemo(
    () =>
      COLUMN_LABELS
        .map((c) => c.key)
        .filter((key) => tableColumns[key].visible)
        .sort((a, b) => tableColumns[a].order - tableColumns[b].order),
    [tableColumns]
  );

  const previewTemplate = useMemo(() => buildPreviewTemplate(visibleKeys, tableColumns), [tableColumns, visibleKeys]);

  const previewTable = useMemo<PreviewTableState>(() => {
    if (!previewCsv.trim()) return { kind: 'empty' };
    try {
      const rows = parseCsvText(previewCsv, previewTemplate.delimiter);
      if (rows.length === 0) return { kind: 'empty' };
      const [header, ...body] = rows;
      return { kind: 'table', header, rows: body };
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }, [previewCsv, previewTemplate.delimiter]);

  const previewColWidths = useMemo(() => {
    if (previewTable.kind !== 'table') return [] as number[];

    const minPx = 30;
    const maxPx = 150;
    const paddingPx = 24;
    const approxCharPx = 6;

    const colCount = previewTable.header.length;
    const widths: number[] = [];

    for (let col = 0; col < colCount; col++) {
      let maxLen = previewTable.header[col]?.length ?? 0;
      for (const row of previewTable.rows) {
        const len = row[col]?.length ?? 0;
        if (len > maxLen) maxLen = len;
      }

      const estimate = maxLen * approxCharPx + paddingPx;
      widths[col] = Math.max(minPx, Math.min(maxPx, estimate));
    }

    return widths;
  }, [previewTable]);

  useEffect(() => {
    let cancelled = false;
    const timeout = setTimeout(() => {
      (async () => {
        setPreviewLoading(true);
        setPreviewError(null);

        const res = await window.api.grundner.previewCustomCsv({ template: previewTemplate, limit: 5 });
        if (cancelled) return;

        if (!res.ok) {
          setPreviewError(res.error.message || 'Failed to generate preview');
          setPreviewCsv('');
          setPreviewLoading(false);
          return;
        }

        const raw = res.value.csv;
        const withoutBom = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
        setPreviewCsv((prev) => (prev === withoutBom ? prev : withoutBom));
        setPreviewLoading(false);
      })().catch((err) => {
        if (cancelled) return;
        setPreviewError(err instanceof Error ? err.message : String(err));
        setPreviewCsv('');
        setPreviewLoading(false);
      });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [previewTemplate]);

  const validateVisibleOrders = (next: GrundnerState['tableColumns']): string | null => {
    const orders = new Map<number, ColumnKey>();
    for (const key of COLUMN_LABELS.map((c) => c.key)) {
      const col = next[key];
      if (!col.visible) continue;
      const order = col.order;
      if (!Number.isInteger(order) || order < 1) return 'Column order must be a whole number starting from 1.';
      const existing = orders.get(order);
      if (existing) return `Duplicate column order ${order} for "${existing}" and "${key}".`;
      orders.set(order, key);
    }
    return null;
  };

  useEffect(() => {
    setColumnOrderError(validateVisibleOrders(tableColumns));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableColumns]);

  const setVisibility = (key: ColumnKey, visible: boolean) => {
    setTableColumns((prev) => {
      const current = prev[key];
      if (current.visible === visible) return prev;
      const next = { ...prev };
      if (!visible) {
        next[key] = { ...current, visible: false };
        return next;
      }

      const maxOrder = Math.max(0, ...COLUMN_LABELS.map((c) => (prev[c.key].visible ? prev[c.key].order : 0)));
      next[key] = { ...current, visible: true, order: maxOrder + 1 };
      return next;
    });
  };

  const reorderByDrag = (dragKey: ColumnKey, dropKey: ColumnKey) => {
    if (dragKey === dropKey) return;
    setTableColumns((prev) => {
      const ordered = COLUMN_LABELS
        .map((c) => c.key)
        .filter((key) => prev[key].visible)
        .sort((a, b) => prev[a].order - prev[b].order);

      const from = ordered.indexOf(dragKey);
      const to = ordered.indexOf(dropKey);
      if (from < 0 || to < 0) return prev;

      const nextOrder = [...ordered];
      nextOrder.splice(from, 1);
      nextOrder.splice(to, 0, dragKey);

      const next = { ...prev };
      for (let i = 0; i < nextOrder.length; i++) {
        const key = nextOrder[i];
        next[key] = { ...next[key], order: i + 1 };
      }
      return next;
    });
  };


  const handleSave = async () => {
    const orderError = validateVisibleOrders(tableColumns);
    if (orderError) {
      alert(orderError);
      return;
    }

    setSaving(true);

    const currentSettings = await window.api.settings.get();
    if (!currentSettings.ok) {
      alert('Failed to load current settings');
      setSaving(false);
      return;
    }

    const updatedSettings = {
      ...currentSettings.value,
      grundner: {
        ...(currentSettings.value.grundner ?? DEFAULT_GRUNDNER),
        tableColumns
      }
    };

    const saved = await window.api.settings.save(updatedSettings);
    if (saved.ok) {
      alert('Settings saved successfully');
    } else {
      alert('Failed to save settings');
    }

    setSaving(false);
  };

  return (
    <div className="space-y-6">
      {/* Grundner Settings Section */}
      <div className="space-y-4">
        <h4 className="text-base font-semibold text-foreground/80 tracking-wide">Grundner Settings</h4>

        <div className="text-sm text-muted-foreground">
          Sheet identity is based on Type Data.
        </div>
      </div>

      {/* Grundner Table Columns */}
      <div className="space-y-4">
        <h4 className="text-base font-semibold text-foreground/80 tracking-wide">Grundner Table Columns</h4>
        <p className="text-sm text-muted-foreground">
          Tick which columns should be shown on the Grundner page. Drag rows to change the visible column order.
          This does not affect CSV export templates.
        </p>

        {columnOrderError ? (
          <div className="text-sm text-destructive">{columnOrderError}</div>
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {COLUMN_LABELS.map((col) => (
            <label key={col.key} className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={tableColumns[col.key].visible}
                onChange={(e) => setVisibility(col.key, e.target.checked)}
                className="w-4 h-4 rounded border-border text-primary focus:ring-primary/50"
              />
              <span className="text-sm">{col.label}</span>
            </label>
          ))}
        </div>

        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Visible column order</p>
          <div className="flex flex-wrap gap-2 w-full">
            {visibleKeys.map((key) => {
              const label = COLUMN_LABELS.find((c) => c.key === key)?.label ?? String(key);
              const order = tableColumns[key].order;
              return (
                <div
                  key={key}
                  draggable
                  onDragStart={() => setDraggingKey(key)}
                  onDragEnd={() => setDraggingKey(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (!draggingKey) return;
                    reorderByDrag(draggingKey, key);
                    setDraggingKey(null);
                  }}
                  className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2 w-[260px]"
                  title="Drag to reorder"
                >
                  <span className="text-muted-foreground cursor-grab select-none" aria-hidden="true">
                    ⋮⋮
                  </span>
                  <div className="flex items-center gap-2 text-sm w-full">
                    <span className="w-6 text-muted-foreground">{order}</span>
                    <span className="flex-1">{label}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-3 w-full">
          <h5 className="text-sm font-semibold">Preview</h5>
          <div className="rounded-md border border-border bg-muted/20 p-3 w-full">
            {previewLoading ? (
              <div className="text-sm text-muted-foreground">Generating preview...</div>
            ) : previewError ? (
              <div className="text-sm text-destructive">{previewError}</div>
            ) : previewTable.kind === 'error' ? (
              <div className="text-sm text-destructive">{previewTable.message}</div>
            ) : previewTable.kind === 'empty' ? (
              <div className="text-sm text-muted-foreground">No data to preview yet.</div>
            ) : (
              <div className="max-h-48 overflow-auto">
                <table className="w-full text-sm text-foreground/90 border-separate border-spacing-0">
                  <thead className="bg-muted/40 sticky top-0">
                    <tr>
                      {previewTable.header.map((cell, idx) => (
                        <th
                          key={idx}
                          title={cell}
                          style={{ width: previewColWidths[idx], maxWidth: previewColWidths[idx] }}
                          className="px-2 py-1 text-left font-medium border-b border-border truncate"
                        >
                          {cell}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewTable.rows.map((row, rowIdx) => (
                      <tr key={rowIdx} className={rowIdx % 2 === 0 ? 'bg-background' : 'bg-muted/10'}>
                        {row.map((cell, cellIdx) => (
                          <td
                            key={cellIdx}
                            title={cell}
                            style={{ width: previewColWidths[cellIdx], maxWidth: previewColWidths[cellIdx] }}
                            className="px-2 py-1 border-b border-border align-top truncate"
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Save Button */}
      <Button size="sm" onClick={handleSave} disabled={saving}>
        Save Settings
      </Button>
    </div>
  );
}
