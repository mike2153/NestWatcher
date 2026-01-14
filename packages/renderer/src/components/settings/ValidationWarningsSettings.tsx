import { useEffect, useState } from 'react';
import type { Settings } from '../../../../shared/src';
import { Button } from '@/components/ui/button';

type ValidationWarningsState = Settings['validationWarnings'];

const DEFAULT_STATE: ValidationWarningsState = { showValidationWarnings: false };

export function ValidationWarningsSettings() {
  const [state, setState] = useState<ValidationWarningsState>(DEFAULT_STATE);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await window.api.settings.get();
      if (res.ok && res.value.validationWarnings) {
        setState({ ...DEFAULT_STATE, ...res.value.validationWarnings });
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
      validationWarnings: state
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
      <div className="space-y-4">
        <h4 className="text-sm font-semibold text-foreground/80 uppercase tracking-wide">Validation Warnings</h4>

        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="showValidationWarnings"
            checked={state.showValidationWarnings}
            onChange={(e) => setState({ showValidationWarnings: e.target.checked })}
            className="w-4 h-4 mt-0.5 rounded border-border text-primary focus:ring-primary/50"
          />
          <div>
            <label htmlFor="showValidationWarnings" className="text-sm font-medium">
              Show Validation Warnings
            </label>
            <p className="text-xs text-muted-foreground mt-1">
              When enabled, a &quot;Validations&quot; button will appear in the header next to Alarms.
              This displays jobs from NC-Cat that have validation warnings or errors.
            </p>
          </div>
        </div>
      </div>

      <Button size="sm" onClick={handleSave} disabled={saving}>
        Save Settings
      </Button>
    </div>
  );
}
