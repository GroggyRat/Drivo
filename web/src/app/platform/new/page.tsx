import type { Metadata } from "next";
import Link from "next/link";
import { SubmitButton } from "@/components/buttons";
import { Card, Field, Notice, PageHeader } from "@/components/ui";
import { createTenant } from "../actions";

export const metadata: Metadata = { title: "New company" };

export default async function NewTenantPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <>
      <PageHeader title="New company" description="Creates the company with Fiji defaults (50 and 80 km/h, FJD) and its first Owner." actions={<Link href="/platform" className="btn-secondary">Back to companies</Link>} />
      {error && <div className="mb-4"><Notice tone="red">{error}</Notice></div>}
      <Card className="max-w-2xl">
        <form action={createTenant} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Company name" htmlFor="name"><input id="name" name="name" className="input" required /></Field>
            <Field label="Web name" htmlFor="slug" hint="Made from the name if left empty"><input id="slug" name="slug" className="input" placeholder="nadera" /></Field>
            <Field label="Time zone" htmlFor="time_zone"><input id="time_zone" name="time_zone" className="input" defaultValue="Pacific/Fiji" required /></Field>
            <Field label="Contact email" htmlFor="contact_email"><input id="contact_email" name="contact_email" type="email" className="input" /></Field>
          </div>
          <fieldset className="space-y-3 border-t border-line pt-4">
            <legend className="text-base font-semibold">First Owner</legend>
            <p className="text-sm text-muted">If this email already has a KaiTech account, they keep their password. Otherwise a temporary password is shown once after saving.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Full name" htmlFor="owner_name"><input id="owner_name" name="owner_name" className="input" required /></Field>
              <Field label="Email" htmlFor="owner_email"><input id="owner_email" name="owner_email" type="email" className="input" required /></Field>
            </div>
          </fieldset>
          <SubmitButton pendingLabel="Creating">Create company</SubmitButton>
        </form>
      </Card>
    </>
  );
}
