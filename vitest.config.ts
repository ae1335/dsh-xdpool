import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  /*
    Cache on the LOCAL disk, not next to the project. On the Windows side
    this checkout lives on a Samba share (Z:), where a `rm` of the optimizer
    cache gets rerouted to the Recycle Bin by the host's safe-delete shim
    and dies (trash does not work over SMB). The OS temp dir is always a
    local disk and is also faster to read back.
  */
  cacheDir: join(tmpdir(), 'dsh-xdpool-vite'),
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/lib/**'],
    environment: 'node',
    /*
      Pre-bundle the heavy externals with esbuild. `@earendil-works/pi-ai`
      alone is ~198 files / 6.5MB; on this checkout node_modules sits on a
      Samba share (Z:), so loading it raw costs ~5s of SMB round-trips, and
      ~21s under the IO contention of 164 isolated workers booting at once.
      One cached bundle file replaces the whole graph. No test mocks these
      packages, so bundling cannot change test semantics.

      `@deepseek-ai/dsh-llm` must stay OUT: it reads its own version at
      runtime via `createRequire(import.meta.url)('../package.json')`, which
      breaks once the file is bundled into the .vite cache. It is only
      304K / 2 files, so externalizing it costs nothing.
    */
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: [
            '@earendil-works/pi-ai',
            '@earendil-works/pi-ai/api/openai-completions.lazy',
          ],
        },
      },
    },
  },
})
