"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { Field } from "@/components/ui";
import { getBrowserClient } from "@/lib/supabase/client";
import { addDelivery } from "./actions";
import { PlaceChooser, type Place } from "./PlaceChooser";

const MAX_PDF = 10 * 1024 * 1024;

function Submit({ uploading }: { uploading: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary" disabled={pending || uploading}>
      {uploading ? "Uploading the invoice" : pending ? "Adding" : "Add delivery"}
    </button>
  );
}

/**
 * A delivery in one step: where it goes, the invoice number and the invoice
 * PDF. The PDF goes straight from the browser to Supabase Storage (it can be
 * larger than a server action accepts); the action then saves its path.
 */
export function DeliveryForm({ tenantId, places, customers }: { tenantId: string; places: Place[]; customers: string[] }) {
  const [place, setPlace] = useState(places[0]?.id ?? "new");
  const [placeName, setPlaceName] = useState(places[0]?.name ?? "");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(fd: FormData) {
    setError(null);
    const file = fd.get("pdf");
    fd.delete("pdf");
    if (file instanceof File && file.size > 0) {
      if (file.type !== "application/pdf") return setError("The invoice must be a PDF.");
      if (file.size > MAX_PDF) return setError("The PDF is larger than 10 MB. Save a smaller copy and try again.");
      setUploading(true);
      const path = `${tenantId}/${crypto.randomUUID()}.pdf`;
      const { error: upload } = await getBrowserClient().storage.from("invoices").upload(path, file, { contentType: "application/pdf" });
      setUploading(false);
      if (upload) return setError("Could not upload the PDF. Check your connection and try again.");
      fd.set("invoicePath", path);
    }
    await addDelivery(fd);
  }

  return (
    <form action={submit} className="space-y-4">
      <PlaceChooser places={places} place={place} setPlace={setPlace} placeName={placeName} setPlaceName={setPlaceName} />
      <Field label="Customer" htmlFor="customer" hint="Leave as the shop name if the invoice is to the shop.">
        <input id="customer" name="customer" className="input" list="customer-names" placeholder={placeName || "Customer name"} />
        <datalist id="customer-names">{customers.map((c) => <option key={c} value={c} />)}</datalist>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Invoice number" htmlFor="reference"><input id="reference" name="reference" className="input" required /></Field>
        <Field label="Cartons" htmlFor="cartons"><input id="cartons" name="cartons" type="number" min={0} defaultValue={1} className="input" required /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Invoice total (FJD)" htmlFor="total"><input id="total" name="total" className="input" inputMode="decimal" placeholder="Optional" /></Field>
        <Field label="What to deliver" htmlFor="notes"><input id="notes" name="notes" className="input" placeholder="Optional" /></Field>
      </div>
      <Field label="Invoice PDF" htmlFor="pdf" hint="The driver can open it at the stop. Up to 10 MB.">
        <input id="pdf" name="pdf" type="file" accept="application/pdf,.pdf" className="input py-2" />
      </Field>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      <Submit uploading={uploading} />
    </form>
  );
}
