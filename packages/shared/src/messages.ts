export type MessageTone = 'success' | 'info' | 'warning' | 'error';

export type MessageParams = Record<string, unknown>;

export type MessageDefinition = {
  key: string;
  title: string;
  body: string;
  tone: MessageTone;
};

const definitions: Record<string, MessageDefinition> = {
  'job.detected': {
    key: 'job.detected',
    title: 'Pending',
    body: '{{ncFile}} from {{folder}} is now pending and ready for allocation.',
    tone: 'info'
  },
  'job.updated': {
    key: 'job.updated',
    title: 'Job Updated',
    body: 'Refreshed database details for {{ncFile}} in {{folder}} (material/parts updated).',
    tone: 'success'
  },
  'job.removed': {
    key: 'job.removed',
    title: 'Job Unallocated',
    body: 'Removed database entry for {{ncFile}} in {{folder}}; material unallocated in Grundner.',
    tone: 'warning'
  },
  'job.deleted.ui': {
    key: 'job.deleted.ui',
    title: 'Job Deleted',
    body: 'Deleted job {{ncFile}} from {{folder}} via UI; material unallocated in Grundner.',
    tone: 'warning'
  },
  'job.staged': {
    key: 'job.staged',
    title: 'Job Staged',
    body: 'Staged {{ncFile}} from {{folder}} to machine {{machineName}}{{userSuffix}}{{warningSuffix}}.',
    tone: 'success'
  },
  'jobs.staged': {
    key: 'jobs.staged',
    title: 'Jobs Staged',
    body: 'Staged {{count}} job(s) from {{folder}} to machine {{machineName}}: {{sampleNcFiles}}{{userSuffix}}{{warningSuffix}}.',
    tone: 'success'
  },
  'grundner.order.confirmed': {
    key: 'grundner.order.confirmed',
    title: 'Grundner Reserved',
    body: 'Grundner confirmed reservation for {{jobKey}} ({{folder}}) on {{machineName}}.',
    tone: 'success'
  },
  'grundner.order.failed': {
    key: 'grundner.order.failed',
    title: 'Grundner Reservation Failed',
    body: 'Grundner did not confirm reservation for {{jobKey}} ({{folder}}) on {{machineName}}: {{reason}}.',
    tone: 'warning'
  },
  'grundner.order.error': {
    key: 'grundner.order.error',
    title: 'Grundner Reservation Error',
    body: 'Error while reserving Grundner stock for {{jobKey}} ({{folder}}) on {{machineName}}: {{reason}}.',
    tone: 'error'
  },
  'job.ready.missing': {
    key: 'job.ready.missing',
    title: 'Ready-To-Run Removal',
    body: 'Detected {{ncFile}} removed from Ready-to-Run; material unallocated in Grundner.',
    tone: 'warning'
  },
  'job.ready.delete': {
    key: 'job.ready.delete',
    title: 'Ready-To-Run Cleared',
    body: 'Removed staged assets for {{ncFile}} from {{folder}}; material unallocated in Grundner.',
    tone: 'success'
  },
  'lock.success': {
    key: 'lock.success',
    title: 'Jobs Locked',
    body: 'Locked {{count}} job(s) for Grundner order: {{sampleNcFiles}}{{userSuffix}}.',
    tone: 'success'
  },
  'lock.failure': {
    key: 'lock.failure',
    title: 'Lock Failed',
    // Note: our template engine only supports {{key}} replacements (no JS expressions).
    // Any optional suffix like ": <details>" must be assembled by the caller.
    body: 'Failed to lock {{count}} job(s). {{reason}}{{details}}{{userSuffix}}',
    tone: 'error'
  },
  'unlock.success': {
    key: 'unlock.success',
    title: 'Jobs Released',
    body: 'Released {{count}} job(s) from Grundner: {{sampleNcFiles}}{{userSuffix}}.',
    tone: 'success'
  },
  'unlock.failure': {
    key: 'unlock.failure',
    title: 'Release Failed',
    body: 'Unlock request failed for {{count}} job(s); Grundner reply incomplete ({{reason}}){{userSuffix}}.',
    tone: 'error'
  },
  'status.pending_staged': {
    key: 'status.pending_staged',
    title: 'Job Staged',
    body: '{{ncFile}} from {{folder}} staged to {{machineName}}.',
    tone: 'success'
  },
  'status.staged_pending': {
    key: 'status.staged_pending',
    title: 'Job Unstaged',
    body: '{{ncFile}} from {{folder}} reverted to PENDING ({{reason}}).',
    tone: 'warning'
  },
  'status.staged_cut': {
    key: 'status.staged_cut',
    title: 'Job Completed',
    body: '{{ncFile}} from {{folder}} marked CUT after completion on {{machineName}}.',
    tone: 'success'
  },
  'status.load_finish': {
    key: 'status.load_finish',
    title: 'Load Finished',
    body: '{{ncFile}} from {{folder}} finished loading on {{machineName}}.',
    tone: 'info'
  },
  'status.label_finish': {
    key: 'status.label_finish',
    title: 'Label Finished',
    body: '{{ncFile}} from {{folder}} finished labeling on {{machineName}}.',
    tone: 'info'
  },
  'status.cnc_finish': {
    key: 'status.cnc_finish',
    title: 'CNC Finish',
    body: '{{ncFile}} from {{folder}} completed CNC on {{machineName}}.',
    tone: 'success'
  },
  'status.nestpick_complete': {
    key: 'status.nestpick_complete',
    title: 'Nestpick Complete',
    body: 'Nestpick completed for {{ncFile}} on {{machineName}}.',
    tone: 'success'
  },
  'status.error': {
    key: 'status.error',
    title: 'Job Error',
    body: '{{ncFile}} from {{folder}} flagged with error {{errorCode}}; review diagnostics.',
    tone: 'error'
  },
  'nestpick.success': {
    key: 'nestpick.success',
    title: 'Nestpick Exported',
    body: 'Forwarded {{ncFile}} from {{folder}} to Nestpick (machine {{machineName}}).',
    tone: 'success'
  },
  'nestpick.failure': {
    key: 'nestpick.failure',
    title: 'Nestpick Failure',
    body: 'Nestpick export failed for {{ncFile}} from {{folder}}; share or file busy.',
    tone: 'error'
  },
  'grundner.stock.updated': {
    key: 'grundner.stock.updated',
    title: 'Grundner Stock Updated',
    body: 'Grundner updated material {{material}}: reserved {{oldReserved}} → {{newReserved}}.',
    tone: 'info'
  },
  'grundner.conflict': {
    key: 'grundner.conflict',
    title: 'Grundner Allocation Conflict',
    body: 'Grundner mismatch for material {{material}}: Grundner reserved {{reserved}} vs allocated jobs {{jobCount}}.',
    tone: 'warning'
  },
  'cnc.completion': {
    key: 'cnc.completion',
    title: 'CNC Complete',
    body: 'Machine {{machineName}} completed CNC run for {{ncFile}} from {{folder}} (CNC_FINISH).',
    tone: 'success'
  },
  'watcher.offline': {
    key: 'watcher.offline',
    title: 'Watcher Offline',
    body: 'Watcher {{watcherName}} cannot access {{path}}; monitoring paused.',
    tone: 'error'
  },
  'jobsFolder.unreadable': {
    key: 'jobsFolder.unreadable',
    title: 'Jobs Folder Unreadable',
    body: 'Jobs folder {{path}} unreadable; ingest skipped ({{error}}).',
    tone: 'error'
  },
  'db.restored': {
    key: 'db.restored',
    title: 'Database Restored',
    body: 'Database connection restored; allocation updates re-enabled.',
    tone: 'success'
  },
  'db.lost': {
    key: 'db.lost',
    title: 'Database Lost',
    body: 'Database unavailable; allocation updates paused.',
    tone: 'error'
  },
  'grundner.resync': {
    key: 'grundner.resync',
    title: 'Grundner Resync',
    body: 'Grundner resync started by {{user}} (mode {{mode}}).',
    tone: 'success'
  },
  'rerun.queued': {
    key: 'rerun.queued',
    title: 'Rerun Queued',
    body: 'Queued rerun for {{ncFile}} from {{folder}} to machine {{machineName}} (original status {{status}}).',
    tone: 'warning'
  },
  'messages.trimmed': {
    key: 'messages.trimmed',
    title: 'Message Log Trimmed',
    body: 'Message history trimmed to {{limit}} entries.',
    tone: 'info'
  },
  'ncCat.jobMoved': {
    key: 'ncCat.jobMoved',
    title: 'NC-Cat Job Moved',
    body: 'Moved {{folderName}} to processed jobs.',
    tone: 'success'
  },
  'ncCat.jobQuarantined': {
    key: 'ncCat.jobQuarantined',
    title: 'NC-Cat Quarantined',
    body: 'Quarantined {{folderName}} ({{reason}}).',
    tone: 'warning'
  },
  'ncCat.validationSkipped': {
    key: 'ncCat.validationSkipped',
    title: 'NC-Cat Validation Skipped',
    body: 'Validation skipped for {{folderName}}: {{reason}}.',
    tone: 'warning'
  },
  'ncCat.validationUnavailable': {
    key: 'ncCat.validationUnavailable',
    title: 'NC-Cat Validation Unavailable',
    body: 'Validation failed for {{folderName}}: {{error}}.',
    tone: 'error'
  },
  'ncCat.validationBlocked': {
    key: 'ncCat.validationBlocked',
    title: 'NC-Cat Validation Blocked',
    body: 'Validation errors blocked {{folderName}} ({{errorCount}} file(s)).',
    tone: 'error'
  },
  'ncCat.validationWarnings': {
    key: 'ncCat.validationWarnings',
    title: 'NC-Cat Validation Warnings',
    body: 'Validation warnings for {{folderName}} ({{warningCount}} file(s)).',
    tone: 'warning'
  },
  'ncCat.jobsImported': {
    key: 'ncCat.jobsImported',
    title: 'NC-Cat Jobs Imported',
    body: 'Imported {{fileCount}} file(s) from {{folderName}}.',
    tone: 'success'
  },
  'mes.parseError': {
    key: 'mes.parseError',
    title: 'MES JSON Parse Failed',
    body: 'Could not parse validation.json ({{reason}}).',
    tone: 'error'
  },
  'mes.validationFailure': {
    key: 'mes.validationFailure',
    title: 'MES Validation Failed',
    body: '{{failed}} file(s) failed validation in {{folder}}. Review errors before proceeding.',
    tone: 'error'
  },
  'mes.processed': {
    key: 'mes.processed',
    title: 'MES Data Processed',
    body: 'Processed {{processed}} file(s); updated {{updated}} job(s).',
    tone: 'info'
  },
  'mes.jobsNotFound': {
    key: 'mes.jobsNotFound',
    title: 'MES Jobs Missing',
    body: '{{missing}} file(s) from validation.json did not match any jobs.',
    tone: 'warning'
  },
  'autopac.csv.format_error': {
    key: 'autopac.csv.format_error',
    title: 'AutoPAC CSV Format Error',
    body:
      'Rejected AutoPAC file {{fileName}}.\n\nExpected: {{expected}}\n\nFound: {{found}}\n\nCSV Preview:\n{{preview}}',
    tone: 'error'
  }
};

function render(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/{{\s*([\w.]+)\s*}}/g, (_match, key) => {
    const value = params[key];
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    return String(value);
  });
}

export function getMessageDefinition(key: string): MessageDefinition | undefined {
  return definitions[key];
}

export function formatAppMessage(
  key: string,
  params?: MessageParams
): { definition: MessageDefinition; title: string; body: string } {
  const definition = getMessageDefinition(key) ?? {
    key,
    title: key,
    body: '',
    tone: 'info' as MessageTone
  };
  const title = render(definition.title, params);
  const body = render(definition.body, params);
  return { definition, title, body };
}
