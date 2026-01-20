import { useEffect, useState } from 'react';
import type { Settings } from '../../../../shared/src';
import { Button } from '@/components/ui/button';
import { FolderBrowseIconButton } from '@/components/ui/icon-buttons';

type PathsState = Settings['paths'];
type PathFieldKey = 'processedJobsRoot' | 'autoPacCsvDir' | 'grundnerFolderPath' | 'archiveRoot' | 'jobsRoot' | 'quarantineRoot';
type PathValidationState = { status: 'empty' | 'checking' | 'valid' | 'invalid'; message: string };

const DEFAULT_PATHS: PathsState = {
  processedJobsRoot: '',
  autoPacCsvDir: '',
  grundnerFolderPath: '',
  archiveRoot: '',
  jobsRoot: '',
  quarantineRoot: ''
};

export function FolderPathsSettings() {
  const [paths, setPaths] = useState<PathsState>(DEFAULT_PATHS);
  const [pathStatus, setPathStatus] = useState<Record<PathFieldKey, PathValidationState>>({
    processedJobsRoot: { status: 'empty', message: 'Not set' },
    autoPacCsvDir: { status: 'empty', message: 'Not set' },
    grundnerFolderPath: { status: 'empty', message: 'Not set' },
    archiveRoot: { status: 'empty', message: 'Not set' },
    jobsRoot: { status: 'empty', message: 'Not set' },
    quarantineRoot: { status: 'empty', message: 'Not set' }
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Load current settings
    (async () => {
      const res = await window.api.settings.get();
      if (res.ok && res.value.paths) {
        setPaths({ ...DEFAULT_PATHS, ...res.value.paths });
      }
    })();
  }, []);

  useEffect(() => {
    // Validate paths when they change
    const descriptors: Array<{ key: PathFieldKey; value: string; required: boolean }> = [
      { key: 'processedJobsRoot', value: paths.processedJobsRoot ?? '', required: true },
      { key: 'autoPacCsvDir', value: paths.autoPacCsvDir ?? '', required: false },
      { key: 'grundnerFolderPath', value: paths.grundnerFolderPath ?? '', required: false },
      { key: 'archiveRoot', value: paths.archiveRoot ?? '', required: false },
      { key: 'jobsRoot', value: paths.jobsRoot ?? '', required: false },
      { key: 'quarantineRoot', value: paths.quarantineRoot ?? '', required: false }
    ];

    setPathStatus((prev) => {
      const next = { ...prev };
      descriptors.forEach((descriptor) => {
        const trimmed = descriptor.value.trim();
        if (!trimmed) {
          next[descriptor.key] = {
            status: descriptor.required ? 'invalid' : 'empty',
            message: descriptor.required ? 'Required' : 'Not set'
          };
        } else {
          next[descriptor.key] = { status: 'checking', message: 'Checking...' };
        }
      });
      return next;
    });

    let cancelled = false;

    (async () => {
      for (const descriptor of descriptors) {
        const trimmed = descriptor.value.trim();
        if (!trimmed) continue;

        const res = await window.api.settings.validatePath({ path: trimmed, kind: 'directory' });
        if (cancelled) return;

        if (res.ok) {
          const ok = res.value.exists && res.value.isDirectory;
          setPathStatus((prev) => ({
            ...prev,
            [descriptor.key]: {
              status: ok ? 'valid' : 'invalid',
              message: ok ? 'Directory found' : res.value.exists ? 'Not a directory' : 'Directory not found'
            }
          }));
        } else {
          setPathStatus((prev) => ({
            ...prev,
            [descriptor.key]: { status: 'invalid', message: 'Failed to validate' }
          }));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [paths]);

  const browseFolder = async (field: PathFieldKey) => {
    const res = await window.api.dialog.pickFolder();
    if (res.ok && res.value) {
      setPaths((prev) => ({ ...prev, [field]: res.value }));
    }
  };

  const handleSave = async () => {
    setSaving(true);

    const currentSettings = await window.api.settings.get();
    if (!currentSettings.ok) {
      alert('Failed to load current settings');
      setSaving(false);
      return;
    }

    const updatedSettings = {
      ...currentSettings.value,
      paths
    };

    const saved = await window.api.settings.save(updatedSettings);
    if (saved.ok) {
      alert('Folder paths saved successfully');
    } else {
      alert('Failed to save settings');
    }

    setSaving(false);
  };

  const getStatusColor = (status: PathValidationState['status']) => {
    switch (status) {
      case 'valid': return 'text-success';
      case 'invalid': return 'text-destructive';
      case 'checking': return 'text-warning';
      default: return 'text-muted-foreground';
    }
  };

  const getStatusBorder = (status: PathValidationState['status']) => {
    switch (status) {
      case 'valid': return 'border-success focus:ring-success/40';
      case 'invalid': return 'border-destructive focus:ring-destructive/40';
      case 'checking': return 'border-warning focus:ring-warning/40';
      default: return 'border-border';
    }
  };

  return (
    <div className="space-y-6">
      {/* Path Fields */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">
              Jobs Root
            </label>
            <p className="text-xs text-muted-foreground mb-2">
              CAM Software Output Path
            </p>
            <div className="flex gap-2">
              <input
                className={`flex-1 px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-1 ${getStatusBorder(pathStatus.jobsRoot.status)}`}
                value={paths.jobsRoot}
                onChange={(e) => setPaths({ ...paths, jobsRoot: e.target.value })}
                placeholder="C:\path\to\jobs\input"
              />
              <FolderBrowseIconButton onClick={() => browseFolder('jobsRoot')} tooltip="Pick folder" />
            </div>
            <span className={`text-xs ${getStatusColor(pathStatus.jobsRoot.status)}`}>
              {pathStatus.jobsRoot.message}
            </span>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Validated Jobs Folder <span className="text-destructive"></span>
            </label>
            <p className="text-xs text-muted-foreground mb-2">
              All jobs that pass validation are moved here for production.
            </p>
            <div className="flex gap-2">
              <input
                className={`flex-1 px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-1 ${getStatusBorder(pathStatus.processedJobsRoot.status)}`}
                value={paths.processedJobsRoot}
                onChange={(e) => setPaths({ ...paths, processedJobsRoot: e.target.value })}
                placeholder="C:\path\to\processed\jobs"
              />
              <FolderBrowseIconButton onClick={() => browseFolder('processedJobsRoot')} tooltip="Pick folder" />
            </div>
            <span className={`text-xs ${getStatusColor(pathStatus.processedJobsRoot.status)}`}>
              {pathStatus.processedJobsRoot.message}
            </span>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Quarantine Folder</label>
            <p className="text-xs text-muted-foreground mb-2">
              Folder where jobs with validation errors are moved for review.
            </p>
            <div className="flex gap-2">
              <input
                className={`flex-1 px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-1 ${getStatusBorder(pathStatus.quarantineRoot.status)}`}
                value={paths.quarantineRoot}
                onChange={(e) => setPaths({ ...paths, quarantineRoot: e.target.value })}
                placeholder="C:\path\to\quarantine"
              />
              <FolderBrowseIconButton onClick={() => browseFolder('quarantineRoot')} tooltip="Pick folder" />
            </div>
            <span className={`text-xs ${getStatusColor(pathStatus.quarantineRoot.status)}`}>
              {pathStatus.quarantineRoot.message}
            </span>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Grundner Folder</label>
            <p className="text-xs text-muted-foreground mb-2">
              Grundner Communication Folder
            </p>
            <div className="flex gap-2">
              <input
                className={`flex-1 px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-1 ${getStatusBorder(pathStatus.grundnerFolderPath.status)}`}
                value={paths.grundnerFolderPath}
                onChange={(e) => setPaths({ ...paths, grundnerFolderPath: e.target.value })}
                placeholder="C:\path\to\grundner"
              />
              <FolderBrowseIconButton onClick={() => browseFolder('grundnerFolderPath')} tooltip="Pick folder" />
            </div>
            <span className={`text-xs ${getStatusColor(pathStatus.grundnerFolderPath.status)}`}>
              {pathStatus.grundnerFolderPath.message}
            </span>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">AutoPAC CSV Directory</label>
            <p className="text-xs text-muted-foreground mb-2">
              Shared folder with all AutoPAC instances. Set in AutoPAC Default Parameters.
            </p>
            <div className="flex gap-2">
              <input
                className={`flex-1 px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-1 ${getStatusBorder(pathStatus.autoPacCsvDir.status)}`}
                value={paths.autoPacCsvDir}
                onChange={(e) => setPaths({ ...paths, autoPacCsvDir: e.target.value })}
                placeholder="C:\path\to\autopac\csv"
              />
              <FolderBrowseIconButton onClick={() => browseFolder('autoPacCsvDir')} tooltip="Pick folder" />
            </div>
            <span className={`text-xs ${getStatusColor(pathStatus.autoPacCsvDir.status)}`}>
              {pathStatus.autoPacCsvDir.message}
            </span>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Archive Folder</label>
            <p className="text-xs text-muted-foreground mb-2">
              Optional. Jobs may be moved here after completion to keep the Processed Jobs folder clean.
            </p>
            <div className="flex gap-2">
              <input
                className={`flex-1 px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-1 ${getStatusBorder(pathStatus.archiveRoot.status)}`}
                value={paths.archiveRoot}
                onChange={(e) => setPaths({ ...paths, archiveRoot: e.target.value })}
                placeholder="C:\path\to\archive"
              />
              <FolderBrowseIconButton onClick={() => browseFolder('archiveRoot')} tooltip="Pick folder" />
            </div>
            <span className={`text-xs ${getStatusColor(pathStatus.archiveRoot.status)}`}>
              {pathStatus.archiveRoot.message}
            </span>
          </div>
        </div>
      </div>

      {/* Save Button */}
      <Button
        size="sm"
        onClick={handleSave}
        disabled={saving || pathStatus.processedJobsRoot.status === 'invalid' || pathStatus.processedJobsRoot.status === 'checking'}
      >
        Save Changes
      </Button>
    </div>
  );
}