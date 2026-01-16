import { useEffect, useState } from 'react';
import type { Settings } from '../../../../shared/src';
import { Button } from '@/components/ui/button';

type TestState = Settings['test'];
type OrderingState = Settings['ordering'];

const DEFAULT_TEST: TestState = { testDataFolderPath: '', useTestDataMode: false, sheetIdMode: 'type_data' };
const DEFAULT_ORDERING: OrderingState = { includeReserved: false };

export function GrundnerSettings() {
  const [orderingState, setOrderingState] = useState<OrderingState>(DEFAULT_ORDERING);
  const [sheetIdMode, setSheetIdMode] = useState<TestState['sheetIdMode']>(DEFAULT_TEST.sheetIdMode);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await window.api.settings.get();
      if (res.ok) {
        if (res.value.ordering) setOrderingState({ ...DEFAULT_ORDERING, ...res.value.ordering });
        if (res.value.test?.sheetIdMode) setSheetIdMode(res.value.test.sheetIdMode);
      }
    })();
  }, []);



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
        test: {
          ...(currentSettings.value.test ?? DEFAULT_TEST),
          sheetIdMode
        },
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

  return (
    <div className="space-y-6">
      {/* Grundner Settings Section */}
      <div className="space-y-4">
        <h4 className="text-sm font-semibold text-foreground/80 uppercase tracking-wide">Grundner Settings</h4>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          <div>
            <label className="block text-sm font-medium mb-1">Sheet ID Mode</label>
            <p className="text-xs text-muted-foreground mb-2">Controls the key used by all machines to identify sheet inventory.</p>
            <select
              className="w-full px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-primary/50"
              value={sheetIdMode}
              onChange={(e) => setSheetIdMode(e.target.value as TestState['sheetIdMode'])}
            >
              <option value="type_data">Type Data</option>
              <option value="customer_id">Customer ID</option>
            </select>
          </div>


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