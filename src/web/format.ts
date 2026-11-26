const TZ = 'Africa/Nairobi';

export const kes = (n: number) => `KES ${n.toLocaleString('en-KE')}`;

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export const fmtDate = (ms: number) => dateFmt.format(new Date(ms));
export const fmtTime = (ms: number) => timeFmt.format(new Date(ms));
export const fmtWhen = (ms: number) => `${fmtDate(ms)}, ${fmtTime(ms)}`;

export function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
