import type { NcCatValidationReport } from '../../../shared/src';
import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet';
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
  const config = {
    errors: {
      bg: 'bg-gradient-to-r from-red-500/35 to-red-500/20 dark:from-red-400/25 dark:to-red-400/12',
      border: 'border-red-600/50 dark:border-red-400/50',
      text: 'text-red-700 dark:text-red-300',
      dot: 'bg-red-600 dark:bg-red-400'
    },
    warnings: {
      bg: 'bg-gradient-to-r from-amber-500/35 to-amber-500/20 dark:from-amber-400/25 dark:to-amber-400/12',
      border: 'border-amber-600/50 dark:border-amber-400/50',
      text: 'text-amber-700 dark:text-amber-300',
      dot: 'bg-amber-600 dark:bg-amber-400'
    },
    pass: {
      bg: 'bg-gradient-to-r from-emerald-500/35 to-emerald-500/20 dark:from-emerald-400/25 dark:to-emerald-400/12',
      border: 'border-emerald-600/50 dark:border-emerald-400/50',
      text: 'text-emerald-700 dark:text-emerald-300',
      dot: 'bg-emerald-600 dark:bg-emerald-400'
    }
  };
  const c = config[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border',
        'transition-all duration-200 ease-out',
        c.bg,
        c.border,
        c.text
      )}
    >
      <span className={cn('size-1.5 rounded-full', c.dot)} />
      {label ?? status}
    </span>
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
  pass: number;
};

function getFileCounts(file: NcCatValidationReport['files'][number]): CountTotals {
  return {
    errors: file.errors.length + file.syntax.length,
    warnings: file.warnings.length,
    pass: file.status === 'pass' ? 1 : 0
  };
}

function getReportCounts(report: NcCatValidationReport): CountTotals {
  return report.files.reduce<CountTotals>(
    (totals, file) => {
      if (file.status === 'errors') {
        totals.errors += 1;
      } else if (file.status === 'warnings') {
        totals.warnings += 1;
      } else {
        totals.pass += 1;
      }
      return totals;
    },
    { errors: 0, warnings: 0, pass: 0 }
  );
}

type CountBadgeProps = {
  tone: 'errors' | 'warnings' | 'pass';
  count: number;
};

