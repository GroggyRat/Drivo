"use client";

import { useEffect, useRef, useState } from "react";
import type { LngLat } from "@/lib/geo";
import { getBrowserClient } from "@/lib/supabase/client";

type Stop = {
  id: string;
  sequence: number;
  location: { name: string };
  order: { reference: string; customer_name: string; cartons: number; invoice_pdf_path: string | null } | null;
};
type Outcome = "delivered" | "partially_delivered" | "failed";

/** A photo from the camera, made smaller so it uploads quickly on a weak signal. */
async function shrink(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("No image"))), "image/jpeg", 0.8));
  } catch {
    return file;
  }
}

/** Proof of delivery: outcome, who received it, a photo and a signature. */
export function ProofForm({ stop, tenantId, fix, onOpenInvoice, onDone }: {
  stop: Stop;
  tenantId: string;
  fix: { position: LngLat; accuracy: number } | null;
  onOpenInvoice: (path: string) => void;
  onDone: () => Promise<void>;
}) {
  const supabase = getBrowserClient();
  const [outcome, setOutcome] = useState<Outcome>("delivered");
  const [receivedBy, setReceivedBy] = useState("");
  const [notes, setNotes] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [signed, setSigned] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio;
    c.height = c.clientHeight * ratio;
    const ctx = c.getContext("2d")!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0B1220";
  }, [outcome]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const ctx = e.currentTarget.getContext("2d")!;
    const [x, y] = point(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = e.currentTarget.getContext("2d")!;
    const [x, y] = point(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    setSigned(true);
  };
  const clear = () => {
    const c = canvas.current;
    c?.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    setSigned(false);
  };

  const needsNotes = outcome !== "delivered";
  const needsReceiver = outcome !== "failed";
  const ready = (!needsNotes || notes.trim()) && (!needsReceiver || receivedBy.trim());

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const id = crypto.randomUUID();
      let photoPath: string | null = null;
      let signaturePath: string | null = null;
      if (photo) {
        photoPath = `${tenantId}/${stop.id}/photo-${id}.jpg`;
        const { error: e } = await supabase.storage.from("delivery-proofs").upload(photoPath, await shrink(photo), { contentType: "image/jpeg" });
        if (e) throw new Error("Could not upload the photo. Check your signal and try again.");
      }
      if (signed && canvas.current && outcome !== "failed") {
        const blob = await new Promise<Blob | null>((r) => canvas.current!.toBlob(r, "image/png"));
        if (blob) {
          signaturePath = `${tenantId}/${stop.id}/signature-${id}.png`;
          const { error: e } = await supabase.storage.from("delivery-proofs").upload(signaturePath, blob, { contentType: "image/png" });
          if (e) throw new Error("Could not upload the signature. Check your signal and try again.");
        }
      }
      const { error: e } = await supabase.rpc("complete_stop", {
        p_stop_id: stop.id,
        p_proof: {
          id,
          outcome,
          received_by: needsReceiver ? receivedBy.trim() : null,
          partial_notes: needsNotes ? notes.trim() : null,
          photo_path: photoPath,
          signature_path: signaturePath,
          lon: fix?.position[0] ?? null,
          lat: fix?.position[1] ?? null,
          accuracy_m: fix ? Math.round(fix.accuracy) : null,
          captured_at: new Date().toISOString(),
        },
      });
      if (e) throw new Error(e.message);
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card space-y-4 p-3">
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Proof of delivery</div>
        <div className="mt-1 text-lg font-semibold">You are at {stop.location.name}</div>
        {stop.order && <div className="text-sm text-muted">{stop.order.reference}, {stop.order.customer_name}, {stop.order.cartons} cartons</div>}
        {stop.order?.invoice_pdf_path && <button className="btn-secondary mt-3 w-full" onClick={() => onOpenInvoice(stop.order!.invoice_pdf_path!)}>Open invoice</button>}
      </div>

      <fieldset>
        <legend className="field-label mb-2">What happened</legend>
        <div className="grid gap-2">
          {([["delivered", "Delivered in full"], ["partially_delivered", "Part delivered"], ["failed", "Report a problem: not delivered"]] as const).map(([value, text]) => (
            <label key={value} className={`flex min-h-11 items-center gap-3 rounded-lg border px-3 ${outcome === value ? "border-blue bg-[#EFF4FF]" : "border-line bg-white"}`}>
              <input type="radio" name="outcome" value={value} checked={outcome === value} onChange={() => setOutcome(value)} className="h-5 w-5" />
              {text}
            </label>
          ))}
        </div>
      </fieldset>

      {needsNotes && (
        <label className="block">
          <span className="field-label">{outcome === "failed" ? "What happened" : "What was short or returned"}</span>
          <textarea className="input mt-1 min-h-20 py-2" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      )}
      {needsReceiver && (
        <label className="block">
          <span className="field-label">Received by</span>
          <input className="input mt-1" value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} autoComplete="off" />
        </label>
      )}

      <div>
        <span className="field-label">Photo</span>
        <label className="btn-secondary mt-1 w-full cursor-pointer">
          {photo ? "Take again" : "Take photo"}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setPhoto(f);
              setPreview(f ? URL.createObjectURL(f) : null);
            }}
          />
        </label>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {preview && <img src={preview} alt="Photo of the delivery" className="mt-2 max-h-48 w-full rounded-lg border border-line object-cover" />}
      </div>

      {outcome !== "failed" && (
        <div>
          <div className="flex items-center justify-between">
            <span className="field-label">Signature</span>
            {signed && <button type="button" className="text-sm text-blue underline" onClick={clear}>Clear signature</button>}
          </div>
          <canvas
            ref={canvas}
            aria-label="Signature pad. Ask the customer to sign with a finger."
            className="mt-1 h-40 w-full touch-none rounded-lg border border-line bg-white"
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={() => (drawing.current = false)}
            onPointerCancel={() => (drawing.current = false)}
          />
        </div>
      )}

      {error && <p role="alert" className="text-sm text-[#B42318]">{error}</p>}
      <button className="btn-primary w-full" disabled={!ready || saving} onClick={() => void submit()}>
        {saving ? "Saving" : "Complete delivery"}
      </button>
      {!ready && <p className="text-sm text-muted">{needsNotes && !notes.trim() ? "Say what happened." : "Enter who received the goods."}</p>}
    </section>
  );
}
