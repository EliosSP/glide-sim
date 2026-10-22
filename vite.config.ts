import { defineConfig } from 'vite';

// GitHub Pages serves the site from /<repository>/: the workflow sets VITE_BASE. Locally it stays '/'.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
});
