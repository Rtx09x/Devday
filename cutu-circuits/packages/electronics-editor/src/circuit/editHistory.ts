/**
 * Local, source-backed edit transactions for Electronics Studio.
 *
 * The document source remains the durable source of truth. This journal only
 * is retained only as a compatibility fallback for hosts that predate grouped
 * project transactions. It is session-only and has no persistence adapter.
 */

export type EditActor = 'agent' | 'user';

export interface EditDescriptor {
  actor: EditActor;
  operation: string;
  label: string;
  /** Consecutive commits with the same key are coalesced within the time window. */
  coalesceKey?: string;
  timestamp?: number;
}

export interface SourceChangeSummary {
  addedLines: number;
  removedLines: number;
  beforePreview: string;
  afterPreview: string;
}

export interface EditTransaction extends SourceChangeSummary {
  id: string;
  actor: EditActor;
  operation: string;
  label: string;
  timestamp: number;
  before: string;
  after: string;
  coalesceKey?: string;
}

/** Safe transaction metadata for tools and UI; full source stays inside the journal. */
export type EditTransactionSummary = Omit<EditTransaction, 'before' | 'after' | 'coalesceKey'>;

export interface EditHistorySnapshot {
  canUndo: boolean;
  canRedo: boolean;
  /** Always empty; durable transaction history belongs to CutuCircuits. */
  archived: EditTransactionSummary[];
  applied: EditTransactionSummary[];
  redo: EditTransactionSummary[];
}

export interface HistoryMove {
  source: string;
  transaction: EditTransactionSummary;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_COALESCE_MS = 750;
const PREVIEW_CONTEXT_LINES = 2;
const PREVIEW_MAX_CHARS = 800;

export class EditHistory {
  private source: string;
  private readonly limit: number;
  private readonly coalesceMs: number;
  private applied: EditTransaction[] = [];
  private redo: EditTransaction[] = [];
  private nextId = 1;

  constructor(source = '', options?: { limit?: number; coalesceMs?: number }) {
    this.source = source;
    this.limit = Math.max(1, options?.limit ?? DEFAULT_LIMIT);
    this.coalesceMs = Math.max(0, options?.coalesceMs ?? DEFAULT_COALESCE_MS);
  }

  /** Replace the baseline after load or an external file change. */
  reset(source: string): void {
    this.source = source;
    this.applied = [];
    this.redo = [];
  }

  commit(nextSource: string, descriptor: EditDescriptor): EditTransactionSummary | undefined {
    if (nextSource === this.source) return undefined;

    const timestamp = descriptor.timestamp ?? Date.now();
    const previous = this.applied[this.applied.length - 1];
    const shouldCoalesce = Boolean(
      descriptor.coalesceKey
      && previous?.coalesceKey === descriptor.coalesceKey
      && previous.actor === descriptor.actor
      && timestamp - previous.timestamp <= this.coalesceMs,
    );

    if (shouldCoalesce && previous) {
      const summary = summarizeSourceChange(previous.before, nextSource);
      const merged: EditTransaction = {
        ...previous,
        ...summary,
        after: nextSource,
        timestamp,
        label: descriptor.label,
        operation: descriptor.operation,
      };
      this.applied[this.applied.length - 1] = merged;
      this.source = nextSource;
      this.redo = [];
      return toSummary(merged);
    }

    const transaction: EditTransaction = {
      id: `edit-${this.nextId++}`,
      actor: descriptor.actor,
      operation: descriptor.operation,
      label: descriptor.label,
      timestamp,
      before: this.source,
      after: nextSource,
      coalesceKey: descriptor.coalesceKey,
      ...summarizeSourceChange(this.source, nextSource),
    };
    this.applied.push(transaction);
    if (this.applied.length > this.limit) this.applied.shift();
    this.source = nextSource;
    this.redo = [];
    return toSummary(transaction);
  }

  undo(): HistoryMove | undefined {
    const transaction = this.applied.pop();
    if (!transaction) return undefined;
    this.redo.push(transaction);
    this.source = transaction.before;
    return { source: this.source, transaction: toSummary(transaction) };
  }

  redoLast(): HistoryMove | undefined {
    const transaction = this.redo.pop();
    if (!transaction) return undefined;
    this.applied.push(transaction);
    this.source = transaction.after;
    return { source: this.source, transaction: toSummary(transaction) };
  }

  snapshot(): EditHistorySnapshot {
    return {
      canUndo: this.applied.length > 0,
      canRedo: this.redo.length > 0,
      archived: [],
      applied: this.applied.map(toSummary),
      redo: this.redo.map(toSummary),
    };
  }
}

function toSummary(transaction: EditTransaction): EditTransactionSummary {
  const { before: _before, after: _after, coalesceKey: _coalesceKey, ...summary } = transaction;
  return summary;
}

export function summarizeSourceChange(before: string, after: string): SourceChangeSummary {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  let prefix = 0;
  while (
    prefix < beforeLines.length
    && prefix < afterLines.length
    && beforeLines[prefix] === afterLines[prefix]
  ) prefix++;

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix++;

  const beforeEnd = beforeLines.length - suffix;
  const afterEnd = afterLines.length - suffix;
  const contextStart = Math.max(0, prefix - PREVIEW_CONTEXT_LINES);
  const beforeContextEnd = Math.min(beforeLines.length, beforeEnd + PREVIEW_CONTEXT_LINES);
  const afterContextEnd = Math.min(afterLines.length, afterEnd + PREVIEW_CONTEXT_LINES);

  return {
    removedLines: Math.max(0, beforeEnd - prefix),
    addedLines: Math.max(0, afterEnd - prefix),
    beforePreview: truncatePreview(beforeLines.slice(contextStart, beforeContextEnd).join('\n')),
    afterPreview: truncatePreview(afterLines.slice(contextStart, afterContextEnd).join('\n')),
  };
}

function truncatePreview(value: string): string {
  if (value.length <= PREVIEW_MAX_CHARS) return value;
  return `${value.slice(0, PREVIEW_MAX_CHARS - 1)}…`;
}
