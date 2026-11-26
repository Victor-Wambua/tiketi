import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LayoutSchema, type Layout } from '../shared/layout.ts';

const DIR = fileURLToPath(new URL('../../layouts/', import.meta.url));

export function loadShippedLayouts(): Layout[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => LayoutSchema.parse(JSON.parse(readFileSync(`${DIR}${f}`, 'utf8'))));
}
