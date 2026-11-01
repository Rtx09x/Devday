export interface EditorMenuItem {
  label: string;
  icon?: string;
  onClick: () => void;
}

export interface EditorContextItem {
  id: string;
  label: string;
  description: string;
  icon?: string;
  groupLabel?: string;
  data?: unknown;
  includeData?: boolean;
}

export interface EditorHost {
  readonly filePath: string;
  readonly fileName: string;
  readonly theme: string;
  readonly isActive: boolean;
  readonly workspaceId?: string;
  readonly supportsSourceMode?: boolean;
  readonly storage: ExtensionStorage;

  loadContent(): Promise<string>;
  loadBinaryContent(): Promise<ArrayBuffer>;
  saveContent(content: string | ArrayBuffer): Promise<void>;
  setDirty(isDirty: boolean): void;

  onFileChanged(callback: (newContent: string) => void): () => void;
  onSaveRequested(callback: () => void): () => void;
  onThemeChanged(callback: (theme: string) => void): () => void;

  openHistory(): void;
  fs?: EditorHostFileSystem;
  openExternal?(url: string): Promise<void>;
  toggleSourceMode?(): void;
  onSourceModeChanged?(callback: (isSourceMode: boolean) => void): () => void;
  isSourceModeActive?(): boolean;

  getConfig?<T>(key: string, defaultValue?: T): T;
  registerMenuItems(items: EditorMenuItem[]): void;
  /** Show one legacy extension-owned selection in the host indicator and prompt. */
  setEditorContext?(
    context: { label: string; description: string } | null,
  ): void;
  /** Show individually removable extension-owned selections in the host indicator and prompt. */
  setEditorContextItems?(items: EditorContextItem[] | null): void;

  /** Expose an imperative API to editor-scoped AI tools (or null to clear). */
  registerEditorAPI(api: unknown | null): void;
}

export interface ProjectFileSnapshot {
  path: string;
  exists: boolean;
  content: string | null;
  sha256: string | null;
}

export type ProjectFileActor = "user" | "agent";

export interface ProjectFileChange {
  path: string;
  expectedSha256: string | null;
  content: string | null;
}

export interface ProjectFileEdit {
  label: string;
  actor: ProjectFileActor;
  changes: ProjectFileChange[];
}

export interface ProjectFileWriteReceiptFile {
  path: string;
  beforeSha256: string | null;
  afterSha256: string | null;
}

export interface ProjectFileWriteReceipt {
  id: string;
  label: string;
  actor: ProjectFileActor;
  timestamp: number;
  files: ProjectFileWriteReceiptFile[];
  atomic: false;
}

export interface EditorHostFileSystem {
  read(paths: string[]): Promise<ProjectFileSnapshot[]>;
  write(edit: ProjectFileEdit): Promise<ProjectFileWriteReceipt>;
  onChanged(callback: (paths: string[]) => void): () => void;
}

export interface EditorHostProps {
  host: EditorHost;
}

export interface ExtensionStorage {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  getGlobal<T>(key: string): T | undefined;
  setGlobal<T>(key: string, value: T): Promise<void>;
  deleteGlobal(key: string): Promise<void>;
  getSecret(key: string): Promise<string | undefined>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

export interface ExtensionFileSystemService {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  findFiles(pattern: string): Promise<string[]>;
}

export interface ExtensionUIService {
  showInfo(message: string): void;
  showWarning(message: string): void;
  showError(message: string): void;
}

export interface ExtensionConfigurationService {
  get<T>(key: string, defaultValue?: T): T;
  update(
    key: string,
    value: unknown,
    scope?: "user" | "workspace",
  ): Promise<void>;
  getAll(): Record<string, unknown>;
}

export type ExtensionAIProvider = "claude-code" | "claude" | "openai";

export interface ExtensionAIService {
  sendPrompt(options: {
    prompt: string;
    sessionName: string;
    provider?: ExtensionAIProvider;
    model?: string;
  }): Promise<unknown>;
}

export interface ExtensionServices {
  filesystem: ExtensionFileSystemService;
  ui: ExtensionUIService;
  ai?: ExtensionAIService;
  configuration?: ExtensionConfigurationService;
}

export interface ExtensionContext {
  manifest: unknown;
  extensionPath: string;
  services: ExtensionServices;
  subscriptions: unknown[];
}

export interface AIToolContext {
  workspacePath?: string;
  activeFilePath?: string;
  extensionContext: ExtensionContext;
  editorAPI?: unknown;
}

export interface ExtensionToolResult {
  success?: boolean;
  message?: string;
  data?: unknown;
  error?: string;
  errorContext?: Record<string, unknown>;
}

export interface JSONSchemaProperty {
  type: "string" | "number" | "boolean" | "array" | "object" | "null";
  description?: string;
  enum?: Array<string | number>;
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  default?: unknown;
}

export interface JSONSchema {
  type: "object" | "array" | "string" | "number" | "boolean" | "null";
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  items?: JSONSchema;
  description?: string;
}

export type ExtensionAIToolAccess =
  | { kind: "filesystem" }
  | { kind: "editor-read" }
  | { kind: "editor-write" };

export interface ExtensionAITool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  parameters?: JSONSchema;
  scope?: "global" | "editor";
  access?: ExtensionAIToolAccess;
  editorFilePatterns?: string[];
  handler: (
    params: Record<string, unknown>,
    context: AIToolContext,
  ) => Promise<ExtensionToolResult>;
}
