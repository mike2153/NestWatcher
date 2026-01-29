export type AppDialogSeverity = 'info' | 'warning' | 'error' | 'question';

export type AppDialogRequest = {
  id: string;
  severity: AppDialogSeverity;
  title: string;
  message: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  createdAt: string;
};

export const UI_DIALOG_ENQUEUE_CHANNEL = 'ui:dialog:enqueue';
