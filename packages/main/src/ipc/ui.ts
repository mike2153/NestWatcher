import { ok, err } from 'neverthrow';
import type { AppError } from '../../../shared/src';
import { ThemePreferenceReq } from '../../../shared/src';
import type { ThemePreferenceRes } from '../../../shared/src';
import { getThemePreference, setThemePreference } from '../services/uiState';
import { createAppError } from './errors';
import { registerResultHandler } from './result';

export function registerUiIpc() {
  registerResultHandler('ui:theme:get', async () => ok<ThemePreferenceRes, AppError>({ preference: getThemePreference() }));

  registerResultHandler('ui:theme:set', async (_event, raw) => {
    try {
      const req = ThemePreferenceReq.parse(raw ?? {});
      setThemePreference(req.preference);
      return ok<ThemePreferenceRes, AppError>({ preference: req.preference });
    } catch (error) {
      return err(createAppError('UI_THEME_SET_FAILED', error instanceof Error ? error.message : String(error)));
    }
  });
}

