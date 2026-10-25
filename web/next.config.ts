import type { NextConfig } from 'next'

const config: NextConfig = {
  // The deployment file is the single source of truth for addresses, read at
  // build time rather than copied into env vars that drift from it.
  env: {},
}

export default config
