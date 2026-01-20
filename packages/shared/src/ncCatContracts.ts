// NC-Cat ↔ WE shared contracts used at IPC boundaries.

// Minimal machine config view WE exposes back to NC-Cat when sharing settings.
export interface SharedMachineConfig {
  machineId: number;
  name: string;
  // FK to nc_cat_profiles table - the profile assigned to this machine
  ncCatProfileId?: string | null;
}

export interface SharedSettingsSnapshot {
  processedJobsRoot: string;
  jobsRoot: string;
  quarantineRoot?: string | null;

  machines: SharedMachineConfig[];

  nestWatcherInstalled: boolean;

  /**
   * Versioned IPC protocol between NC-Cat and NestWatcher.
   * NC-Cat should refuse to sync if this doesn't match its expected version.
   */
  protocolVersion?: number;

  ncCatVersion?: string;
  ncCatSettingsVersion?: string;
}

// ---------------------------------------------------------------------------------
// NC-Cat Machine Profiles (stored in PostgreSQL when running with NestWatcher)
// ---------------------------------------------------------------------------------

/**
 * A machine profile stored in the database.
 * Maps to NC-Cat's MachineProfile type.
 */
export interface NcCatProfile {
  id: string;
  name: string;
  settings: unknown; // NCCatalystSettings JSON blob
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Response from fetching all profiles
 */
export interface NcCatProfilesListRes {
  profiles: NcCatProfile[];
  activeProfileId: string | null;
}

/**
 * Request to save (create or update) a profile
 */
export interface NcCatProfileSaveReq {
  id: string;
  name: string;
  settings: unknown;
  isActive?: boolean;
}

/**
 * Request to set a profile as active
 */
export interface NcCatProfileSetActiveReq {
  id: string;
}

/**
 * Request to delete a profile
 */
export interface NcCatProfileDeleteReq {
  id: string;
}

// ---------------------------------------------------------------------------------
// Profile ↔ Machine Assignment
// ---------------------------------------------------------------------------------

/**
 * Request to assign a profile to a machine
 */
export interface NcCatAssignProfileReq {
  machineId: number;
  profileId: string | null; // null to unassign
}

/**
 * Response after assigning a profile to a machine
 */
export interface NcCatAssignProfileRes {
  machineId: number;
  profileId: string | null;
}

/**
 * Request to get machines assigned to a specific profile
 */
export interface NcCatProfileMachinesReq {
  profileId: string;
}

/**
 * Response with machines assigned to a profile
 */
export interface NcCatProfileMachinesRes {
  profileId: string;
  machines: SharedMachineConfig[];
}

// ---------------------------------------------------------------------------------
// NC-Cat Validation Submission (IPC-based MES data transfer)
// ---------------------------------------------------------------------------------

/**
 * A single file's data being submitted from NC-Cat.
 * Includes the NC file content and associated assets.
 */
export interface NcCatFileSubmission {
  /** NC filename (e.g., "job001.nc") */
  filename: string;
  /** Raw NC file content */
  ncContent: string;
  /** NESTPICK CSV content (if generated) */
  nestpickContent?: string | null;
  /** Label images as base64 data URLs, keyed by part number */
  labelImages?: Record<string, string> | null;
}

/**
 * Request to submit validated job data from NC-Cat to NestWatch.
 * NestWatch will move files and create the job if validation passes.
 */
export interface NcCatSubmitValidationReq {
  /** Original folder path where the job files are located */
  sourceFolderPath: string;
  /** Folder name (used to derive job key) */
  folderName: string;
  /** Target machine ID (optional - for routing to specific machine folder) */
  machineId?: number | null;
  /** Full MES validation payload (same structure as validation.json) */
  validationPayload: {
    exportMetadata?: {
      exportDate?: string | null;
      exportedBy?: string | null;
      mesOutputVersion?: string | null;
      folderName?: string | null;
      Status?: string | null;
      originalFolderPath?: string | null;
      newFolderPath?: string | null;
    };
    files: Array<{
      filename: string;
      folderName: string;
      folderPath: string;
      // Estimated runtime in seconds (may be float).
      ncEstRuntime: number;
      yieldPercentage: number;
      usableOffcuts: Array<{ x: number; y: number; z: number }>;
      wasteOffcutM2: number;
      wasteOffcutDustM3: number;
      TotalToolDustM3: number;
      TotalDrillDustM3: number;
      SheetTotalDustM3: number;
      toolUsage: Array<{
        toolNumber: string;
        toolName: string;
        cuttingDistanceMeters: number;
        toolDustM3: number;
      }>;
      drillUsage: Array<{
        drillNumber: string;
        drillName: string;
        holeCount: number;
        drillDistanceMeters: number;
        drillDustM3: number;
      }>;
      validation: {
        status: 'pass' | 'warnings' | 'errors';
        warnings: string[];
        errors: string[];
        syntax: string[];
      };
      nestPick: {
        canAllBePicked: boolean | null;
        partsTooLargeForPallet: Array<{ partNumber: string; reason: string }>;
        failedParts: Array<{ partNumber: string; reason: string }>;
        palletAdjustedVolumeM3: number | null;
      } | null;
    }>;
  };
  /** Files to be moved/created in processedJobsRoot */
  files: NcCatFileSubmission[];
}

/**
 * Response after attempting to submit validation data
 */
export interface NcCatSubmitValidationRes {
  /** Whether the submission was accepted */
  accepted: boolean;
  /** Job key if created (e.g., "folder/jobname") */
  jobKey?: string | null;
  /** Destination folder path where files were moved */
  destinationPath?: string | null;
  /** Reason for rejection (if not accepted) */
  reason?: string | null;
  /** Validation status that caused rejection */
  validationStatus?: 'pass' | 'warnings' | 'errors' | null;
}

// ---------------------------------------------------------------------------------
// NC-Cat Headless Validation (NestWatcher-triggered, no validation.json)
// ---------------------------------------------------------------------------------

export type NcCatHeadlessValidationReason = 'ingest' | 'stage';

export interface NcCatHeadlessValidationFileInput {
  filename: string;
  ncContent: string;
}

export interface NcCatHeadlessValidationFileResult {
  filename: string;
  validation: {
    status: 'pass' | 'warnings' | 'errors';
    warnings: string[];
    errors: string[];
    syntax: string[];
  };
}

export interface NcCatHeadlessValidateRequest {
  requestId: string;
  reason: NcCatHeadlessValidationReason;
  folderName: string;
  files: NcCatHeadlessValidationFileInput[];
  profileId?: string | null;
  profileName?: string | null;
  profileSettings?: unknown | null;
  machineNameHint?: string | null;
}

export interface NcCatHeadlessValidateResponse {
  requestId: string;
  success: boolean;
  results?: NcCatHeadlessValidationFileResult[];
  error?: string | null;
  profileId?: string | null;
  profileName?: string | null;
}

// ---------------------------------------------------------------------------------
// Headless Validation Report (NestWatcher -> Renderer)
// ---------------------------------------------------------------------------------

export interface NcCatValidationReportFile {
  filename: string;
  status: 'pass' | 'warnings' | 'errors';
  warnings: string[];
  errors: string[];
  syntax: string[];
}

export interface NcCatValidationReport {
  reason: NcCatHeadlessValidationReason;
  folderName: string;
  profileName?: string | null;
  processedAt: string;
  overallStatus: 'pass' | 'warnings' | 'errors';
  files: NcCatValidationReportFile[];
}

// ---------------------------------------------------------------------------------
// Open Job in Simulator (Phase 4)
// ---------------------------------------------------------------------------------

/**
 * A single job descriptor with file content for opening in NC-Cat simulator.
 * Content is passed directly to avoid filesystem access from NC-Cat.
 */
export interface OpenJobDescriptor {
  /** Job key from NestWatcher database (e.g., "folder/jobname") */
  jobKey: string;
  /** Folder name */
  folder: string;
  /** NC filename */
  ncFile: string;
  /** Raw NC file content */
  ncContent: string;
  /** Material type (if known) */
  material?: string | null;
}

/**
 * Request to open one or more jobs in the NC-Cat simulator.
 * Sent from NestWatcher to NC-Cat when user clicks "Open in Simulator".
 */
export interface OpenJobInSimulatorReq {
  /** Jobs to open in the simulator */
  jobs: OpenJobDescriptor[];
  /** If true, replace any currently loaded jobs; if false, add to existing */
  replaceExisting?: boolean;
}

/**
 * Response after NC-Cat receives jobs to open
 */
export interface OpenJobInSimulatorRes {
  /** Whether the jobs were successfully received and queued for loading */
  ok: boolean;
  /** Number of jobs that will be loaded */
  jobCount: number;
  /** Error message if not ok */
  error?: string;
}
