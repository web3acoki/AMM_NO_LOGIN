import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  define: {
    __AMM_BUILD_ID__: JSON.stringify(
      process.env.AMM_BUILD_ID || `local-${new Date().toISOString()}`,
    ),
  },
});

