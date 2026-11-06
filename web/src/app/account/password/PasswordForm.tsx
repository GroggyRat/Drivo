"use client";

import Link from "next/link";
import { useActionState } from "react";
import { setPassword } from "./actions";

export function PasswordForm() {
  const [state, action, pending] = useActionState(setPassword, undefined);
  if (state?.done) {
    return (
      <div className="space-y-3">
        <p role="status">Password saved. Use it next time you sign in, on the web and in the Drivo app.</p>
        <Link href="/" className="btn-primary w-full">Continue</Link>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-4">
      <div>
        <label htmlFor="password" className="field-label">New password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required className="input" />
        <p className="mt-1 text-xs text-muted">At least 10 characters.</p>
      </div>
      <div>
        <label htmlFor="confirm" className="field-label">Type it again</label>
        <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={10} required className="input" />
      </div>
      {state?.error && <p role="alert" className="text-sm text-bad">{state.error}</p>}
      <button type="submit" className="btn-primary w-full" disabled={pending}>{pending ? "Saving" : "Save password"}</button>
    </form>
  );
}
