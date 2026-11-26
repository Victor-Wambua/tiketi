import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  build: { outDir: '../../dist/web', emptyOutDir: true, target: 'es2022' },
  server: {
    port: 4281,
    proxy: { '/api': 'http://localhost:4280' },
  },
});
