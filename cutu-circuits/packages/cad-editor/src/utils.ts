import { dirname, join, normalize, relative } from './pathUtils';

export const PROJECT_CONFIG_PATH = '.cutucircuits/replicad.yml';

export function normalizePath(filePath: string): string {
  return normalize(filePath);
}

export async function resolveWorkspacePath(filePath: string): Promise<string> {
  return '.';
}

export function formatRelativePath(workspacePath: string, filePath: string): string {
  return relative(workspacePath, filePath);
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2);
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return 'Unknown error';
}
