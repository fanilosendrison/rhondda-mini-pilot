import { stat } from 'node:fs/promises';

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNodeErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function timeLabel(): string {
  return new Date().toTimeString().slice(0, 8);
}

export function formatInteger(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function formatUsd(value: number): string {
  return `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

export function formatErrorKind(error: unknown): string {
  if (error instanceof Error && 'kind' in error) {
    const kind = (error as { readonly kind?: unknown }).kind;
    if (typeof kind === 'string') return kind;
  }
  return error instanceof Error ? error.name : typeof error;
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function writeOut(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function writeErr(message: string): void {
  process.stderr.write(`${message}\n`);
}
