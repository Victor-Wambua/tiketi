import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  build: { outDir: '../../dist/web', emptyOutDir: true, target: 'es2022' },
  server: {
    // `npm run dev` runs the API (default port 8787) and Vite (5173) side by side.
    proxy: { '/api': `http://localhost:${process.env.PORT ?? 8787}` },
  },
});
