import { redirect } from 'next/navigation';

export default function HomePage() {
  // This deployment carries one network, served under /stellar so it can sit
  // behind a path rewrite on app.agama.finance like the other platforms.
  redirect('/stellar');
}
