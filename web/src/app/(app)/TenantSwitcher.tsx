import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { TENANT_COOKIE } from "@/lib/tenant";

async function switchTenant(formData: FormData) {
  "use server";
  const id = String(formData.get("tenant") ?? "");
  (await cookies()).set(TENANT_COOKIE, id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  redirect("/");
}

export function TenantSwitcher({ options, current }: { options: { id: string; name: string }[]; current: string }) {
  return (
    <form action={switchTenant} className="flex gap-2">
      <label htmlFor="tenant" className="sr-only">Company</label>
      <select id="tenant" name="tenant" defaultValue={current} className="input min-h-8 bg-white/10 text-sm text-white">
        {options.map((o) => <option key={o.id} value={o.id} className="text-ink">{o.name}</option>)}
      </select>
      <button className="btn btn-sm border border-white/30 text-white" type="submit">Switch</button>
    </form>
  );
}
