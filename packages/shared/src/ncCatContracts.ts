// NC-Cat ↔ WE shared contracts used at IPC boundaries.

// Minimal machine config view WE exposes back to NC-Cat when sharing settings.
export interface SharedMachineConfig {
  machineId: number;
  name: string;
  ncCatMachineId?: string | null;
}

export interface SharedSettingsSnapshot {
  processedJobsRoot: string;
  jobsRoot: string;
  quarantineRoot?: string | null;

  machines: SharedMachineConfig[];

  nestWatcherInstalled: boolean;

  ncCatVersion?: string;
  ncCatSettingsVersion?: string;
}

