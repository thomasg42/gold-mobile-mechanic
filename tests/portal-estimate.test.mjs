/**
 * The customer's side of an estimate link, as shipped in docs/portal.html:
 * every line must be answered, then a typed name and the box, before the one
 * POST goes out; the open customer directory never shows on an estimate link.
 * Needs `linkedom`.
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { fileURLToPath } from "node:url";

const DOCS = fileURLToPath(new URL("../docs/", import.meta.url)).replace(/\/$/, "");
let parseHTML;
try { ({ parseHTML } = await import("linkedom")); } catch { parseHTML = null; }

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const ESTIMATE = {
  estimateNumber: "GMM-EST-1", firstName: "Ada", vehicle: "2019 Toyota Camry", status: "sent",
  taxRatePct: 0, shopSuppliesPct: 0, depositCents: 5000, notes: "Good for 14 days",
  lines: [
    { id: "l1", kind: "labor", description: "Front brakes", quantity: 2, unitCents: 10000, amountCents: 20000, decision: "pending" },
    { id: "l2", kind: "part", description: "Rotors", quantity: 2, unitCents: 7000, amountCents: 14000, decision: "pending" }
  ]
};
const answered = (decisions, signatureName = "Ada Lin") => ({
  ...ESTIMATE, status: "responded", signatureName, respondedAt: "2026-11-16T18:00:00.000Z",
  lines: ESTIMATE.lines.map((l) => ({ ...l, decision: decisions[l.id] }))
});

function boot(respond) {
  const { window: dom } = parseHTML(readFileSync(`${DOCS}/portal.html`, "utf8"));
  const doc = dom.document;
  const requests = [];
  const context = {
    console, setTimeout, clearTimeout, document: doc, Event: dom.Event,
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
      return respond(String(url), options);
    }
  };
  context.window = context;
  context.location = { hash: `#estimate/${TOKEN}` };
  context.scrollTo = () => {};
  vm.createContext(context);
  vm.runInContext(readFileSync(`${DOCS}/portal.js`, "utf8"), context);
  return { dom, doc, requests };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("customer approves and signs an estimate", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const { dom, doc, requests } = boot((url, options) => options.method === "POST"
    ? json({ estimate: answered(JSON.parse(options.body).decisions, JSON.parse(options.body).signatureName) })
    : json({ estimate: ESTIMATE }));
  await settle();

  assert.ok(!doc.getElementById("portalEstimate").classList.contains("hidden"));
  assert.ok(doc.getElementById("portalDirectory").classList.contains("hidden"), "the customer list stays out of view");
  assert.ok(!requests.some((r) => r.url.endsWith("/api/portal/customers")), "the directory is never even fetched");
  assert.equal(doc.title, "Your estimate · Gold Mobile Mechanic");
  assert.match(doc.getElementById("estimateTotals").textContent, /\$340\.00/);
  assert.match(doc.getElementById("estimateTotals").textContent, /Deposit requested before work starts: \$50\.00/);

  const submit = () => doc.getElementById("estimateForm").dispatchEvent(new dom.Event("submit", { cancelable: true }));
  const posts = () => requests.filter((r) => r.method === "POST");
  submit(); await settle();
  assert.equal(posts().length, 0, "nothing is sent before every line is answered");
  assert.match(doc.getElementById("estimateError").textContent, /every item/);

  // Approve all, then change one mind.
  doc.querySelector("[data-answer-all]").dispatchEvent(new dom.Event("click", { bubbles: true }));
  await settle();
  assert.equal(doc.querySelectorAll('[data-answer="approved"][aria-pressed="true"]').length, 2);
  doc.querySelector('[data-answer="declined"][data-id="l2"]').dispatchEvent(new dom.Event("click", { bubbles: true }));
  await settle();
  assert.match(doc.getElementById("estimateTotals").textContent, /\$200\.00/, "the total follows the answers");

  doc.getElementById("estimateSignature").value = "Ada Lin";
  submit(); await settle();
  assert.equal(posts().length, 0, "the confirm box is required");

  doc.getElementById("estimateAgree").checked = true;
  submit(); await settle();
  assert.equal(posts().length, 1);
  assert.ok(posts()[0].url.endsWith(`/api/portal/estimates/${TOKEN}/decision`));
  assert.deepEqual(posts()[0].body, { decisions: { l1: "approved", l2: "declined" }, signatureName: "Ada Lin", agree: true });
  assert.ok(doc.getElementById("estimateSign").classList.contains("hidden"), "signed estimates can't be re-signed");
  assert.match(doc.getElementById("estimateIntro").textContent, /Signed by Ada Lin/);
  assert.match(doc.getElementById("estimateDone").textContent, /Sent/);
});

test("an estimate answered elsewhere shows what is on file", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  let onFile = ESTIMATE;
  const { dom, doc } = boot((url, options) => {
    if (options.method === "POST") {
      onFile = answered({ l1: "approved", l2: "approved" }, "Ada (other tab)");
      return json({ error: "This estimate was already answered. Call the shop to change it." }, 409);
    }
    return json({ estimate: onFile });
  });
  await settle();
  doc.querySelector("[data-answer-all]").dispatchEvent(new dom.Event("click", { bubbles: true }));
  doc.getElementById("estimateSignature").value = "Ada Lin";
  doc.getElementById("estimateAgree").checked = true;
  doc.getElementById("estimateForm").dispatchEvent(new dom.Event("submit", { cancelable: true }));
  await settle(); await settle();
  assert.match(doc.getElementById("estimateError").textContent, /already answered/);
  assert.match(doc.getElementById("estimateIntro").textContent, /Signed by Ada \(other tab\)/, "reloaded to the answer on file");
  assert.ok(doc.getElementById("estimateSign").classList.contains("hidden"));
});

test("no signal gives a plain sentence, and the answers stay put", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const { dom, doc } = boot((url, options) => {
    if (options.method === "POST") throw new TypeError("Failed to fetch");
    return json({ estimate: ESTIMATE });
  });
  await settle();
  doc.querySelector("[data-answer-all]").dispatchEvent(new dom.Event("click", { bubbles: true }));
  doc.getElementById("estimateSignature").value = "Ada Lin";
  doc.getElementById("estimateAgree").checked = true;
  doc.getElementById("estimateForm").dispatchEvent(new dom.Event("submit", { cancelable: true }));
  await settle();
  assert.match(doc.getElementById("estimateError").textContent, /couldn't reach the shop's system/);
  assert.equal(doc.getElementById("estimateSubmit").disabled, false, "they can try again");
  assert.equal(doc.querySelectorAll('[aria-pressed="true"]').length, 2, "their answers are still marked");
});

test("a dead link says so instead of showing an empty form", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const { doc } = boot(() => json({ error: "This estimate link is no longer active." }, 404));
  await settle();
  assert.ok(doc.getElementById("estimateForm").classList.contains("hidden"));
  assert.match(doc.getElementById("estimateError").textContent, /no longer active/);
});
