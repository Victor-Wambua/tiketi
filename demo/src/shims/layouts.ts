import { LayoutSchema, type Layout } from '../../../src/shared/layout.ts';

const files = import.meta.glob('../../../layouts/*.json', { eager: true, import: 'default' });

/** Same files, same order (sorted by file name) as `src/server/layouts.ts`, bundled instead of read from disk. */
export function loadShippedLayouts(): Layout[] {
  return Object.keys(files)
    .sort()
    .map((k) => LayoutSchema.parse(files[k]));
}
