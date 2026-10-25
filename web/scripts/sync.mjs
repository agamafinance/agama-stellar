// Copy the deployment files into the app.
//
// Next refuses an import that reaches outside the project root, so the
// addresses cannot be read from deployments/ directly. Copying them in is the
// alternative; hand-maintaining a second list is not. This runs before dev
// and before build, so the app is never pointed at a stale pool.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const from = join(here, '..', '..', 'deployments')
const to = join(here, '..', 'generated')

mkdirSync(to, { recursive: true })
for (const f of ['testnet.json', 'markets.json']) {
  copyFileSync(join(from, f), join(to, f))
  console.log(`  ${f}`)
}
