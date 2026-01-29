import type { AppDialogRequest, AppDialogSeverity } from '../../../shared/src';
import { UI_DIALOG_ENQUEUE_CHANNEL } from '../../../shared/src';

function newId(): string {
  try {
    // Modern browsers (and Electron renderer) support crypto.randomUUID.
    return crypto.randomUUID();
  } catch {
    return `dlg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

export function enqueueUiDialog(input: {
  severity: AppDialogSeverity;
  title: string;
  message: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
}): void {
  const payload: AppDialogRequest = {
    id: newId(),
    severity: input.severity,
    title: input.title,
    message: input.message,
    detail: input.detail,
    buttons: input.buttons,
    defaultId: input.defaultId,
    createdAt: new Date().toISOString()
  };

  window.dispatchEvent(new CustomEvent<AppDialogRequest>(UI_DIALOG_ENQUEUE_CHANNEL, { detail: payload }));
}
