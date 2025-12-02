import { useEffect, useMemo, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import type { ValidationDataRes } from '../../../shared/src';

type ValidationDataModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobKey: string | null;
};

function formatSeconds(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const parts = [] as string[];
  if (hrs) parts.push(`${hrs}h`);
  if (mins) parts.push(`${mins}m`);
  if (secs || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(' ');
}

function formatNumber(value: number | null, fractionDigits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(fractionDigits);
}

export function ValidationDataModal({ open, onOpenChange, jobKey }: ValidationDataModalProps) {
  const [data, setData] = useState<ValidationDataRes | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!open || !jobKey) return undefined;
    setLoading(true);
    setError(null);
    setData(null);
    window.api.validation
      .getData({ key: jobKey })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(res.error.message);
          return;
        }
        setData(res.value);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, jobKey]);

  const validationStatus = useMemo(() => {
    if (!data?.validation) return null;
    return data.validation.status;
  }, [data]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[880px] max-w-[95vw] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>MES Data</SheetTitle>
          <SheetDescription>
            {jobKey ? `Job: ${jobKey}` : 'Select a job to view MES data'}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {loading && <p className="text-sm text-muted-foreground">Loading...</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {!loading && !error && !data && <p className="text-sm text-muted-foreground">No MES data available.</p>}

          {data ? (
            <div className="space-y-6">
              <div className="flex items-center gap-2">
                <Badge variant={validationStatus === 'pass' ? 'default' : validationStatus === 'warnings' ? 'outline' : 'destructive'}>
                  {validationStatus ? `Validation: ${validationStatus}` : 'Validation: n/a'}
                </Badge>
                {data.mesOutputVersion ? (
                  <span className="text-xs text-muted-foreground">MES version {data.mesOutputVersion}</span>
                ) : null}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <SummaryCard label="Estimated Runtime" value={formatSeconds(data.ncEstRuntime)} />
                <SummaryCard label="Yield" value={`${formatNumber(data.yieldPercentage, 2)} %`} />
                <SummaryCard label="Cutting Distance" value={`${formatNumber(data.cuttingDistanceMeters, 2)} m`} />
                <SummaryCard label="Waste Offcut" value={`${formatNumber(data.wasteOffcutM2, 2)} m²`} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <SummaryCard label="Waste Offcut Dust" value={`${formatNumber(data.wasteOffcutDustM3, 5)} m³`} />
                <SummaryCard label="Total Tool Dust" value={`${formatNumber(data.totalToolDustM3, 5)} m³`} />
                <SummaryCard label="Total Drill Dust" value={`${formatNumber(data.totalDrillDustM3, 5)} m³`} />
                <SummaryCard label="Total Sheet Dust" value={`${formatNumber(data.sheetTotalDustM3, 5)} m³`} />
              </div>

              {data.validation ? (
                <div className="space-y-2">
                  <p className="text-sm font-semibold">Validation</p>
                  <ValidationList title="Errors" items={data.validation.errors} tone="error" />
                  <ValidationList title="Warnings" items={data.validation.warnings} tone="warning" />
                  <ValidationList title="Syntax" items={data.validation.syntax} tone="muted" />
                </div>
              ) : null}

              {data.nestPick ? (
                <div className="space-y-2">
                  <p className="text-sm font-semibold">NestPick</p>
                  <div className="rounded border p-3 text-sm space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">All parts pickable:</span>
                      <Badge variant={data.nestPick.canAllBePicked ? 'default' : 'destructive'}>
                        {data.nestPick.canAllBePicked ? 'Yes' : 'No'}
                      </Badge>
                    </div>
                    <div>
                      <span className="font-medium">Failed parts:</span>{' '}
                      {data.nestPick.failedParts.length ? data.nestPick.failedParts.length : '0'}
                    </div>
                    <div>
                      <span className="font-medium">Oversized parts:</span>{' '}
                      {data.nestPick.partsTooLargeForPallet.length ? data.nestPick.partsTooLargeForPallet.length : '0'}
                    </div>
                    <div>
                      <span className="font-medium">Pallet Adjusted Volume:</span>{' '}
                      {formatNumber(data.nestPick.palletAdjustedVolumeM3, 5)} m³
                    </div>
                  </div>
                </div>
              ) : null}

              {data.usableOffcuts?.length ? (
                <div className="space-y-2">
                  <p className="text-sm font-semibold">Usable Offcuts</p>
                  <table className="w-full text-sm border border-border rounded">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-left px-3 py-2">X (mm)</th>
                        <th className="text-left px-3 py-2">Y (mm)</th>
                        <th className="text-left px-3 py-2">Z (mm)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.usableOffcuts.map((offcut, idx) => (
                        <tr key={`${offcut.x}-${offcut.y}-${offcut.z}-${idx}`} className="border-t border-border">
                          <td className="px-3 py-2">{offcut.x}</td>
                          <td className="px-3 py-2">{offcut.y}</td>
                          <td className="px-3 py-2">{offcut.z}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {data.toolUsage?.length ? (
                <div className="space-y-2">
                  <p className="text-sm font-semibold">Tool Usage</p>
                  <table className="w-full text-sm border border-border rounded">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-left px-3 py-2">#</th>
                        <th className="text-left px-3 py-2">Tool</th>
                        <th className="text-left px-3 py-2">Distance (m)</th>
                        <th className="text-left px-3 py-2">Dust (m³)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.toolUsage.map((tool, idx) => (
                        <tr key={`${tool.toolNumber}-${idx}`} className="border-t border-border">
                          <td className="px-3 py-2">{tool.toolNumber}</td>
                          <td className="px-3 py-2">{tool.toolName}</td>
                          <td className="px-3 py-2">{formatNumber(tool.cuttingDistanceMeters, 2)}</td>
                          <td className="px-3 py-2">{formatNumber(tool.toolDustM3, 5)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {data.drillUsage?.length ? (
                <div className="space-y-2">
                  <p className="text-sm font-semibold">Drill Usage</p>
                  <table className="w-full text-sm border border-border rounded">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-left px-3 py-2">#</th>
                        <th className="text-left px-3 py-2">Drill</th>
                        <th className="text-left px-3 py-2">Holes</th>
                        <th className="text-left px-3 py-2">Distance (m)</th>
                        <th className="text-left px-3 py-2">Dust (m³)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.drillUsage.map((drill, idx) => (
                        <tr key={`${drill.drillNumber}-${idx}`} className="border-t border-border">
                          <td className="px-3 py-2">{drill.drillNumber}</td>
                          <td className="px-3 py-2">{drill.drillName}</td>
                          <td className="px-3 py-2">{drill.holeCount}</td>
                          <td className="px-3 py-2">{formatNumber(drill.drillDistanceMeters, 2)}</td>
                          <td className="px-3 py-2">{formatNumber(drill.drillDustM3, 5)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

function ValidationList({
  title,
  items,
  tone
}: {
  title: string;
  items: string[];
  tone: 'error' | 'warning' | 'muted';
}) {
  if (!items?.length) return null;
  const toneClass = tone === 'error' ? 'text-destructive' : tone === 'warning' ? 'text-amber-600' : 'text-muted-foreground';
  return (
    <div>
      <p className={`text-sm font-semibold ${toneClass}`}>{title}</p>
      <ul className="list-disc pl-5 text-sm">
        {items.map((item, idx) => (
          <li key={`${item}-${idx}`} className={toneClass}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
