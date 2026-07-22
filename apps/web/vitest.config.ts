import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Tests des fonctions pures du front (calculs de rendu, formatage). L'alias
 * `@` reprend celui de tsconfig, que Next résout seul mais pas Vitest.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
