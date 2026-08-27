import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  resolve: {
    alias: {
      '@cloudflare/containers': path.join(here, 'stubs', 'cloudflare-containers.ts'),
    },
  },
  test: {
    include: ['tests/cloudflare-*.test.ts'],
  },
};
