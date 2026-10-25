// Copy the deployment files into the app.
//
// Next refuses an import that reaches outside the project root, so the
// addresses cannot be read from deployments/ directly. Copying them in is the
// alternative; hand-maintaining a second list is not. This runs before dev
// and before build.
//
// The copies are COMMITTED, and that is the point rather than an oversight.
// A Vercel build only ever sees the directory it was linked to, so
// ../deployments does not exist there and the build died on it. Versioning
// them also makes a deployment reproducible: the commit says which pool and
// which core that build was pointed at, which matters in a repo that has
// already abandoned two of each.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, '..', '..', 'deployments');
const to = join(here, '..', 'generated');

if (!existsSync(from)) {
  console.log('  deployments/ is not here (a build host only sees web/); using the committed copies');
  process.exit(0);
}

mkdirSync(to, { recursive: true });
for (const f of ['testnet.json', 'markets.json']) {
  copyFileSync(join(from, f), join(to, f));
  console.log(`  ${f}`);
}
