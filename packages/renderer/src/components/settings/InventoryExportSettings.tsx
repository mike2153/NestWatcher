import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import {
  InventoryExportSettingsSchema,
  InventoryExportTemplateSchema,
  type InventoryExportFieldKey,
  type InventoryExportSettings
} from '../../../../shared/src';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FolderBrowseIconButton, InfoTipIcon } from '@/components/ui/icon-buttons';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

const FIELD_OPTIONS: Array<{ value: InventoryExportFieldKey; label: string }> = [
  { value: 'typeData', label: 'Type' },
  { value: 'customerId', label: 'Customer ID' },
  { value: 'materialName', label: 'Material Name' },
  { value: 'materialNumber', label: 'Material Number' },
  { value: 'lengthMm', label: 'Length' },
  { value: 'widthMm', label: 'Width' },
  { value: 'thicknessMm', label: 'Thickness' },
  { value: 'stock', label: 'Stock' },
  { value: 'reservedStock', label: 'Reserved' },
  { value: 'stockAvailable', label: 'Available' },
  { value: 'lastUpdated', label: 'Last Updated' }
];

const CUSTOM_FIELD_VALUE = '__custom__';

function defaultHeaderForField(field: InventoryExportFieldKey): string {
  switch (field) {
    case 'typeData':
      return 'type data';
    case 'customerId':
      return 'customer id';
    case 'materialName':
      return 'material name';
    case 'materialNumber':
      return 'material number';
    case 'lengthMm':
      return 'length';
    case 'widthMm':
      return 'width';
    case 'thicknessMm':
      return 'thickness';
    case 'stock':
      return 'stock';
    case 'reservedStock':
      return 'reserved stock';
    case 'stockAvailable':
      return 'stock av';
    case 'lastUpdated':
      return 'last updated';
    default:
      return field;
  }
}

