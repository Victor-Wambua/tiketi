import { randomBytes } from 'node:crypto';

/** Random, URL-safe, unguessable id such as `tkt_9f2c...` (prefix + 96 bits of hex). */
export function newId(prefix: string, bytes = 12): string {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`;
}
