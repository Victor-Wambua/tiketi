import { get } from './api.ts';

export interface Me {
  username: string;
  role: 'organiser' | 'gate';
  displayName: string;
}

let me: Me | null = null;
const listeners = new Set<() => void>();

export const currentUser = () => me;
export const onSession = (fn: () => void) => listeners.add(fn);

export async function refreshSession(): Promise<Me | null> {
  try {
    me = (await get<{ user: Me | null }>('/api/auth/me')).user;
  } catch {
    /* offline: keep what we knew */
  }
  listeners.forEach((fn) => fn());
  return me;
}
