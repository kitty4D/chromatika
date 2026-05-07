import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          // bind the Durable Object the same way wrangler.toml does so tests exercise the real binding.
          // env values mirror [vars] - secrets are injected per-test as needed.
          bindings: {
            SUI_GRAPHQL_URL: 'https://sui-mainnet.mystenlabs.com/graphql',
            IKA_COIN_TYPE:
              '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA',
            DAILY_CAP: '5',
            FUNDER_BEARER_TOKEN: 'test-token',
            // FUNDER_SUI_PRIVKEY intentionally absent - tests that need it set it via SELF.fetch
            // mocks or skip the path. integration tests don't actually hit Sui.
            FUNDER_SUI_PRIVKEY: '',
          },
        },
      },
    },
  },
});
