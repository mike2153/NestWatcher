import { useEffect, useState } from 'react';
import type { Settings } from '../../../../shared/src';
import { Button } from '@/components/ui/button';
import { FolderBrowseIconButton, InfoTipIcon } from '@/components/ui/icon-buttons';

type TestState = Settings['test'];
type PathValidationState = { status: 'empty' | 'checking' | 'valid' | 'invalid'; message: string };

const DEFAULT_TEST: TestState = { testDataFolderPath: '', useTestDataMode: false };

export function TestDataSettings() {
  const [testState, setTestState] = useState<TestState>(DEFAULT_TEST);
  const [pathStatus, setPathStatus] = useState<PathValidationState>({ status: 'empty', message: 'Not set' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await window.api.settings.get();
      if (res.ok && res.value.test) {
        setTestState({ ...DEFAULT_TEST, ...res.value.test });
      }
    })();
  }, []);

  useEffect(() => {
    const trimmed = testState.testDataFolderPath?.trim() ?? '';

    if (!trimmed) {
      setPathStatus({ status: 'empty', message: 'Not set' });
      return;
    }

    setPathStatus({ status: 'checking', message: 'Checking...' });

    let cancelled = false;

    (async () => {
      const res = await window.api.settings.validatePath({ path: trimmed, kind: 'directory' });
      if (cancelled) return;

      if (res.ok) {
        const ok = res.value.exists && res.value.isDirectory;
        setPathStatus({
          status: ok ? 'valid' : 'invalid',
          message: ok ? 'Directory found' : res.value.exists ? 'Not a directory' : 'Directory not found'
        });
      } else {
        setPathStatus({ status: 'invalid', message: 'Failed to validate' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [testState.testDataFolderPath]);

  const browseFolder = async () => {
    const res = await window.api.dialog.pickFolder();
    if (res.ok && res.value) {
      setTestState((prev) => ({ ...prev, testDataFolderPath: res.value }));
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
      test: testState
    };

    const saved = await window.api.settings.save(updatedSettings);
    if (saved.ok) {
      alert('Test data settings saved successfully');
    } else {
      alert('Failed to save settings');
    }

    setSaving(false);
  };

  const getStatusColor = (status: PathValidationState['status']) => {
    switch (status) {
      case 'valid':
        return 'text-success';
      case 'invalid':
        return 'text-destructive';
      case 'checking':
        return 'text-warning';
      default:
        return 'text-muted-foreground';
    }
  };

  const getStatusBorder = (status: PathValidationState['status']) => {
    switch (status) {
      case 'valid':
        return 'border-success focus:ring-[var(--status-success-ring)]';
      case 'invalid':
        return 'border-destructive focus:ring-[var(--destructive-ring)]';
      case 'checking':
        return 'border-warning focus:ring-[var(--tone-warning-ring)]';
      default:
        return 'border-border';
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <h4 className="text-base font-semibold text-foreground/80 tracking-wide">Test Data</h4>

        <div>
          <label className="flex items-center gap-2 text-sm font-medium mb-1">
            <span>Test Data Folder</span>
            <InfoTipIcon text="Optional. Used when test data mode is enabled." />
          </label>
          <div className="flex gap-2">
            <input
              className={`flex-1 px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-1 ${getStatusBorder(pathStatus.status)}`}
              value={testState.testDataFolderPath}
              onChange={(e) => setTestState({ ...testState, testDataFolderPath: e.target.value })}
              placeholder="C:\\path\\to\\test\\data"
            />
            <FolderBrowseIconButton onClick={browseFolder} tooltip="Pick folder" />
          </div>
          <span className={`text-xs ${getStatusColor(pathStatus.status)}`}>{pathStatus.message}</span>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="useTestDataMode"
            checked={testState.useTestDataMode}
            onChange={(e) => setTestState({ ...testState, useTestDataMode: e.target.checked })}
            className="w-4 h-4 rounded border-border text-primary focus:ring-primary/50"
          />
          <label htmlFor="useTestDataMode" className="text-sm font-medium">
            Use test data mode
          </label>
        </div>

      </div>

      <Button size="sm" onClick={handleSave} disabled={saving}>
        Save Settings
      </Button>
    </div>
  );
}
