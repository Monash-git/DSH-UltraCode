import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    extensions: ['.ts', '.js', '.mjs', '.json'],
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