function pathToLabel(path: Array<string | number>): string {
  if (!path.length) return 'settings';
  return path
    .map((part) => (typeof part === 'number' ? `[${part}]` : part))
    .join('.')
    .replace(/\.\[/g, '[');
}

function getDefaultInventoryExportSettings(): InventoryExportSettings {
  // The schema has .default set up so we can parse undefined.
  return InventoryExportSettingsSchema.parse(undefined);
}

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

export function InventoryExportSettings() {
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  const [draft, setDraft] = useState<InventoryExportSettings>(getDefaultInventoryExportSettings());
  const [fileNameUi, setFileNameUi] = useState('');
  const [previewCsv, setPreviewCsv] = useState<string>('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // React StrictMode runs effects twice in dev. Without a cancellation guard, the "first" async
    // request can resolve after the user starts typing and overwrite their in-progress edits,
    // which feels like the inputs are "locked" or "snapping back".
    let cancelled = false;
    (async () => {
      const res = await window.api.settings.get();
      if (cancelled) return;

      if (!res.ok) {
        setLoadState({ status: 'error', message: res.error.message });
        return;
      }

      const next = InventoryExportSettingsSchema.safeParse(res.value.inventoryExport);
      const parsed = next.success ? next.data : getDefaultInventoryExportSettings();
      setDraft(parsed);
      setFileNameUi(parsed.scheduled.fileName ?? '');
      setLoadState({ status: 'ready' });
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const validation = useMemo(() => InventoryExportSettingsSchema.safeParse(draft), [draft]);
  const templateValidation = useMemo(() => InventoryExportTemplateSchema.safeParse(draft.template), [draft.template]);

  const previewTable = useMemo<PreviewTableState>(() => {
    if (!previewCsv.trim()) return { kind: 'empty' };

    try {
      const rows = parseCsvText(previewCsv, draft.template.delimiter);
      if (rows.length === 0) return { kind: 'empty' };
      const [header, ...body] = rows;
      return { kind: 'table', header, rows: body };
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }, [previewCsv, draft.template.delimiter]);

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

  const validationIssues = useMemo(() => {
    if (validation.success) return [];
    return validation.error.issues.map((issue) => {
      const where = pathToLabel(issue.path);
      return `${where}: ${issue.message}`;
    });
  }, [validation]);

  const canSave = loadState.status === 'ready' && validation.success && !saving;

  useEffect(() => {
    if (loadState.status !== 'ready') return;

    if (!templateValidation.success) {
      setPreviewError('Fix template issues above to see a preview.');
      setPreviewCsv('');
      return;
    }

    let cancelled = false;
    const timeout = setTimeout(() => {
      (async () => {
        setPreviewLoading(true);
        setPreviewError(null);

        const res = await window.api.grundner.previewCustomCsv({
          template: templateValidation.data,
          limit: 5
        });

        if (cancelled) return;

        if (!res.ok) {
          setPreviewError(res.error.message || 'Failed to generate preview');
          setPreviewCsv('');
          setPreviewLoading(false);
          return;
        }

        const raw = res.value.csv;
        const withoutBom = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
        setPreviewCsv(withoutBom);
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
  }, [loadState.status, templateValidation]);

  const browseFolder = async () => {
    const res = await window.api.dialog.pickFolder();
    if (res.ok && res.value) {
      setDraft((prev) => ({
        ...prev,
        scheduled: {
          ...prev.scheduled,
          folderPath: res.value
        }
      }));
    }
  };

  const moveColumn = (index: number, direction: -1 | 1) => {
    setDraft((prev) => {
      const nextCols = [...prev.template.columns];
      const target = index + direction;
      if (target < 0 || target >= nextCols.length) return prev;
      const tmp = nextCols[index];
      nextCols[index] = nextCols[target];
      nextCols[target] = tmp;
      return {
        ...prev,
        template: {
          ...prev.template,
          columns: nextCols
        }
      };
    });
  };

  const handleSave = async () => {
    if (!validation.success) return;

    setSaving(true);

    const saved = await window.api.settings.save({ inventoryExport: validation.data });
    if (saved.ok) {
      const next = InventoryExportSettingsSchema.safeParse(saved.value.inventoryExport);
      if (next.success) {
        setDraft(next.data);
        setFileNameUi(next.data.scheduled.fileName ?? '');
      }
      alert('Inventory export settings saved successfully');
    } else {
      alert(saved.error.message || 'Failed to save inventory export settings');
    }

    setSaving(false);
  };

  if (loadState.status === 'loading') {
    return <div className="text-sm text-muted-foreground">Loading...</div>;
  }

  if (loadState.status === 'error') {
    return <div className="text-sm text-destructive">Failed to load: {loadState.message}</div>;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h4 className="text-base font-semibold text-foreground/80 tracking-wide">Custom CSV Template</h4>
        <p className="text-sm text-muted-foreground">
          This template controls the columns used by scheduled exports and by the &quot;Export Custom CSV&quot; button.
        </p>
      </div>

      {!validation.success ? (
        <div className="border border-destructive/30 bg-destructive/5 rounded-md p-3">
          <div className="text-sm font-medium text-destructive mb-2">Fix these before saving</div>
          <ul className="list-disc pl-5 text-xs text-destructive space-y-1">
            {validationIssues.map((msg) => (
              <li key={msg}>{msg}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="space-y-3">
        <label className="block text-sm font-medium">Delimiter</label>
        <div className="flex items-center gap-2">
          <Select
            value={draft.template.delimiter}
            onValueChange={(delimiter) => {
              setDraft((prev) => ({
                ...prev,
                template: {
                  ...prev.template,
                  delimiter
                }
              }));
            }}
          >
            <SelectTrigger className="w-20 h-8 text-center">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value=",">,</SelectItem>
              <SelectItem value=";">;</SelectItem>
              <SelectItem value="|">|</SelectItem>
              <SelectItem value="/">/</SelectItem>
              <SelectItem value="\">\</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Used by &quot;Export Custom CSV&quot; and scheduled export.</span>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <div className="space-y-3">
          {/*<h5 className="text-sm font-semibold">Columns</h5>*/}
          <div className="overflow-x-auto border border-border rounded-md">
            <table className="min-w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left">
                  <th className="p-2 w-8">On</th>
                  <th className="p-2 w-45">Column Name</th>
                  <th className="p-2 w-20">Maps To</th>
                  <th className="p-2 w-45">Default Value</th>
                  <th className="p-2 w-10">Order</th>
                  <th className="p-2 w-10">Remove</th>
                </tr>
              </thead>
              <tbody>
                {draft.template.columns.map((col, idx) => (
                  <tr
                    key={`${col.kind}-${col.kind === 'field' ? col.field : 'custom'}-${idx}`}
                    className="border-t border-border"
                  >
                    <td className="p-2">
                      <input
                        type="checkbox"
                        checked={col.enabled}
                        onChange={(e) => {
                          const enabled = e.target.checked;
                          setDraft((prev) => {
                            const nextCols = [...prev.template.columns];
                            nextCols[idx] = { ...nextCols[idx], enabled };
                            return { ...prev, template: { ...prev.template, columns: nextCols } };
                          });
                        }}
                      />
                    </td>
                    <td className="p-2">
                      <input
                        type="text"
                        className="w-full min-w-45 px-2 py-1 border border-border rounded-md bg-background"
                        value={col.header ?? ''}
                        onChange={(e) => {
                          const header = e.target.value;
                          setDraft((prev) => {
                            const nextCols = [...prev.template.columns];
                            nextCols[idx] = { ...nextCols[idx], header };
                            return { ...prev, template: { ...prev.template, columns: nextCols } };
                          });
                        }}
                        placeholder="Header"
                      />
                    </td>
                    <td className="p-2">
                      <Select
                        value={col.kind === 'custom' ? CUSTOM_FIELD_VALUE : col.field}
                        onValueChange={(value) => {
                          setDraft((prev) => {
                            const nextCols = [...prev.template.columns];
                            if (value === CUSTOM_FIELD_VALUE) {
                              nextCols[idx] = {
                                kind: 'custom',
                                enabled: nextCols[idx].enabled,
                                header: nextCols[idx].header,
                                defaultValue: ''
                              };
                            } else {
                              const field = value as InventoryExportFieldKey;
                              nextCols[idx] = {
                                kind: 'field',
                                enabled: nextCols[idx].enabled,
                                header: defaultHeaderForField(field),
                                field
                              };
                            }
                            return { ...prev, template: { ...prev.template, columns: nextCols } };
                          });
                        }}
                      >
                        <SelectTrigger className="w-full min-w-20">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={CUSTOM_FIELD_VALUE}>Custom</SelectItem>
                          {FIELD_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                        ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="p-2">
                      {col.kind === 'custom' ? (
                        <input
                          type="text"
                          className="w-full min-w-45 px-2 py-1 border border-border rounded-md bg-background"
                          value={col.defaultValue ?? ''}
                          onChange={(e) => {
                            const defaultValue = e.target.value;
                            setDraft((prev) => {
                              const nextCols = [...prev.template.columns];
                              const current = nextCols[idx];
                              if (current.kind !== 'custom') return prev;
                              nextCols[idx] = { ...current, defaultValue };
                              return { ...prev, template: { ...prev.template, columns: nextCols } };
                            });
                          }}
                          placeholder="(blank)"
                        />
                      ) : col.kind === 'field' && col.field === 'lastUpdated' && col.enabled ? (
                        <input
                          type="text"
                          className="w-full min-w-45 px-2 py-1 border border-border rounded-md bg-background"
                          value={draft.template.lastUpdatedFormat ?? ''}
                          onChange={(e) => {
                            const lastUpdatedFormat = e.target.value;
                            setDraft((prev) => ({
                              ...prev,
                              template: {
                                ...prev.template,
                                lastUpdatedFormat
                              }
                            }));
                          }}
                          placeholder="hh:mm dd.mm.yyyy"
                          spellCheck={false}
                          title="Format for Last Updated (tokens: hh mm ss dd yyyy yy)"
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="p-2">
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => moveColumn(idx, -1)}
                          disabled={idx === 0}
                          title="Move up"
                        >
                          <ArrowUp className="w-4 h-4" />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => moveColumn(idx, 1)}
                          disabled={idx === draft.template.columns.length - 1}
                          title="Move down"
                        >
                          <ArrowDown className="w-4 h-4" />
                        </Button>
                      </div>
                    </td>
                    <td className="p-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        className="h-7 px-2"
                        onClick={() => {
                          setDraft((prev) => {
                            const nextCols = prev.template.columns.filter((_, i) => i !== idx);
                            return { ...prev, template: { ...prev.template, columns: nextCols } };
                          });
                        }}
                        title="Remove column"
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setDraft((prev) => ({
                  ...prev,
                  template: {
                    ...prev.template,
                    columns: [
                      ...prev.template.columns,
                      { kind: 'custom', enabled: true, header: 'Custom', defaultValue: '' }
                    ]
                  }
                }));
              }}
            >
              Add Custom Column
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                setDraft((prev) => ({
                  ...prev,
                  template: {
                    ...prev.template,
                    columns: [
                      ...prev.template.columns,
                      { kind: 'field', enabled: false, header: defaultHeaderForField('typeData'), field: 'typeData' }
                    ]
                  }
                }));
              }}
            >
              Add Field Column
            </Button>
          </div>
        </div>

        <div className="space-y-3 w-full">
          <h5 className="text-base font-semibold">Preview</h5>
          <div className="rounded-md border border-border bg-muted/20 p-3">
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
 
       <div className="space-y-2 pt-2">
        <h4 className="text-base font-semibold text-foreground/80  tracking-wide">Scheduled Export</h4>
        <p className="text-xs text-muted-foreground">
          When enabled, the app exports the custom template on a timer.
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="inventoryExportEnabled"
            checked={draft.scheduled.enabled}
            onChange={(e) =>
              setDraft((prev) => ({
                ...prev,
                scheduled: {
                  ...prev.scheduled,
                  enabled: e.target.checked
                }
              }))
            }
            className="w-4 h-4 rounded border-border text-primary focus:ring-primary/50"
          />
          <label htmlFor="inventoryExportEnabled" className="text-sm font-medium">
            Enable scheduled export
          </label>
        </div>

        <label className="block text-sm font-medium">
          Interval (seconds)
          <input
            type="number"
            min={30}
            className="mt-1 w-full px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-primary/50"
            value={draft.scheduled.intervalSeconds}
            onChange={(e) => {
              const intervalSeconds = Number(e.target.value);
              setDraft((prev) => ({
                ...prev,
                scheduled: {
                  ...prev.scheduled,
                  intervalSeconds
                }
              }));
            }}
            
          />
          <p className="text-xs text-muted-foreground mt-1">Minimum 30 seconds.</p>
        </label>

        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="inventoryExportOnlyOnChange"
            checked={draft.scheduled.onlyOnChange}
            onChange={(e) =>
              setDraft((prev) => ({
                ...prev,
                scheduled: {
                  ...prev.scheduled,
                  onlyOnChange: e.target.checked
                }
              }))
            }
            className="w-4 h-4 mt-0.5 rounded border-border text-primary focus:ring-primary/50"
            
          />
          <div>
            <label htmlFor="inventoryExportOnlyOnChange" className="text-sm font-medium">
              Only export when inventory changes
            </label>
            <p className="text-xs text-muted-foreground mt-1">
              When enabled, the app calculates a hash of the full inventory and only writes a new file if something changed.
            </p>
          </div>
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm font-medium mb-1">
            <span>Export Folder</span>
            <InfoTipIcon text="Where the scheduled export writes the custom CSV file." />
          </label>
          <div className="flex gap-2">
            <input
              className="flex-1 px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-primary/50"
              value={draft.scheduled.folderPath}
              onChange={(e) =>
                setDraft((prev) => ({
                  ...prev,
                  scheduled: {
                    ...prev.scheduled,
                    folderPath: e.target.value
                  }
                }))
              }
              placeholder="C:\\path\\to\\export\\folder"
              
            />
            <FolderBrowseIconButton onClick={browseFolder} tooltip="Pick folder" />
          </div>
          <p className="text-xs text-muted-foreground mt-1">The app creates this folder if it does not exist.</p>
        </div>

        <label className="block text-sm font-medium">
          File Name
            <input
              type="text"
              className="mt-1 w-full px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-primary/50"
              value={fileNameUi}
              onChange={(e) => {
                const nextValue = e.target.value;
                setFileNameUi(nextValue);
                setDraft((prev) => ({
                  ...prev,
                  scheduled: {
                    ...prev.scheduled,
                    fileName: nextValue
                  }
                }));
              }}
              placeholder="inventory.csv"
              autoComplete="off"
              spellCheck={false}
            />
          <p className="text-xs text-muted-foreground mt-1">Must include an extension, for example inventory.csv</p>
        </label>
      </div>

      <Button size="sm" onClick={handleSave} disabled={!canSave}>
        Save Settings
      </Button>
    </div>
  );
}
