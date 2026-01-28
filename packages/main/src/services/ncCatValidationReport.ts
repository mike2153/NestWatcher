import type {
  NcCatHeadlessValidationFileResult,
  NcCatValidationReport
} from '../../../shared/src';

export function buildNcCatValidationReport(params: {
  reason: 'ingest' | 'stage';
  folderName: string;
  profileName?: string | null;
  processedAt?: string;
  results: NcCatHeadlessValidationFileResult[];
}): NcCatValidationReport {
  const files = params.results.map((result) => {
    const warnings = Array.isArray(result.validation.warnings) ? result.validation.warnings : [];
    const errors = Array.isArray(result.validation.errors) ? result.validation.errors : [];

    // Legacy compatibility: older NC-Cat builds may include a separate "syntax" bucket.
    // The UI expects syntax to be merged into errors.
    const legacySyntax = Array.isArray((result.validation as unknown as { syntax?: unknown }).syntax)
      ? ((result.validation as unknown as { syntax: string[] }).syntax)
      : [];

    return {
      filename: result.filename,
      status: result.validation.status,
      warnings,
      errors: errors.concat(legacySyntax)
    };
  });

  const hasErrors = files.some((file) => file.status === 'errors');
  const hasWarnings = files.some((file) => file.status === 'warnings');
  const overallStatus = hasErrors ? 'errors' : hasWarnings ? 'warnings' : 'pass';

  return {
    reason: params.reason,
    folderName: params.folderName,
    profileName: params.profileName ?? null,
    processedAt: params.processedAt ?? new Date().toISOString(),
    overallStatus,
    files
  };
}
