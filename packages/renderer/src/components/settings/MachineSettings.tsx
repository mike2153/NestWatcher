import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { Machine, SaveMachineReq } from '../../../../shared/src';

type MachinePathKey = 'machineApJobfolder' | 'machineNestpickFolder';
type PathValidationState = { status: 'empty' | 'checking' | 'valid' | 'invalid'; message: string };

interface MachineSettingsProps {
  machineId: number | null;
  onMachineUpdated?: () => void;
}

export function MachineSettings({ machineId, onMachineUpdated }: MachineSettingsProps) {
  const [machine, setMachine] = useState<Machine | null>(null);
  const [pathStatus, setPathStatus] = useState<Record<MachinePathKey, PathValidationState>>({
    machineApJobfolder: { status: 'empty', message: 'Not set' },
    machineNestpickFolder: { status: 'empty', message: 'Not set' }
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!machineId) {
      setMachine(null);
      return;
    }

    (async () => {
      const res = await window.api.machines.list();
      if (res.ok) {
        const found = res.value.items.find((m: Machine) => m.machineId === machineId);
        setMachine(found || null);
      }
    })();
  }, [machineId]);

  useEffect(() => {
    if (!machine) {
      setPathStatus({
        machineApJobfolder: { status: 'empty', message: 'Select a machine to edit' },
        machineNestpickFolder: { status: 'empty', message: 'Select a machine to edit' }
      });
      return;
    }

    const descriptors: Array<{ key: MachinePathKey; value: string; required: boolean; disabled?: boolean }> = [
      { key: 'machineApJobfolder', value: machine.apJobfolder ?? '', required: true },
      {
        key: 'machineNestpickFolder',
        value: machine.nestpickFolder ?? '',
        required: !!machine.nestpickEnabled,
        disabled: !machine.nestpickEnabled
      }
    ];

    setPathStatus((prev) => {
      const next = { ...prev };
      descriptors.forEach((descriptor) => {
        const trimmed = descriptor.value.trim();
        if (descriptor.disabled) {
          next[descriptor.key] = { status: 'empty', message: 'Nestpick disabled' };
        } else if (!trimmed) {
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
        if (descriptor.disabled) continue;
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
  }, [machine]);

  const browseFolder = async (field: 'apJobfolder' | 'nestpickFolder') => {
    const res = await window.api.dialog.pickFolder();
    if (res.ok && res.value && machine) {
      setMachine({ ...machine, [field]: res.value });
    }
  };

  const handleSave = async () => {
    if (!machine) return;

    const hasErrors = Object.values(pathStatus).some((s) => s.status === 'invalid');
    const isChecking = Object.values(pathStatus).some((s) => s.status === 'checking');

    if (hasErrors || isChecking) {
      alert('Please fix validation errors before saving');
      return;
    }

    setSaving(true);

    const payload: SaveMachineReq = {
      machineId: machine.machineId,
      name: machine.name,
      pcIp: machine.pcIp ?? null,
      apJobfolder: machine.apJobfolder,
      nestpickFolder: machine.nestpickFolder,
      nestpickEnabled: machine.nestpickEnabled
    };

    const res = await window.api.machines.save(payload);
    if (res.ok) {
      alert('Machine settings saved successfully');
      onMachineUpdated?.();
    } else {
      alert('Failed to save machine settings');
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

  if (!machine) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        Select a machine to configure
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Machine Name</label>
          <input
            className="w-full px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
            value={machine.name}
            onChange={(e) => setMachine({ ...machine, name: e.target.value })}
            placeholder="Machine name"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">PC IP Address</label>
          <input
            className="w-full px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
            value={machine.pcIp ?? ''} 
            onChange={(e) => setMachine({ ...machine, pcIp: e.target.value || null })}
            placeholder="192.168.1.100"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          Ready-To-Run Folder <span className="text-destructive">*</span>
        </label>
        <div className="flex gap-2">
          <input
            className={`flex-1 px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 ${getStatusBorder(pathStatus.machineApJobfolder.status)}`}
            value={machine.apJobfolder}
            onChange={(e) => setMachine({ ...machine, apJobfolder: e.target.value })}
            placeholder="C:\path\to\ready-to-run"
          />
          <button
            onClick={() => browseFolder('apJobfolder')}
            className="px-3 py-2 bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/80 transition-colors"
            title="Browse for folder"
          >
            <FolderOpen className="w-4 h-4" />
          </button>
        </div>
        <span className={`text-xs ${getStatusColor(pathStatus.machineApJobfolder.status)}`}>
          {pathStatus.machineApJobfolder.message}
        </span>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          Nestpick Folder {machine.nestpickEnabled && <span className="text-destructive">*</span>}
        </label>
        <div className="flex gap-2">
          <input
            className={`flex-1 px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 ${getStatusBorder(pathStatus.machineNestpickFolder.status)}`}
            value={machine.nestpickFolder}
            onChange={(e) => setMachine({ ...machine, nestpickFolder: e.target.value })}
            placeholder="C:\path\to\nestpick"
            disabled={!machine.nestpickEnabled}
          />
          <button
            onClick={() => browseFolder('nestpickFolder')}
            className="px-3 py-2 bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/80 transition-colors disabled:opacity-50"
            title="Browse for folder"
            disabled={!machine.nestpickEnabled}
          >
            <FolderOpen className="w-4 h-4" />
          </button>
        </div>
        <span className={`text-xs ${getStatusColor(pathStatus.machineNestpickFolder.status)}`}>
          {pathStatus.machineNestpickFolder.message}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          id="nestpickEnabled"
          checked={machine.nestpickEnabled}
          onChange={(e) => setMachine({ ...machine, nestpickEnabled: e.target.checked })}
          className="w-4 h-4 rounded border-border text-primary focus:ring-primary/50"
        />
        <label htmlFor="nestpickEnabled" className="text-sm font-medium">
          Enable Nestpick
        </label>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50"
      >
        Save Machine Settings
      </button>
    </div>
  );
}