function CountBadge({ tone, count }: CountBadgeProps) {
  if (count <= 0) return null;
  const toneClass =
    tone === 'errors'
      ? 'bg-red-500/25 dark:bg-red-400/20 text-red-700 dark:text-red-300 border border-red-600/40 dark:border-red-400/40'
      : tone === 'warnings'
        ? 'bg-amber-500/25 dark:bg-amber-400/20 text-amber-700 dark:text-amber-300 border border-amber-600/40 dark:border-amber-400/40'
        : 'bg-emerald-500/25 dark:bg-emerald-400/20 text-emerald-700 dark:text-emerald-300 border border-emerald-600/40 dark:border-emerald-400/40';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium tabular-nums',
        'transition-all duration-200 ease-out',
        toneClass
      )}
    >
      {count}
    </span>
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
  const [nowMs, setNowMs] = useState(Date.now());

  // Update nowMs every 30 seconds while modal is open to enable auto-pruning
  useEffect(() => {
    if (!open) return;
    const interval = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, [open]);

  // Reset to Recent view whenever a new report arrives.
  useEffect(() => {
    if (!open) return;
    setShowAll(false);
  }, [open, latestReport?.processedAt, latestReport?.folderName]);

  // Stable key for a report (matches AppLayout logic)
  const reportKeyOf = useCallback(
    (r: NcCatValidationReport) => `${r.reason}|${r.folderName}|${r.processedAt}`,
    []
  );

  // Filter reports to those within the last 10 minutes (based on processedAt)
  const recentReports = useMemo(() => {
    const tenMinutesAgo = nowMs - 10 * 60 * 1000;
    return historyReports.filter((r) => new Date(r.processedAt).getTime() >= tenMinutesAgo);
  }, [historyReports, nowMs]);

  const displayedReports = useMemo(() => {
    if (showAll) return historyReports;
    return recentReports;
  }, [historyReports, recentReports, showAll]);

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

  const canSeeAll = historyReports.length > 1 || recentReports.length > 1;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[920px] max-w-[96vw] overflow-y-auto bg-[var(--background)] border-l border-[var(--border)]"
      >
        {/* Header Section */}
        <SheetHeader className="pb-4 border-b border-[var(--border-subtle)]">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <SheetTitle className="text-xl font-semibold text-[var(--foreground)]">
                Validation Results
              </SheetTitle>
              <SheetDescription className="text-sm text-[var(--foreground-muted)]">
                {summary.jobs > 0
                  ? `${summary.jobs} job${summary.jobs !== 1 ? 's' : ''} · ${summary.files} file${summary.files !== 1 ? 's' : ''}`
                  : 'No validation results yet'}
              </SheetDescription>
            </div>

            <div className="flex items-center gap-2">
              {onRefresh && (
                <Button
                  size="sm"
                  variant="default"
                  onClick={onRefresh}
                  disabled={loading}
                >
                  {loading ? (
                    <span className="flex items-center gap-1.5">
                      <span className="size-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Loading
                    </span>
                  ) : (
                    'Refresh'
                  )}
                </Button>
              )}
              {canSeeAll && (
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => setShowAll((prev) => !prev)}
                >
                  {showAll ? `All (${historyReports.length})` : `Recent (${recentReports.length})`}
                </Button>
              )}
            </div>
          </div>
        </SheetHeader>

        {/* Summary Stats */}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <StatusBadge
            status="errors"
            label={`${summary.errors} Error${summary.errors !== 1 ? 's' : ''}`}
          />
          <StatusBadge
            status="warnings"
            label={`${summary.warnings} Warning${summary.warnings !== 1 ? 's' : ''}`}
          />
          <StatusBadge status="pass" label={`${summary.pass} Passed`} />
          {!showAll && (
            <span className="ml-auto text-xs text-[var(--foreground-muted)] italic">
              Last 10 minutes
            </span>
          )}
          {showAll && (
            <span className="ml-auto text-xs text-[var(--foreground-muted)] italic">
              Last 50 jobs
            </span>
          )}
        </div>

        {/* Content Area */}
        <div className="mt-5 space-y-3">
          {loadError && (
            <div className="flex items-start gap-3 rounded-lg border border-red-600/50 dark:border-red-400/50 bg-red-500/25 dark:bg-red-400/20 p-4">
              <svg
                className="size-5 text-red-600 dark:text-red-300 shrink-0 mt-0.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <div>
                <p className="text-sm font-medium text-red-700 dark:text-red-300">
                  Failed to load history
                </p>
                <p className="text-xs text-red-600/80 dark:text-red-300/80 mt-0.5">{loadError}</p>
              </div>
            </div>
          )}
          {displayedReports.length === 0 && !loadError && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="size-12 rounded-full bg-[var(--secondary)] flex items-center justify-center mb-3">
                <svg
                  className="size-6 text-[var(--foreground-muted)]"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                  />
                </svg>
              </div>
              <p className="text-sm font-medium text-[var(--foreground-muted)]">
                Waiting for results
              </p>
              <p className="text-xs text-[var(--foreground-subtle)] mt-1">
                Validation results will appear here
              </p>
            </div>
          )}

          <Accordion
            type="multiple"
            defaultValue={
              !showAll && displayedReports.length === 1
                ? [reportKeyOf(displayedReports[0]!)]
                : undefined
            }
            className="space-y-2"
          >
            {displayedReports.map((report) => {
              const reportKey = reportKeyOf(report);
              const reportCounts = getReportCounts(report);

              return (
                <AccordionItem
                  key={reportKey}
                  value={
                    !showAll && displayedReports.length === 1
                      ? reportKeyOf(displayedReports[0]!)
                      : reportKey
                  }
                  className={cn(
                    'rounded-lg border overflow-hidden transition-all duration-200',
                    'bg-[var(--card)] border-[var(--border)]',
                    'hover:border-[var(--border-strong)] hover:shadow-sm'
                  )}
                >
                  <AccordionTrigger className="px-4 py-3 hover:no-underline hover:bg-[var(--card-hover)] transition-colors duration-150">
                    <div className="grid flex-1 grid-cols-[1fr_auto] items-center gap-4 text-left">
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-sm font-semibold text-[var(--foreground)] truncate">
                          {report.folderName}
                        </span>
                        <span className="text-xs text-[var(--foreground-muted)] truncate">
                          {formatReportTimestamp(report.processedAt)}
                          {report.profileName && (
                            <span className="before:content-['·'] before:mx-1.5 before:text-[var(--foreground-subtle)]">
                              {report.profileName}
                            </span>
                          )}
                          {report.reason && (
                            <span className="before:content-['·'] before:mx-1.5 before:text-[var(--foreground-subtle)]">
                              {report.reason}
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <CountBadge tone="errors" count={reportCounts.errors} />
                        <CountBadge tone="warnings" count={reportCounts.warnings} />
                        <CountBadge tone="pass" count={reportCounts.pass} />
                        <span className="text-xs text-[var(--foreground-muted)] tabular-nums">
                          {report.files.length} file{report.files.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                    </div>
                  </AccordionTrigger>

                  <AccordionContent className="px-4 pt-0 pb-3">
                    <div className="border-t border-[var(--border-subtle)] pt-3">
                      <Accordion type="multiple" className="space-y-2">
                        {report.files.map((file) => {
                          const fileKey = `${report.folderName}-${file.filename}`;
                          const fileCounts = getFileCounts(file);
                          const errorGroups = groupMessages([...file.errors, ...file.syntax]);
                          const warningGroups = groupMessages(file.warnings);
                          const fileHasIssues = fileCounts.errors > 0 || fileCounts.warnings > 0;
                          const statusColor =
                            fileCounts.errors > 0
                              ? 'red'
                              : fileCounts.warnings > 0
                                ? 'amber'
                                : 'emerald';

                          return (
                            <AccordionItem
                              key={fileKey}
                              value={fileKey}
                              className={cn(
                                'rounded-md border overflow-hidden transition-all duration-200',
                                'bg-[var(--background-subtle)] border-[var(--border-subtle)]',
                                'hover:border-[var(--border)]'
                              )}
                            >
                              <AccordionTrigger className="px-3 py-2.5 hover:no-underline hover:bg-[var(--secondary)] transition-colors duration-150">
                                <div className="grid flex-1 grid-cols-[1fr_auto] items-center gap-3 text-left">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span
                                      className={cn(
                                        'size-2 rounded-full shrink-0',
                                        statusColor === 'red' && 'bg-red-500',
                                        statusColor === 'amber' && 'bg-amber-500',
                                        statusColor === 'emerald' && 'bg-emerald-500'
                                      )}
                                      aria-hidden="true"
                                    />
                                    <span className="text-sm font-medium text-[var(--foreground)] truncate">
                                      {file.filename}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    {fileHasIssues ? (
                                      <>
                                        <CountBadge tone="errors" count={fileCounts.errors} />
                                        <CountBadge tone="warnings" count={fileCounts.warnings} />
                                      </>
                                    ) : (
                                      <span className="text-xs text-emerald-700 dark:text-emerald-300">
                                        OK
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </AccordionTrigger>

                              <AccordionContent className="px-3 pt-0 pb-3">
                                <div className="space-y-3 pt-2 border-t border-[var(--border-subtle)]">
                                  {!fileHasIssues && (
                                    <div className="flex items-center gap-2 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                                      <svg
                                        className="size-4"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                      >
                                        <path
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                          strokeWidth={2}
                                          d="M5 13l4 4L19 7"
                                        />
                                      </svg>
                                      No errors or warnings
                                    </div>
                                  )}

                                  {fileCounts.errors > 0 && (
                                    <div className="rounded-md border border-red-500/30 dark:border-red-400/40 overflow-hidden">
                                      <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-red-500/40 to-red-500/25 dark:from-red-400/25 dark:to-red-400/12 border-b border-red-500/30 dark:border-red-400/40">
                                        <svg
                                          className="size-4 text-red-400 dark:text-red-300"
                                          fill="none"
                                          viewBox="0 0 24 24"
                                          stroke="currentColor"
                                        >
                                          <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth={2}
                                            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                                          />
                                        </svg>
                                        <span className="text-sm font-medium text-red-700 dark:text-red-300">
                                          {fileCounts.errors} Error
                                          {fileCounts.errors !== 1 ? 's' : ''}
                                        </span>
                                      </div>
                                      <div className="divide-y divide-[var(--border-subtle)] bg-[var(--card)]">
                                        {errorGroups.map((group) => (
                                          <div
                                            key={`err-${fileKey}-${group.header}`}
                                            className="px-3 py-2.5"
                                          >
                                            <div className="text-xs font-semibold text-[var(--foreground)] mb-1.5">
                                              {group.header}
                                              {group.lines.length > 1 && (
                                                <span className="ml-1.5 text-[var(--foreground-muted)] font-normal">
                                                  ({group.lines.length})
                                                </span>
                                              )}
                                            </div>
                                            <ul className="space-y-1 text-xs text-[var(--foreground-muted)]">
                                              {group.lines.map((line, idx) => (
                                                <li
                                                  key={`err-${fileKey}-${group.header}-${idx}`}
                                                  className="pl-3 border-l-2 border-red-500/30 dark:border-red-400/40 py-0.5"
                                                >
                                                  {line}
                                                </li>
                                              ))}
                                            </ul>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}

                                  {fileCounts.warnings > 0 && (
                                    <div className="rounded-md border border-amber-500/30 dark:border-amber-400/40 overflow-hidden">
                                      <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-amber-500/40 to-amber-500/25 dark:from-amber-400/25 dark:to-amber-400/12 border-b border-amber-500/30 dark:border-amber-400/40">
                                        <svg
                                          className="size-4 text-amber-700 dark:text-amber-300"
                                          fill="none"
                                          viewBox="0 0 24 24"
                                          stroke="currentColor"
                                        >
                                          <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth={2}
                                            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                                          />
                                        </svg>
                                        <span className="text-sm font-medium text-amber-700 dark:text-amber-300">
                                          {fileCounts.warnings} Warning
                                          {fileCounts.warnings !== 1 ? 's' : ''}
                                        </span>
                                      </div>
                                      <div className="divide-y divide-[var(--border-subtle)] bg-[var(--card)]">
                                        {warningGroups.map((group) => (
                                          <div
                                            key={`warn-${fileKey}-${group.header}`}
                                            className="px-3 py-2.5"
                                          >
                                            <div className="text-xs font-semibold text-[var(--foreground)] mb-1.5">
                                              {group.header}
                                              {group.lines.length > 1 && (
                                                <span className="ml-1.5 text-[var(--foreground-muted)] font-normal">
                                                  ({group.lines.length})
                                                </span>
                                              )}
                                            </div>
                                            <ul className="space-y-1 text-xs text-[var(--foreground-muted)]">
                                              {group.lines.map((line, idx) => (
                                                <li
                                                  key={`warn-${fileKey}-${group.header}-${idx}`}
                                                  className="pl-3 border-l-2 border-amber-500/30 dark:border-amber-400/40 py-0.5"
                                                >
                                                  {line}
                                                </li>
                                              ))}
                                            </ul>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </AccordionContent>
                            </AccordionItem>
                          );
                        })}
                      </Accordion>
                    </div>
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
