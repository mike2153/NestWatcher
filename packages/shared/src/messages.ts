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
    title: 'Job Added',
    body: 'Detected {{ncFile}} in jobs folder {{folder}}; job added to database.',
    tone: 'success'
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
    body: 'Staged {{ncFile}} from {{folder}} to machine {{machineName}}.',
    tone: 'success'
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
    body: 'Locked {{count}} job(s) for Grundner order: {{sampleNcFiles}}.',
    tone: 'success'
  },
  'lock.failure': {
    key: 'lock.failure',
    title: 'Lock Failed',
    body: 'Failed to lock {{count}} job(s); Grundner confirmation mismatch ({{reason}}).',
    tone: 'error'
  },
  'unlock.success': {
    key: 'unlock.success',
    title: 'Jobs Released',
    body: 'Released {{count}} job(s) from Grundner: {{sampleNcFiles}}.',
    tone: 'success'
  },
  'unlock.failure': {
    key: 'unlock.failure',
    title: 'Release Failed',
    body: 'Unlock request failed for {{count}} job(s); Grundner reply incomplete ({{reason}}).',
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
