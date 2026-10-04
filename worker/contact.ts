export const RECIPIENT = "mario@lqa-consulting.com";
export const SENDER_EMAIL = "website@lqa-consulting.com";
export const SENDER_NAME = "LQA Consulting";

const NAME_MAX = 120;
const EMAIL_MAX = 254;
const MESSAGE_MAX = 5000;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ContactInput = {
  name?: unknown;
  email?: unknown;
  message?: unknown;
  consent?: unknown;
  hp_field?: unknown;
};

export type OutboundEmail = {
  to: string;
  from: { email: string; name: string };
  replyTo: string;
  subject: string;
  text: string;
};

export type ContactResult =
  | { ok: true; email: OutboundEmail }
  | { ok: false; error: "validation" };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function consentGiven(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "yes" || normalized === "on" || normalized === "true" || normalized === "1";
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

export function buildContactEmail(input: ContactInput): ContactResult {
  if (text(input.hp_field)) return { ok: false, error: "validation" };

  const name = singleLine(text(input.name));
  const email = text(input.email);
  const message = text(input.message);

  if (!consentGiven(input.consent)) return { ok: false, error: "validation" };
  if (!name || name.length > NAME_MAX) return { ok: false, error: "validation" };
  if (
    !email ||
    email.length > EMAIL_MAX ||
    /[\r\n]/.test(email) ||
    !EMAIL_PATTERN.test(email)
  ) {
    return { ok: false, error: "validation" };
  }
  if (!message || message.length > MESSAGE_MAX) return { ok: false, error: "validation" };

  return {
    ok: true,
    email: {
      to: RECIPIENT,
      from: { email: SENDER_EMAIL, name: SENDER_NAME },
      replyTo: email,
      subject: `Kontakt: ${name}`.slice(0, 180),
      text: [`Name: ${name}`, `E-Mail: ${email}`, "Einwilligung: ja", "", message].join("\n"),
    },
  };
}
