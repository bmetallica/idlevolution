import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  server: {
    // Dev-Modus: API-Aufrufe an die laufende App weiterreichen
    proxy: { '/api': 'http://localhost:8420' },
  },
});
