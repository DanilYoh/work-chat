export function encodeCursor(value: number): string {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined, fallback = 0): number {
  if (!cursor) return fallback;
  const decoded = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  return Number.isSafeInteger(decoded) && decoded >= 0 ? decoded : fallback;
}

