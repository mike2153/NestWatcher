import type { NcCatValidationReport } from '../../../shared/src';
import { useEffect, useMemo, useState } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '../utils/cn';

type NcCatValidationResultsModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  latestReport: NcCatValidationReport | null;
  historyReports: NcCatValidationReport[];
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

type GroupedMessage = {
  header: string;
  lines: string[];
  type: 'error' | 'warning' | 'syntax';
};

type CategoryGroup = {
  category: string;
  errors: GroupedMessage[];
  warnings: GroupedMessage[];
  syntax: GroupedMessage[];
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

function groupMessages(lines: string[], type: 'error' | 'warning' | 'syntax'): GroupedMessage[] {
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

  return order.map((header) => ({ header, lines: map.get(header) ?? [], type }));
}

function groupAllMessagesByCategory(
  errors: string[],
  warnings: string[],
  syntax: string[]
): CategoryGroup[] {
  const categoryMap = new Map<string, CategoryGroup>();

  const groupedErrors = groupMessages(errors, 'error');
  const groupedWarnings = groupMessages(warnings, 'warning');
  const groupedSyntax = groupMessages(syntax, 'syntax');

  // Combine all grouped messages
  const allGrouped = [...groupedErrors, ...groupedWarnings, ...groupedSyntax];

  for (const group of allGrouped) {
    if (!categoryMap.has(group.header)) {
      categoryMap.set(group.header, {
        category: group.header,
        errors: [],
        warnings: [],
        syntax: []
      });
    }
    const cat = categoryMap.get(group.header)!;
    if (group.type === 'error') {
      cat.errors.push(group);
    } else if (group.type === 'warning') {
      cat.warnings.push(group);
    } else {
      cat.syntax.push(group);
    }
  }

  return Array.from(categoryMap.values());
}

export function NcCatValidationResultsModal({
  open,
  onOpenChange,
  latestReport,
  historyReports
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
      <SheetContent side="right" className="w-[920px] max-w-[96vw] overflow-y-auto">
        <SheetHeader>
          <div className="flex items-start justify-between gap-2">
            <div>
              <SheetTitle>Validation Results</SheetTitle>
              <SheetDescription>
                {summary.jobs > 0
                  ? `Jobs: ${summary.jobs} | Files: ${summary.files} | Errors: ${summary.errors} | Warnings: ${summary.warnings}`
                  : 'No validation results yet.'}
              </SheetDescription>
            </div>

            {canSeeAll && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAll((prev) => !prev)}
                className="shrink-0"
              >
                {showAll ? 'Latest Only' : `See All (${historyReports.length})`}
              </Button>
            )}
          </div>
        </SheetHeader>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <StatusBadge status="errors" label={`Errors ${summary.errors}`} />
          <StatusBadge status="warnings" label={`Warnings ${summary.warnings}`} />
          <StatusBadge status="pass" label={`Pass ${summary.pass}`} />
          {showAll && (
            <div className="text-xs text-[var(--muted-foreground)]">Showing up to the last 50 jobs.</div>
          )}
        </div>

        <div className="mt-4 space-y-3">
          {displayedReports.length === 0 && (
            <div className="rounded border border-[var(--border)] bg-[var(--card)] p-3 text-sm text-[var(--muted-foreground)]">
              Waiting for validation results...
            </div>
          )}

          {displayedReports.map((report, index) => (
            <details
              key={`${report.reason}-${report.folderName}-${report.processedAt}-${index}`}
              className="rounded border border-[var(--border)] bg-[var(--card)] p-3"
              open={!showAll}
            >
              <summary className="flex cursor-pointer items-center justify-between gap-2 text-sm">
                <div className="flex flex-col">
                  <span className="font-medium text-[var(--foreground)]">{report.folderName}</span>
                  <span className="text-xs text-[var(--muted-foreground)]">
                    {formatReportTimestamp(report.processedAt)}
                    {report.profileName ? ` | ${report.profileName}` : ''}
                    {report.reason ? ` | ${report.reason}` : ''}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--muted-foreground)]">{report.files.length} file(s)</span>
                  <StatusBadge status={report.overallStatus} />
                </div>
              </summary>

              <div className="mt-3 space-y-2">
                {report.files.map((file) => {
                  const categoryGroups = groupAllMessagesByCategory(
                    file.errors,
                    file.warnings,
                    file.syntax
                  );

                  return (
                    <div
                      key={`${report.folderName}-${file.filename}`}
                      className="rounded border border-[var(--border)] bg-[var(--background)] p-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm text-[var(--foreground)]">{file.filename}</span>
                        <StatusBadge status={file.status} />
                      </div>

                      {(file.errors.length > 0 || file.warnings.length > 0 || file.syntax.length > 0) && (
                        <div className="mt-2 space-y-3">
                          {categoryGroups.map((category) => (
                            <details
                              key={`cat-${category.category}`}
                              className="rounded border border-[var(--border)] bg-[var(--card)] p-2"
                            >
                              <summary className="cursor-pointer font-semibold text-base text-[var(--foreground)]">
                                {category.category}
                                {category.errors.length + category.warnings.length + category.syntax.length > 1
                                  ? ` (${category.errors.length + category.warnings.length + category.syntax.length})`
                                  : ''}
                              </summary>

                              <div className="mt-3 space-y-3">
                                {category.errors.length > 0 && (
                                  <div>
                                    <div className="font-semibold text-base text-[var(--status-error-text)]">
                                      Errors
                                    </div>
                                    <div className="mt-2 space-y-2">
                                      {category.errors.map((group) => (
                                        <details
                                          key={`err-${group.header}`}
                                          className="rounded border border-[var(--border)] bg-[var(--background)] p-2 ml-2"
                                        >
                                          <summary className="cursor-pointer font-medium text-base text-[var(--status-error-text)]">
                                            {group.header}
                                            {group.lines.length > 1 ? ` (${group.lines.length})` : ''}
                                          </summary>
                                          <ul className="mt-2 list-disc space-y-1 pl-5 text-base text-[var(--foreground)]">
                                            {group.lines.map((line, idx) => (
                                              <li key={`err-${group.header}-${idx}`}>{line}</li>
                                            ))}
                                          </ul>
                                        </details>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {category.syntax.length > 0 && (
                                  <div>
                                    <div className="font-semibold text-base text-[var(--status-error-text)]">
                                      Syntax
                                    </div>
                                    <div className="mt-2 space-y-2">
                                      {category.syntax.map((group) => (
                                        <details
                                          key={`syntax-${group.header}`}
                                          className="rounded border border-[var(--border)] bg-[var(--background)] p-2 ml-2"
                                        >
                                          <summary className="cursor-pointer font-medium text-base text-[var(--status-error-text)]">
                                            {group.header}
                                            {group.lines.length > 1 ? ` (${group.lines.length})` : ''}
                                          </summary>
                                          <ul className="mt-2 list-disc space-y-1 pl-5 text-base text-[var(--foreground)]">
                                            {group.lines.map((line, idx) => (
                                              <li key={`syntax-${group.header}-${idx}`}>{line}</li>
                                            ))}
                                          </ul>
                                        </details>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {category.warnings.length > 0 && (
                                  <div>
                                    <div className="font-semibold text-base text-[var(--status-warning-text)]">
                                      Warnings
                                    </div>
                                    <div className="mt-2 space-y-2">
                                      {category.warnings.map((group) => (
                                        <details
                                          key={`warn-${group.header}`}
                                          className="rounded border border-[var(--border)] bg-[var(--background)] p-2 ml-2"
                                        >
                                          <summary className="cursor-pointer font-medium text-base text-[var(--status-warning-text)]">
                                            {group.header}
                                            {group.lines.length > 1 ? ` (${group.lines.length})` : ''}
                                          </summary>
                                          <ul className="mt-2 list-disc space-y-1 pl-5 text-base text-[var(--foreground)]">
                                            {group.lines.map((line, idx) => (
                                              <li key={`warn-${group.header}-${idx}`}>{line}</li>
                                            ))}
                                          </ul>
                                        </details>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </details>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </details>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
