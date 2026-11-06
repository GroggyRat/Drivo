"use client";

import { useActionState } from "react";
import { sendReset } from "./actions";

export function ResetForm() {
  const [state, action, pending] = useActionState(sendReset, undefined);
  if (state?.sent) {
    return (
      <p role="status" className="text-sm">
        If that email has a Drivo account, a reset link is on its way. Open it on this device. The link works once and expires in an hour.
      </p>
    );
  }
  return (
    <form action={action} className="space-y-4">
      <div>
        <label htmlFor="email" className="field-label">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required className="input" />
      </div>
      {state?.error && <p role="alert" className="text-sm text-bad">{state.error}</p>}
      <button type="submit" className="btn-primary w-full" disabled={pending}>{pending ? "Sending" : "Email me a reset link"}</button>
    </form>
  );
}
