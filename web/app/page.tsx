import { redirect } from 'next/navigation';

export default function HomePage() {
  // This deployment carries one network, served under /stellar-rwa so the
  // rewrite on app.agama.finance is a straight pass through: the path the
  // pages live at is the path the public sees, and nothing has to rewrite
  // links on the way out.
  redirect('/stellar-rwa');
}
