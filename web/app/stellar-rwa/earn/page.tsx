import { redirect } from 'next/navigation';

// Earn is the home tab; keep the obvious URL working.
export default function EarnRedirect() {
  redirect('/stellar-rwa');
}
