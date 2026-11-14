// The sign-in email sent when an account is made or a password is reset.
// Kept apart from the sender so the wording can be tested.

export type SignInEmail = {
  kind: "created" | "reset";
  /** The person's name, when known. */
  name: string | null;
  /** The company they work for in Drivo, or null for a platform account. */
  companyName: string | null;
  email: string;
  password: string;
  /** Where they sign in, for example https://drivo.example/sign-in. */
  signInUrl: string;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function signInEmail(m: SignInEmail): { subject: string; text: string; html: string } {
  const company = m.companyName ? ` for ${m.companyName}` : "";
  const subject = m.kind === "created" ? `Your Drivo sign-in${company}` : `Your Drivo password was reset${company}`;
  const opening = m.kind === "created"
    ? `An account has been made for you on Drivo${company}.`
    : `Your Drivo password${company} was reset by an administrator. Your old password no longer works.`;
  const lines = [
    `Hello${m.name ? ` ${m.name}` : ""},`,
    opening,
    `Sign in at: ${m.signInUrl}`,
    `Email: ${m.email}`,
    `Temporary password: ${m.password}`,
    "After signing in, choose your own password with Change password. Drivers use the same email and password in the Drivo app.",
    "If you were not expecting this email, tell your manager.",
  ];
  const html = `<div style="font-family:'IBM Plex Sans',Arial,sans-serif;font-size:15px;line-height:1.5;color:#0B1220;max-width:520px">
<p>${esc(lines[0])}</p>
<p>${esc(opening)}</p>
<table style="border-collapse:collapse;margin:16px 0">
<tr><td style="padding:4px 16px 4px 0;color:#5D6B82">Sign in at</td><td style="padding:4px 0"><a href="${esc(m.signInUrl)}" style="color:#2563EB">${esc(m.signInUrl)}</a></td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#5D6B82">Email</td><td style="padding:4px 0">${esc(m.email)}</td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#5D6B82">Temporary password</td><td style="padding:4px 0;font-weight:600">${esc(m.password)}</td></tr>
</table>
<p>${esc(lines[5])}</p>
<p style="color:#5D6B82">${esc(lines[6])}</p>
</div>`;
  return { subject, text: lines.join("\n\n"), html };
}
