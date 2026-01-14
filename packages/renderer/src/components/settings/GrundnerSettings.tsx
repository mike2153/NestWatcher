import { useEffect, useState } from 'react';
import type { Settings } from '../../../../shared/src';
import { Button } from '@/components/ui/button';
import { FolderBrowseIconButton, InfoTipIcon } from '@/components/ui/icon-buttons';

type TestState = Settings['test'];
type GrundnerState = Settings['grundner'];
type OrderingState = Settings['ordering'];
type PathValidationState = { status: 'empty' | 'checking' | 'valid' | 'invalid'; message: string };

const DEFAULT_TEST: TestState = { testDataFolderPath: '', useTestDataMode: false, sheetIdMode: 'type_data' };
const DEFAULT_GRUNDNER: GrundnerState = { reservedAdjustmentMode: 'delta' };
const DEFAULT_ORDERING: OrderingState = { includeReserved: false };

export function GrundnerSettings() {
  const [testState, setTestState] = useState<TestState>(DEFAULT_TEST);
  const [grundnerState, setGrundnerState] = useState<GrundnerState>(DEFAULT_GRUNDNER);
  const [orderingState, setOrderingState] = useState<OrderingState>(DEFAULT_ORDERING);
  const [pathStatus, setPathStatus] = useState<PathValidationState>({ status: 'empty', message: 'Not set' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Load current settings
    (async () => {
      const res = await window.api.settings.get();
      if (res.ok) {
        if (res.value.test) setTestState({ ...DEFAULT_TEST, ...res.value.test });
        if (res.value.grundner) setGrundnerState({ ...DEFAULT_GRUNDNER, ...res.value.grundner });
        if (res.value.ordering) setOrderingState({ ...DEFAULT_ORDERING, ...res.value.ordering });
      }
    })();
  }, []);

  useEffect(() => {
    // Validate test data folder path
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
      test: testState,
      grundner: grundnerState,
      ordering: orderingState
    };

    const saved = await window.api.settings.save(updatedSettings);
    if (saved.ok) {
      alert('Settings saved successfully');
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
      {/* Test Settings Section */}
      <div className="space-y-4">
        <h4 className="text-sm font-semibold text-foreground/80 uppercase tracking-wide">Test Settings</h4>

        <div>
          <label className="flex items-center gap-2 text-sm font-medium mb-1">
            <span>Test Data Folder</span>
            <InfoTipIcon text="Optional. Used when test data mode is enabled." />
          </label>
          <div className="flex gap-2">
            <input
              className={`flex-1 px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 ${getStatusBorder(pathStatus.status)}`}
              value={testState.testDataFolderPath}
              onChange={(e) => setTestState({ ...testState, testDataFolderPath: e.target.value })}
              placeholder="C:\path\to\test\data"
            />
            <FolderBrowseIconButton onClick={browseFolder} tooltip="Pick folder" />
          </div>
          <span className={`text-xs ${getStatusColor(pathStatus.status)}`}>
            {pathStatus.message}
          </span>
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

        <div>
          <label className="block text-sm font-medium mb-1">Sheet ID Mode</label>
          <select
            className="w-full px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
            value={testState.sheetIdMode}
            onChange={(e) => setTestState({ ...testState, sheetIdMode: e.target.value as TestState['sheetIdMode'] })}
          >
            <option value="type_data">Type Data</option>
            <option value="customer_id">Customer ID</option>
          </select>
        </div>
      </div>

      {/* Grundner Settings Section */}
      <div className="space-y-4">
        <h4 className="text-sm font-semibold text-foreground/80 uppercase tracking-wide">Grundner Settings</h4>

        <div>
          <label className="block text-sm font-medium mb-1">Reserved Adjustment Mode</label>
          <select
            className="w-full px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
            value={grundnerState.reservedAdjustmentMode}
            onChange={(e) => setGrundnerState({ reservedAdjustmentMode: e.target.value as GrundnerState['reservedAdjustmentMode'] })}
          >
            <option value="delta">Delta</option>
            <option value="absolute">Absolute</option>
          </select>
          <p className="text-xs text-muted-foreground mt-1">
            Determines how reserved stock adjustments are calculated
          </p>
        </div>
      </div>

      {/* Ordering Settings Section */}
      <div className="space-y-4">
        <h4 className="text-sm font-semibold text-foreground/80 uppercase tracking-wide">Ordering Settings</h4>

        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="includeReserved"
            checked={orderingState.includeReserved}
            onChange={(e) => setOrderingState({ includeReserved: e.target.checked })}
            className="w-4 h-4 mt-0.5 rounded border-border text-primary focus:ring-primary/50"
          />
          <div>
            <label htmlFor="includeReserved" className="text-sm font-medium">
              Include reserved stock in Ordering table
            </label>
            <p className="text-xs text-muted-foreground mt-1">
              When enabled, reserved and locked amounts are deducted from available stock
            </p>
          </div>
        </div>
      </div>

      {/* Save Button */}
      <Button size="sm" onClick={handleSave} disabled={saving}>
        Save Settings
      </Button>
    </div>
  );
}