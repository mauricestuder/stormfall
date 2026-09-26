import { defineConfig } from 'vite';

// `vite build --mode share` keeps everything in one script so make-share.mjs can inline it into a single HTML file.
// The normal build splits the game (and three.js) from the tiny loader so the loading screen shows instantly.
// THEME=military|park|western|world|default picks (world if unset) the island theme (see src/theme.ts).
export default defineConfig(({ mode }) => ({
  server: { port: 5173 },
  define: { __THEME__: JSON.stringify(process.env.THEME ?? 'world'), __STYLE__: JSON.stringify(process.env.STYLE ?? 'classic') },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: mode === 'share' ? { output: { codeSplitting: false } } : {},
  },
}));
