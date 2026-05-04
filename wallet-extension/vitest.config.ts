import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@ika-pre-alpha/dwallet-grpc-web-client': resolve(
        __dirname,
        'node_modules/@ika.xyz/pre-alpha-solana-client/src/generated/grpc-web/ika_dwallet.client.ts',
      ),
      '@': resolve(__dirname, 'src'),
    },
  },
});
