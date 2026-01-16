import { useMemo } from 'react';
import type { NcCatValidationReport } from '../../../shared/src';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '../utils/cn';

type NcCatValidationResultsModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reports: NcCatValidationReport[];
  onClear: () => void;
};

type StatusBadgeProps = {
  status: 'pass' | 'warnings' | 'errors';
  label?: string;
};

function StatusBadge({ status, label }: StatusBadgeProps) {
  const className =
    status === 'errors'
      ? 'border-[var(--status-error-border)] text-[var(--status-error-text)] bg-[var(--status-error-bg)]'
      : status === 'warnings'
        ? 'border-[var(--status-warning-border)] text-[var(--status-warning-text)] bg-[var(--status-warning-bg)]'
        : 'border-[var(--status-success-border)] text-[var(--status-success-text)] bg-[var(--status-success-bg)]';
  return (
    <Badge variant="outline" className={cn('uppercase tracking-wide', className)}>
      {label ?? status}
    </Badge>
  );
}

function formatReportTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function NcCatValidationResultsModal({
  open,
  onOpenChange,
  reports,
  onClear
}: NcCatValidationResultsModalProps) {
  const summary = useMemo(() => {
    const totals = {
      jobs: reports.length,
      files: 0,
      errors: 0,
      warnings: 0,
      pass: 0
    };
    for (const report of reports) {
      totals.files += report.files.length;
      for (const file of report.files) {
        if (file.status === 'errors') totals.errors += 1;
        else if (file.status === 'warnings') totals.warnings += 1;
        else totals.pass += 1;
      }
    }
    return totals;
  }, [reports]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[720px] max-w-[96vw] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>NC-Cat Validation Results</SheetTitle>
          <SheetDescription>
            {summary.jobs > 0
              ? `Jobs: ${summary.jobs} | Files: ${summary.files} | Errors: ${summary.errors} | Warnings: ${summary.warnings}`
              : 'No validation results yet.'}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <StatusBadge status="errors" label={`Errors ${summary.errors}`} />
          <StatusBadge status="warnings" label={`Warnings ${summary.warnings}`} />
          <StatusBadge status="pass" label={`Pass ${summary.pass}`} />
          {reports.length > 0 && (
            <Button variant="outline" size="sm" onClick={onClear}>
              Clear List
            </Button>
          )}
        </div>

        <div className="mt-4 space-y-3">
          {reports.length === 0 && (
            <div className="rounded border border-[var(--border)] bg-[var(--card)] p-3 text-sm text-[var(--muted-foreground)]">
              Waiting for validation results...
            </div>
          )}

          {reports.map((report, index) => (
            <details
              key={`${report.folderName}-${report.processedAt}-${index}`}
              className="rounded border border-[var(--border)] bg-[var(--card)] p-3"
            >
              <summary className="flex cursor-pointer items-center justify-between gap-2 text-sm">
                <div className="flex flex-col">
                  <span className="font-medium text-[var(--foreground)]">{report.folderName}</span>
                  <span className="text-xs text-[var(--muted-foreground)]">
                    {formatReportTimestamp(report.processedAt)}{report.profileName ? ` | ${report.profileName}` : ''}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--muted-foreground)]">{report.files.length} file(s)</span>
                  <StatusBadge status={report.overallStatus} />
                </div>
              </summary>

              <div className="mt-3 space-y-2">
                {report.files.map((file) => (
                  <div key={`${report.folderName}-${file.filename}`} className="rounded border border-[var(--border)] bg-[var(--background)] p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-mono text-[var(--foreground)]">{file.filename}</span>
                      <StatusBadge status={file.status} />
                    </div>
                    {(file.errors.length > 0 || file.warnings.length > 0 || file.syntax.length > 0) && (
                      <div className="mt-2 space-y-2 text-xs text-[var(--foreground)]">
                        {file.errors.length > 0 && (
                          <div>
                            <div className="font-semibold text-[var(--status-error-text)]">Errors</div>
                            <ul className="list-disc pl-5">
                              {file.errors.map((err, idx) => (
                                <li key={`err-${idx}`}>{err}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {file.syntax.length > 0 && (
                          <div>
                            <div className="font-semibold text-[var(--status-error-text)]">Syntax</div>
                            <ul className="list-disc pl-5">
                              {file.syntax.map((err, idx) => (
                                <li key={`syntax-${idx}`}>{err}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {file.warnings.length > 0 && (
                          <div>
                            <div className="font-semibold text-[var(--status-warning-text)]">Warnings</div>
                            <ul className="list-disc pl-5">
                              {file.warnings.map((warn, idx) => (
                                <li key={`warn-${idx}`}>{warn}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
