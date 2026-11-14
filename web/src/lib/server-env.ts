import "server-only";

// Server-only settings. Importing this from browser code fails the build.
export const serverEnv = {
  get serviceRoleKey() {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
    return key;
  },
  routingApiUrl: process.env.ROUTING_API_URL ?? "",
  routingApiKey: process.env.ROUTING_API_KEY ?? "",
  billzillaApiUrl: process.env.BILLZILLA_API_URL ?? "",
  billzillaWebhookSecret: process.env.BILLZILLA_WEBHOOK_SECRET ?? "",
  kaiworkforceWebhookSecret: process.env.KAIWORKFORCE_WEBHOOK_SECRET ?? "",
  cronSecret: process.env.CRON_SECRET ?? "",
  // Email (SMTP_USER, SMTP_PASS and friends) is read in src/lib/email.ts, Xero in src/lib/integrations/xero.ts.
};
