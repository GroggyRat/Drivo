// Public settings, safe in the browser.
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  mapStyleUrl: process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "",
};
