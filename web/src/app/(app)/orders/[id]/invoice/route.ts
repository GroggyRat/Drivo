import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Opens an order's invoice PDF through a short-lived link. Row and storage
// policies decide who may see it.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: order } = await supabase.from("orders").select("invoice_pdf_path").eq("id", id).maybeSingle();
  if (!order?.invoice_pdf_path) return NextResponse.json({ error: "No invoice PDF" }, { status: 404 });
  const { data, error } = await supabase.storage.from("invoices").createSignedUrl(order.invoice_pdf_path, 300);
  if (error || !data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.redirect(data.signedUrl);
}
