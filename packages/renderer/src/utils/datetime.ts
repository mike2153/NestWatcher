function isValidDate(date: Date): boolean {
  return !Number.isNaN(date.getTime());
}

export function formatAuDate(input: Date | string | number | null | undefined): string {
  if (input == null) return '';
  const date = input instanceof Date ? input : new Date(input);
  if (!isValidDate(date)) return '';
  return new Intl.DateTimeFormat('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(date);
}

export function formatAuTime(input: Date | string | number | null | undefined): string {
  if (input == null) return '';
  const date = input instanceof Date ? input : new Date(input);
  if (!isValidDate(date)) return '';
  return new Intl.DateTimeFormat('en-AU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date);
}

export function formatAuDateTime(input: Date | string | number | null | undefined): string {
  if (input == null) return '';
  const date = input instanceof Date ? input : new Date(input);
  if (!isValidDate(date)) return '';
  // Keep this intentionally simple and predictable for AU users: "23 Jan 2026 14:03:22"
  return `${formatAuDate(date)} ${formatAuTime(date)}`;
}

