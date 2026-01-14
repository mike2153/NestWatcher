import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import {
  InventoryExportSettingsSchema,
  InventoryExportTemplateSchema,
  type InventoryExportFieldKey,
  type InventoryExportSettings
} from '../../../../shared/src';
import { Button } from '@/components/ui/button';
import { FolderBrowseIconButton, InfoTipIcon } from '@/components/ui/icon-buttons';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

const FIELD_OPTIONS: Array<{ value: InventoryExportFieldKey; label: string }> = [
  { value: 'typeData', label: 'Type' },
  { value: 'customerId', label: 'Customer ID' },
  { value: 'lengthMm', label: 'Length' },
  { value: 'widthMm', label: 'Width' },
  { value: 'thicknessMm', label: 'Thickness' },
  { value: 'preReserved', label: 'Pre-Reserved' },
  { value: 'stock', label: 'Stock' },
  { value: 'reservedStock', label: 'Reserved' },
  { value: 'stockAvailable', label: 'Available' },
  { value: 'lastUpdated', label: 'Last Updated' }
];

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

export function InventoryExportSettings() {
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  const [draft, setDraft] = useState<InventoryExportSettings>(getDefaultInventoryExportSettings());
  const [fileNameUi, setFileNameUi] = useState('');
  const [previewCsv, setPreviewCsv] = useState<string>('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await window.api.settings.get();
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
  }, []);

  const validation = useMemo(() => InventoryExportSettingsSchema.safeParse(draft), [draft]);
  const templateValidation = useMemo(() => InventoryExportTemplateSchema.safeParse(draft.template), [draft.template]);

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
          limit: 10
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
        <h4 className="text-sm font-semibold text-foreground/80 uppercase tracking-wide">Custom CSV Template</h4>
        <p className="text-xs text-muted-foreground">
          This template controls the columns used by scheduled exports and by the "Export Custom CSV" button.
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
          <select
            className="w-20 h-8 px-2 border border-border text-center rounded-md bg-background focus:outline-none focus:ring-3 focus:ring-primary/50 text-sm"
            value={draft.template.delimiter}
            onChange={(e) => {
              const delimiter = e.target.value;
              setDraft((prev) => ({
                ...prev,
                template: {
                  ...prev.template,
                  delimiter
                }
              }));
            }}
          >
            <option value=",">,</option>
            <option value=";">;</option>
            <option value="|">|</option>
            <option value="/">/</option>
            <option value="\">\</option>
          </select>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Used by "Export Custom CSV" and scheduled export.</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        <div className="space-y-3 flex-1 min-w-0">
          {/*<h5 className="text-sm font-semibold">Columns</h5>*/}
          <div className="overflow-x-auto border border-border rounded-md">
            <table className="min-w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left">
                  <th className="p-2 w-16">On</th>
                  <th className="p-2">Column Name</th>
                  <th className="p-2 w-56">Maps To</th>
                  <th className="p-2 w-28">Order</th>
                </tr>
              </thead>
              <tbody>
                {draft.template.columns.map((col, idx) => (
                  <tr key={`${col.field}-${idx}`} className="border-t border-border">
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
                        className="w-1/2 min-w-50 px-2 py-1 border border-border rounded-md bg-background"
                        value={col.header}
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
                      <select
                        className="w-full min-w-50 px-2 py-1 border border-border rounded-md bg-background"
                        value={col.field}
                        onChange={(e) => {
                          const field = e.target.value as InventoryExportFieldKey;
                          setDraft((prev) => {
                            const nextCols = [...prev.template.columns];
                            nextCols[idx] = { ...nextCols[idx], field };
                            return { ...prev, template: { ...prev.template, columns: nextCols } };
                          });
                        }}
                      >
                        {FIELD_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-2">
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => moveColumn(idx, -1)}
                          disabled={idx === 0}
                          title="Move up"
                        >
                          <ArrowUp className="w-4 h-4" />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => moveColumn(idx, 1)}
                          disabled={idx === draft.template.columns.length - 1}
                          title="Move down"
                        >
                          <ArrowDown className="w-4 h-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-3 w-full lg:w-[420px] shrink-0">
          <h5 className="text-sm font-semibold">Preview</h5>
          <div className="rounded-md border border-border bg-muted/20 p-3">


            {previewLoading ? (
              <div className="text-sm text-muted-foreground">Generating preview...</div>
            ) : previewError ? (
              <div className="text-sm text-destructive">{previewError}</div>
            ) : (
              <pre className="whitespace-pre-wrap break-words text-xs font-mono text-foreground/90 max-h-48 overflow-auto">
                {previewCsv || 'No data to preview yet.'}
              </pre>
            )}
          </div>
        </div>
      </div>
 
       <div className="space-y-2 pt-2">
        <h4 className="text-sm font-semibold text-foreground/80 uppercase tracking-wide">Scheduled Export</h4>
        <p className="text-xs text-muted-foreground">
          When enabled, the app exports the custom template on a timer for other software to ingest.
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
            className="mt-1 w-full px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
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
              className="flex-1 px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
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
              className="mt-1 w-full px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
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
