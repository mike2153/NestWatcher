import type { NcCatValidationReport } from '../../../shared/src';
import { useEffect, useMemo, useState } from 'react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '../utils/cn';
import { formatAuDateTime } from '@/utils/datetime';

type NcCatValidationResultsModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  latestReport: NcCatValidationReport | null;
  historyReports: NcCatValidationReport[];
  loading?: boolean;
  loadError?: string | null;
  onRefresh?: () => void;
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
  return formatAuDateTime(date);
}

type GroupedMessage = {
  header: string;
  lines: string[];
};

function toTitleCase(str: string): string {
  return str
    .split(/\s+/)
    .map((word) => {
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

function getMessageHeader(message: string): string {
  const trimmed = String(message ?? '').trim();
  if (!trimmed) return 'Unknown';

  let coreIssue = trimmed;
  if (/tool\s*path\s*out\s*of\s*bounds/i.test(coreIssue)) {
    return 'Tool Path Out Of Bounds';
  }
  coreIssue = coreIssue.replace(/^[A-Z]\d+\s+/, '');

  const colonIndex = coreIssue.indexOf(':');
  if (colonIndex > 0 && colonIndex <= 80) {
    coreIssue = coreIssue.slice(0, colonIndex).trim();
  } else {
    const dashIndex = coreIssue.indexOf(' - ');
    if (dashIndex > 0 && dashIndex <= 80) {
      coreIssue = coreIssue.slice(0, dashIndex).trim();
    }
  }

  // Convert to Title Case
  return toTitleCase(coreIssue);
}

function groupMessages(lines: string[]): GroupedMessage[] {
  const map = new Map<string, string[]>();
  const order: string[] = [];

  for (const line of lines) {
    const header = getMessageHeader(line);
    if (!map.has(header)) {
      map.set(header, []);
      order.push(header);
    }
    map.get(header)?.push(line);
  }

  return order.map((header) => ({ header, lines: map.get(header) ?? [] }));
}

type CountTotals = {
  errors: number;
  warnings: number;
};

function getFileCounts(file: NcCatValidationReport['files'][number]): CountTotals {
  return {
    errors: file.errors.length + file.syntax.length,
    warnings: file.warnings.length
  };
}

function getReportCounts(report: NcCatValidationReport): CountTotals {
  return report.files.reduce<CountTotals>(
    (totals, file) => {
      const counts = getFileCounts(file);
      totals.errors += counts.errors;
      totals.warnings += counts.warnings;
      return totals;
    },
    { errors: 0, warnings: 0 }
  );
}

type CountBadgeProps = {
  tone: 'errors' | 'warnings';
  count: number;
};

function CountBadge({ tone, count }: CountBadgeProps) {
  if (count <= 0) return null;
  const className =
    tone === 'errors'
      ? 'border-[var(--status-error-border)] bg-[var(--status-error-bg)] text-[var(--status-error-text)]'
      : 'border-[var(--status-warning-border)] bg-[var(--status-warning-bg)] text-[var(--status-warning-text)]';
  return (
    <Badge
      variant="outline"
      className={cn('text-xs font-semibold', className)}
    >
      {tone === 'errors' ? 'Errors' : 'Warnings'} {count}
    </Badge>
  );
}

export function NcCatValidationResultsModal({
  open,
  onOpenChange,
  latestReport,
  historyReports,
  loading = false,
  loadError = null,
  onRefresh
}: NcCatValidationResultsModalProps) {
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Reset to Latest view whenever a new report arrives.
    setShowAll(false);
  }, [open, latestReport?.processedAt, latestReport?.folderName]);

  const displayedReports = useMemo(() => {
    if (showAll) return historyReports;
    return latestReport ? [latestReport] : [];
  }, [historyReports, latestReport, showAll]);

  const summary = useMemo(() => {
    const totals = {
      jobs: displayedReports.length,
      files: 0,
      errors: 0,
      warnings: 0,
      pass: 0
    };
    for (const report of displayedReports) {
      totals.files += report.files.length;
      for (const file of report.files) {
        if (file.status === 'errors') totals.errors += 1;
        else if (file.status === 'warnings') totals.warnings += 1;
        else totals.pass += 1;
      }
    }
    return totals;
  }, [displayedReports]);

  const canSeeAll = historyReports.length > 1;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[920px] max-w-[96vw] overflow-y-auto text-sidebar-foreground dark:text-[var(--foreground-subtle)]"
        style={{ backgroundColor: 'var(--sidebar)' }}
      >
        <SheetHeader>
          <div className="flex items-start justify-between gap-2">
            <div>
              <SheetTitle className="dark:text-[var(--foreground-subtle)]">Validation Results</SheetTitle>
              <SheetDescription className="text-lg dark:text-[var(--foreground-subtle)]">
                {summary.jobs > 0
                  ? `Jobs: ${summary.jobs} | Files: ${summary.files} | Errors: ${summary.errors} | Warnings: ${summary.warnings}`
                  : 'No validation results yet.'}
              </SheetDescription>
            </div>

            <div className="flex items-center gap-2">
              {onRefresh && (
                <Button size="sm" onClick={onRefresh} className="shrink-0" disabled={loading}>
                  {loading ? 'Loading...' : 'Refresh'}
                </Button>
              )}
              {canSeeAll && (
                <Button
                  size="sm"
                  onClick={() => setShowAll((prev) => !prev)}
                  className="shrink-0"
                >
                  {showAll ? 'Latest Only' : `See All (${historyReports.length})`}
                </Button>
              )}
            </div>
          </div>
        </SheetHeader>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <StatusBadge status="errors" label={`Errors ${summary.errors}`} />
          <StatusBadge status="warnings" label={`Warnings ${summary.warnings}`} />
          <StatusBadge status="pass" label={`Pass ${summary.pass}`} />
          {showAll && (
            <div className="text-xs text-[var(--muted-foreground)] dark:text-[var(--foreground-subtle)]">
              Showing up to the last 50 jobs.
            </div>
          )}
        </div>

        <div className="mt-4 space-y-3">
          {loadError && (
            <div className="rounded border border-[var(--status-error-border)] bg-[var(--status-error-bg)] p-3 text-sm text-[var(--status-error-text)]">
              Failed to load validation history: {loadError}
            </div>
          )}
          {displayedReports.length === 0 && (
            <div className="rounded border border-[var(--border)] bg-[var(--card)] p-3 text-sm text-[var(--muted-foreground)] dark:text-[var(--foreground-subtle)]">
              Waiting for validation results...
            </div>
          )}

          <Accordion
            type="multiple"
            defaultValue={!showAll && displayedReports.length === 1 ? ['latest-report'] : undefined}
            className="space-y-3"
          >
            {displayedReports.map((report, index) => {
              const reportKey = `report-${index}-${report.folderName}-${report.processedAt}`;
              const reportCounts = getReportCounts(report);

              return (
                <AccordionItem
                  key={reportKey}
                  value={!showAll && displayedReports.length === 1 ? 'latest-report' : reportKey}
                  className="rounded overflow-hidden"
                  style={{ backgroundColor: 'var(--sidebar)' }}
                >
                  <AccordionTrigger className="px-3 py-2 hover:no-underline">
                    <div className="grid flex-1 grid-cols-[1fr_auto] items-center gap-3 text-left">
                      <div className="flex flex-col">
                        <span className="text-sm font-semibold dark:text-[var(--foreground-subtle)]">
                          {report.folderName}
                        </span>
                        <span className="text-xs text-[var(--muted-foreground)] dark:text-[var(--foreground-subtle)]">
                          {formatReportTimestamp(report.processedAt)}
                          {report.profileName ? ` | ${report.profileName}` : ''}
                          {report.reason ? ` | ${report.reason}` : ''}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <CountBadge tone="errors" count={reportCounts.errors} />
                        <CountBadge tone="warnings" count={reportCounts.warnings} />
                        <span className="text-xs text-[var(--muted-foreground)] dark:text-[var(--foreground-subtle)]">
                          {report.files.length} file(s)
                        </span>
                      </div>
                    </div>
                  </AccordionTrigger>

                  <AccordionContent className="px-3 pt-0">
                    <Accordion type="multiple" className="space-y-2 pb-3">
                      {report.files.map((file) => {
                        const fileKey = `${report.folderName}-${file.filename}`;
                        const fileCounts = getFileCounts(file);
                        const errorGroups = groupMessages([...file.errors, ...file.syntax]);
                        const warningGroups = groupMessages(file.warnings);

                        return (
                          <AccordionItem
                            key={fileKey}
                            value={fileKey}
                            className="rounded overflow-hidden"
                            style={{ backgroundColor: 'var(--sidebar)' }}
                          >
                            <AccordionTrigger className="px-3 py-2 hover:no-underline">
                              <div className="grid flex-1 grid-cols-[1fr_auto] items-center gap-3 text-left">
                                <div className="flex items-center gap-2">
                                  <span
                                    className="inline-block size-2 rounded-full bg-emerald-500"
                                    aria-hidden="true"
                                  />
                                  <span className="text-sm font-medium dark:text-[var(--foreground-subtle)]">
                                    {file.filename}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <CountBadge tone="errors" count={fileCounts.errors} />
                                  <CountBadge tone="warnings" count={fileCounts.warnings} />
                                </div>
                              </div>
                            </AccordionTrigger>

                            <AccordionContent className="px-3 pt-2">
                              <div className="space-y-2 pb-2">
                                {fileCounts.errors === 0 && fileCounts.warnings === 0 && (
                                  <div
                                    className="rounded border border-[var(--border)] px-3 py-2 text-xs text-[var(--muted-foreground)] dark:text-[var(--foreground-subtle)]"
                                    style={{ backgroundColor: 'var(--sidebar)' }}
                                  >
                                    No errors or warnings for this file.
                                  </div>
                                )}

                                {fileCounts.errors > 0 && (
                                  <Accordion
                                    type="multiple"
                                    className="space-y-2"
                                  >
                                    <AccordionItem
                                      value="file-errors"
                                      className="rounded border overflow-hidden border-[var(--border)]"
                                    >
                                      <AccordionTrigger
                                        className="px-3 py-2 hover:no-underline text-[var(--status-error-text)] dark:text-[var(--foreground-muted)]"
                                        style={{
                                          backgroundColor: 'var(--status-error-bg)'
                                        }}
                                      >
                                        <div className="grid flex-1 grid-cols-[1fr_auto] items-center gap-3 text-left">
                                          <span className="text-sm font-semibold">
                                            Errors {fileCounts.errors > 1 ? `(${fileCounts.errors})` : ''}
                                          </span>
                                        </div>
                                      </AccordionTrigger>
                                      <AccordionContent className="px-0 pt-0" contentClassName="pb-0">
                                        <div className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
                                          {errorGroups.map((group) => (
                                            <div
                                              key={`err-${fileKey}-${group.header}`}
                                              className="px-3 py-2"
                                              style={{ backgroundColor: 'var(--sidebar)' }}
                                            >
                                              <div className="text-xs font-semibold text-[var(--foreground)] dark:text-[var(--foreground-subtle)]">
                                                {group.header}
                                                {group.lines.length > 1 ? ` (${group.lines.length})` : ''}
                                              </div>
                                              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--foreground)] dark:text-[var(--foreground-subtle)]">
                                                {group.lines.map((line, idx) => (
                                                  <li key={`err-${fileKey}-${group.header}-${idx}`}>{line}</li>
                                                ))}
                                              </ul>
                                            </div>
                                          ))}
                                        </div>
                                      </AccordionContent>
                                    </AccordionItem>
                                  </Accordion>
                                )}

                                {fileCounts.warnings > 0 && (
                                  <Accordion type="multiple" className="space-y-2">
                                    <AccordionItem
                                      value="file-warnings"
                                      className="rounded border overflow-hidden border-[var(--border)]"
                                    >
                                      <AccordionTrigger
                                        className="px-3 py-2 hover:no-underline text-[var(--status-warning-text)] dark:text-[var(--foreground-muted)]"
                                        style={{
                                          backgroundColor: 'var(--status-warning-bg)'
                                        }}
                                      >
                                        <div className="grid flex-1 grid-cols-[1fr_auto] items-center gap-3 text-left">
                                          <span className="text-sm font-semibold">
                                            Warnings {fileCounts.warnings > 1 ? `(${fileCounts.warnings})` : ''}
                                          </span>
                                        </div>
                                      </AccordionTrigger>
                                      <AccordionContent className="px-0 pt-0" contentClassName="pb-0">
                                        <div className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
                                          {warningGroups.map((group) => (
                                            <div
                                              key={`warn-${fileKey}-${group.header}`}
                                              className="px-3 py-2"
                                              style={{ backgroundColor: 'var(--sidebar)' }}
                                            >
                                              <div className="text-xs font-semibold text-[var(--foreground)] dark:text-[var(--foreground-subtle)]">
                                                {group.header}
                                                {group.lines.length > 1 ? ` (${group.lines.length})` : ''}
                                              </div>
                                              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--foreground)] dark:text-[var(--foreground-subtle)]">
                                                {group.lines.map((line, idx) => (
                                                  <li key={`warn-${fileKey}-${group.header}-${idx}`}>{line}</li>
                                                ))}
                                              </ul>
                                            </div>
                                          ))}
                                        </div>
                                      </AccordionContent>
                                    </AccordionItem>
                                  </Accordion>
                                )}
                              </div>
                            </AccordionContent>
                          </AccordionItem>
                        );
                      })}
                    </Accordion>
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        </div>
      </SheetContent>
    </Sheet>
  );
}
