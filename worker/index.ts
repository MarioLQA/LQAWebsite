import { buildContactEmail, type ContactInput } from "./contact.ts";

const MAX_BODY = 32_000;

const SETUP_ERROR_CODES = new Set([
  "E_SENDER_NOT_VERIFIED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_RECIPIENT_NOT_ALLOWED",
]);

export interface EmailBinding {
  send(message: {
    to: string;
    from: string | { email: string; name?: string };
    replyTo?: string;
    subject: string;
    text: string;
  }): Promise<{ messageId?: string }>;
}

export interface Env {
  EMAIL?: EmailBinding;
  ASSETS: { fetch(request: Request): Promise<Response> };
}

type FailureCode = "validation" | "email_not_configured" | "send_failed";

const PAGES: Record<Exclude<FailureCode, "validation"> | "sent" | "invalid", { title: string; de: string; en: string; status: number }> = {
  sent: {
    title: "Nachricht unterwegs",
    de: "Danke. Die Nachricht ist unterwegs.",
    en: "Thank you. The message is on its way.",
    status: 200,
  },
  invalid: {
    title: "Angaben unvollständig",
    de: "Bitte Name, E-Mail und Nachricht ausfüllen und die Datenschutzerklärung bestätigen.",
    en: "Please fill in your name, email, and message, and confirm the privacy policy.",
    status: 400,
  },
  failed: {
    title: "Nachricht nicht gesendet",
    de: "Die Nachricht wurde nicht gesendet. Bitte schreiben Sie direkt an mario@lqa-consulting.com.",
    en: "The message was not sent. Please write directly to mario@lqa-consulting.com.",
    status: 503,
  },
};

function json(status: number, body: { ok: boolean; error?: FailureCode }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function page(kind: "sent" | "invalid" | "failed"): Response {
  const copy = PAGES[kind];
  const html = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${copy.title}</title>
</head>
<body style="margin:0;background:#050E1A;color:#E8E2D4;font-family:&quot;Segoe UI&quot;,system-ui,sans-serif;line-height:1.65">
  <main style="max-width:36rem;margin:0 auto;padding:6rem 1.5rem">
    <p style="font-size:1.25rem;margin:0 0 1rem">${copy.de}</p>
    <p style="margin:0 0 2rem;color:rgba(232,226,212,0.72)">${copy.en}</p>
    <p style="margin:0"><a href="/#contact" style="color:#E8E2D4">Zurück</a></p>
  </main>
</body>
</html>`;
  return new Response(html, {
    status: copy.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function wantsHtml(request: Request): boolean {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) return false;
  return (request.headers.get("accept") || "").includes("text/html");
}

function sameOrigin(request: Request): boolean {
  const expected = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin) return origin === expected;
  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === expected;
  } catch {
    return false;
  }
}

async function readInput(request: Request): Promise<ContactInput | "too_large" | "bad"> {
  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_BODY) return "too_large";

  let raw = "";
  try {
    raw = await request.text();
  } catch {
    return "bad";
  }
  if (raw.length > MAX_BODY) return "too_large";

  const type = request.headers.get("content-type") || "";
  try {
    if (type.includes("application/json")) {
      const data = JSON.parse(raw) as unknown;
      if (!data || typeof data !== "object" || Array.isArray(data)) return "bad";
      return data as ContactInput;
    }
    const form = new URLSearchParams(raw);
    return {
      name: form.get("name") ?? undefined,
      email: form.get("email") ?? undefined,
      message: form.get("message") ?? undefined,
      consent: form.get("consent") ?? undefined,
      hp_field: form.get("hp_field") ?? undefined,
    };
  } catch {
    return "bad";
  }
}

function failureFromSend(error: unknown): "email_not_configured" | "send_failed" {
  const code =
    typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
  return SETUP_ERROR_CODES.has(code) ? "email_not_configured" : "send_failed";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/contact") {
      return env.ASSETS.fetch(request);
    }

    if (request.method !== "POST") {
      return json(405, { ok: false, error: "validation" });
    }

    const html = wantsHtml(request);

    if (!sameOrigin(request)) {
      return html ? page("invalid") : json(403, { ok: false, error: "validation" });
    }

    const input = await readInput(request);
    if (input === "too_large" || input === "bad") {
      return html ? page("invalid") : json(input === "too_large" ? 413 : 400, { ok: false, error: "validation" });
    }

    const built = buildContactEmail(input);
    if (!built.ok) {
      return html ? page("invalid") : json(400, { ok: false, error: "validation" });
    }

    if (!env.EMAIL || typeof env.EMAIL.send !== "function") {
      return html ? page("failed") : json(503, { ok: false, error: "email_not_configured" });
    }

    try {
      await env.EMAIL.send(built.email);
    } catch (error) {
      const code = failureFromSend(error);
      return html ? page("failed") : json(503, { ok: false, error: code });
    }

    return html ? page("sent") : json(200, { ok: true });
  },
};
