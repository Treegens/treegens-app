// Date formats a sender can choose for "date signed" fields. Shared by the server (PDF stamping) and the browser.
export const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'D MMM YYYY', 'MMM D, YYYY'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

export function formatDate(iso: string | Date, format?: string | null): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  switch (format) {
    case 'DD/MM/YYYY': return `${pad(day)}/${pad(m + 1)}/${y}`;
    case 'MM/DD/YYYY': return `${pad(m + 1)}/${pad(day)}/${y}`;
    case 'D MMM YYYY': return `${day} ${MONTHS[m]} ${y}`;
    case 'MMM D, YYYY': return `${MONTHS[m]} ${day}, ${y}`;
    default: return `${y}-${pad(m + 1)}-${pad(day)}`;
  }
}
