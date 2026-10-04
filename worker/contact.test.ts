import assert from "node:assert/strict";
import test from "node:test";
import { buildContactEmail, RECIPIENT, SENDER_EMAIL } from "./contact.ts";
import worker, { type Env } from "./index.ts";

const ORIGIN = "https://lqawebsite.example";

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Ada Lovelace",
    email: "ada@example.com",
    message: "Ein kurzer Test.",
    consent: true,
    hp_field: "",
    ...overrides,
  };
}

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("origin")) headers.set("origin", ORIGIN);
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

function envWith(send?: Env["EMAIL"] extends infer T ? T : never, assetsBody = "asset"): Env {
  return {
    EMAIL: send,
    ASSETS: {
      fetch: async () => new Response(assetsBody, { status: 200 }),
    },
  };
}

test("builds a message for Mario with name, email, message, and consent", () => {
  const result = buildContactEmail(validBody({ name: "Ada\nLovelace" }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.email.to, RECIPIENT);
  assert.equal(result.email.from.email, SENDER_EMAIL);
  assert.equal(result.email.replyTo, "ada@example.com");
  assert.equal(result.email.subject, "Kontakt: Ada Lovelace");
  assert.match(result.email.text, /Name: Ada Lovelace/);
  assert.match(result.email.text, /E-Mail: ada@example.com/);
  assert.match(result.email.text, /Einwilligung: ja/);
  assert.match(result.email.text, /Ein kurzer Test\./);
  assert.equal(result.email.subject.includes("\n"), false);
});

test("rejects a missing consent, a bad email, and the honeypot", () => {
  assert.equal(buildContactEmail(validBody({ consent: false })).ok, false);
  assert.equal(buildContactEmail(validBody({ consent: "no" })).ok, false);
  assert.equal(buildContactEmail(validBody({ email: "not-an-email" })).ok, false);
  assert.equal(buildContactEmail(validBody({ email: "ada@example.com\nBcc: x" })).ok, false);
  assert.equal(buildContactEmail(validBody({ hp_field: "spam" })).ok, false);
  assert.equal(buildContactEmail(validBody({ message: "   " })).ok, false);
});

test("POST /api/contact sends the email and does not claim success without a send", async () => {
  const sent: unknown[] = [];
  const response = await worker.fetch(
    request("/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(validBody()),
    }),
    envWith({
      send: async (message) => {
        sent.push(message);
        return { messageId: "msg-1" };
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(sent.length, 1);
  assert.equal((sent[0] as { to: string }).to, RECIPIENT);
});

test("missing email binding fails clearly", async () => {
  const response = await worker.fetch(
    request("/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(validBody()),
    }),
    envWith(undefined),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "email_not_configured" });
});

test("a domain that is not onboarded fails clearly and does not report success", async () => {
  const response = await worker.fetch(
    request("/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(validBody()),
    }),
    envWith({
      send: async () => {
        const error = new Error("Domain not onboarded") as Error & { code: string };
        error.code = "E_SENDER_DOMAIN_NOT_AVAILABLE";
        throw error;
      },
    }),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "email_not_configured" });
});

test("other delivery errors fail clearly", async () => {
  const response = await worker.fetch(
    request("/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(validBody()),
    }),
    envWith({
      send: async () => {
        throw new Error("smtp down");
      },
    }),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "send_failed" });
});

test("validation errors do not send", async () => {
  let called = false;
  const response = await worker.fetch(
    request("/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(validBody({ consent: false })),
    }),
    envWith({
      send: async () => {
        called = true;
        return { messageId: "nope" };
      },
    }),
  );
  assert.equal(response.status, 400);
  assert.equal(called, false);
  assert.deepEqual(await response.json(), { ok: false, error: "validation" });
});

test("cross-origin posts are rejected", async () => {
  let called = false;
  const response = await worker.fetch(
    request("/api/contact", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify(validBody()),
    }),
    envWith({
      send: async () => {
        called = true;
        return { messageId: "nope" };
      },
    }),
  );
  assert.equal(response.status, 403);
  assert.equal(called, false);
});

test("a browser form post without JavaScript gets an honest page", async () => {
  const sent = await worker.fetch(
    request("/api/contact", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({
        name: "Ada Lovelace",
        email: "ada@example.com",
        message: "Hallo",
        consent: "yes",
      }).toString(),
    }),
    envWith({
      send: async () => ({ messageId: "msg-2" }),
    }),
  );
  assert.equal(sent.status, 200);
  assert.match(await sent.text(), /Die Nachricht ist unterwegs/);

  const failed = await worker.fetch(
    request("/api/contact", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({
        name: "Ada Lovelace",
        email: "ada@example.com",
        message: "Hallo",
        consent: "yes",
      }).toString(),
    }),
    envWith(undefined),
  );
  const failedHtml = await failed.text();
  assert.equal(failed.status, 503);
  assert.match(failedHtml, /wurde nicht gesendet/);
  assert.equal(failedHtml.includes("unterwegs"), false);
});

test("GET /api/contact is not a successful send, and other paths serve assets", async () => {
  const api = await worker.fetch(request("/api/contact"), envWith(undefined));
  assert.equal(api.status, 405);

  const home = await worker.fetch(request("/"), envWith(undefined, "home"));
  assert.equal(home.status, 200);
  assert.equal(await home.text(), "home");
});
