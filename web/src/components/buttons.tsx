"use client";

import { useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

export function SubmitButton({ children, pendingLabel, className = "btn-primary", name, value }: {
  children: ReactNode;
  pendingLabel?: string;
  className?: string;
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} name={name} value={value}>
      {pending ? pendingLabel ?? "Saving" : children}
    </button>
  );
}

/**
 * A destructive action that asks first. The form only submits after the
 * person confirms in the dialog.
 */
export function ConfirmSubmit({ label, title, message, confirmLabel, className = "btn-danger btn-sm" }: {
  label: string;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { pending } = useFormStatus();
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} disabled={pending}>
        {pending ? "Working" : label}
      </button>
      {open && (
        <div role="dialog" aria-modal="true" aria-labelledby="confirm-title" className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
          <div className="card w-full max-w-md p-5">
            <h2 id="confirm-title" className="text-lg font-semibold">{title}</h2>
            <div className="mt-2 text-muted">{message}</div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setOpen(false)} autoFocus>Keep it</button>
              {/* Submit before closing: once the dialog closes this button is gone, and a button that has left the page submits nothing. */}
              <button type="button" className="btn-danger" onClick={(e) => { e.currentTarget.form?.requestSubmit(); setOpen(false); }}>{confirmLabel}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
