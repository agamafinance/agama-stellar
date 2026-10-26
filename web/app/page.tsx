'use client';

export { default } from './stellar-rwa/page';

// The app's own front door.
//
// This deployment carries one network, and it is what app.agama.finance
// serves at its root: the rewrite there points the apex straight here, so the
// address a visitor lands on is the address they keep. The same pages stay at
// /stellar-rwa, which is where they were and where the other tabs still live,
// and that path redirects here rather than serving a second copy.
