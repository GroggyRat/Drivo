import "server-only";
import { headers } from "next/headers";
import nodemailer from "nodemailer";
import { signInEmail, type SignInEmail } from "./email-core";

// Drivo's own email sender, used to send a person their temporary password
// when their account is made or reset. Settings (server only): SMTP_USER and
// SMTP_PASS, for example a Gmail address and its app password; SMTP_HOST and
// SMTP_PORT default to Gmail's. Without them nothing is sent and the
// temporary password is only shown on screen.

export const emailEnv = {
  get host() { return process.env.SMTP_HOST || "smtp.gmail.com"; },
  get port() { return Number(process.env.SMTP_PORT || 465); },
  get user() { return process.env.SMTP_USER ?? ""; },
  get pass() { return process.env.SMTP_PASS ?? ""; },
  get from() { return process.env.SMTP_FROM || this.user; },
  get configured() { return Boolean(this.user && this.pass) || Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM); },
};

/** The sign-in page of the site the person is using now. */
export async function signInUrl(): Promise<string> {
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host")}/sign-in`;
}

/**
 * Email a person their temporary password. Returns whether it was handed to
 * the mail server; never throws, because the account change has already
 * happened and the password is also shown to whoever made it.
 */
export async function sendSignInEmail(message: Omit<SignInEmail, "signInUrl">): Promise<boolean> {
  if (!emailEnv.configured) return false;
  try {
    const transport = nodemailer.createTransport({
      host: emailEnv.host,
      port: emailEnv.port,
      secure: emailEnv.port === 465,
      auth: emailEnv.user ? { user: emailEnv.user, pass: emailEnv.pass } : undefined,
      connectionTimeout: 10_000,
      socketTimeout: 15_000,
    });
    const { subject, text, html } = signInEmail({ ...message, signInUrl: await signInUrl() });
    await transport.sendMail({ from: { name: "Drivo", address: emailEnv.from }, to: message.email, subject, text, html });
    return true;
  } catch {
    return false;
  }
}

/** For the notice shown after making or resetting an account. */
export const emailedParam = (sent: boolean): Record<string, string> => (sent ? { emailed: "1" } : emailEnv.configured ? { emailed: "0" } : {});
