import type { CompileMessage } from './types';

export interface SourceLocation {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface MarkerSeverityValues {
  Error: number;
  Warning: number;
}

export interface CompileMarkerData {
  severity: number;
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** V8 adds two synthesized header lines around a `new Function` body. */
export const NEW_FUNCTION_STACK_LINE_OFFSET = 2;

export function sourceLineCount(source: string): number {
  return source.split('\n').length;
}

/** Returns the first V8 frame that points into a `new Function` body. */
export function extractAnonymousStackLocation(stack: string | undefined): SourceLocation | null {
  if (!stack) return null;
  const match = /<anonymous>:(\d+):(\d+)/.exec(stack);
  if (!match) return null;

  const line = Number(match[1]);
  const column = Number(match[2]);
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) return null;
  return { line, column };
}

/** Maps a V8 `new Function` frame back to Sucrase's line-for-line input. */
export function mapNewFunctionStackToSource(
  stack: string | undefined,
  lineCount: number
): SourceLocation | null {
  if (!Number.isSafeInteger(lineCount) || lineCount < 1) return null;
  const generated = extractAnonymousStackLocation(stack);
  if (!generated) return null;

  const sourceLine = generated.line - NEW_FUNCTION_STACK_LINE_OFFSET;
  if (sourceLine < 1) return null;
  return {
    line: Math.min(sourceLine, lineCount),
    column: generated.column,
  };
}

/** Sucrase locations use 1-based lines and 0-based columns. */
export function sourceLocationFromSucraseError(error: unknown, lineCount: number): SourceLocation | null {
  if (!error || typeof error !== 'object' || !('loc' in error)) return null;
  const loc = (error as { loc?: unknown }).loc;
  if (!loc || typeof loc !== 'object') return null;

  const line = (loc as { line?: unknown }).line;
  const column = (loc as { column?: unknown }).column;
  if (
    typeof line !== 'number' ||
    !Number.isSafeInteger(line) ||
    line < 1 ||
    typeof column !== 'number' ||
    !Number.isSafeInteger(column) ||
    column < 0 ||
    lineCount < 1
  ) {
    return null;
  }
  return { line: Math.min(line, lineCount), column: column + 1 };
}

export function sourceLocationFromRuntimeError(error: unknown, lineCount: number): SourceLocation | null {
  const stack = error && typeof error === 'object' && 'stack' in error
    ? (error as { stack?: unknown }).stack
    : undefined;
  return mapNewFunctionStackToSource(typeof stack === 'string' ? stack : undefined, lineCount);
}

/** Converts located error/warning diagnostics into Monaco-compatible markers. */
export function compileMessagesToMarkers(
  messages: CompileMessage[],
  severity: MarkerSeverityValues
): CompileMarkerData[] {
  return messages.flatMap((message) => {
    if (message.line === undefined || (message.level !== 'error' && message.level !== 'warn')) return [];

    const startLineNumber = Math.max(1, Math.trunc(message.line));
    const startColumn = Math.max(1, Math.trunc(message.column ?? 1));
    const endLineNumber = Math.max(startLineNumber, Math.trunc(message.endLine ?? startLineNumber));
    const requestedEndColumn = Math.max(1, Math.trunc(message.endColumn ?? startColumn + 1));
    const endColumn = endLineNumber === startLineNumber
      ? Math.max(startColumn + 1, requestedEndColumn)
      : requestedEndColumn;

    return [{
      severity: message.level === 'error' ? severity.Error : severity.Warning,
      message: message.text,
      startLineNumber,
      startColumn,
      endLineNumber,
      endColumn,
    }];
  });
}
