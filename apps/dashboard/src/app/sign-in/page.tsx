import { SignInForm } from '../../components/SignInForm.client.js';

export default function SignInPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-surface-base px-4">
      <h1 className="font-display text-display-m text-text-primary">Sentinel</h1>
      <SignInForm />
    </main>
  );
}
