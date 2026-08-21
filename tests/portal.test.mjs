/**
 * Drives docs/portal.js as shipped, in the real docs/portal.html, in a real
 * DOM. The customer portal is open by design, so what this pins down is that
 * browsing works with no sign-in AND that nothing beyond names, vehicles, and
 * filed invoice totals ever reaches the page.
 *
 * Needs `linkedom`; skipped with a clear message when it is absent.
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { fileURLToPath } from "node:url";

const DOCS = fileURLToPath(new URL("../docs/", import.meta.url)).replace(/\/$/, "");
let parseHTML;
try {
  ({ parseHTML } = await import("linkedom"));
} catch {
  parseHTML = null;
}

test("the customer portal is browsable by anyone, with no contact details on it", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const { window: dom } = parseHTML(readFileSync(`${DOCS}/portal.html`, "utf8"));
  const requests = [];

  const DIRECTORY = { customers: [
    { id: "aaa", name: "Ada Lin", vehicles: ["2019 Toyota Camry"], invoiceCount: 1, latestAt: "2026-08-19T18:00:00.000Z" },
    { id: "bbb", name: "deShaun O'Brien-Katz", vehicles: ["2012 Chevrolet Cruze"], invoiceCount: 2, latestAt: "2026-08-21T18:00:00.000Z" }
  ]};
  const PROFILE = { customer: { id: "bbb", name: "deShaun O'Brien-Katz", vehicles: ["2012 Chevrolet Cruze"], invoices: [
    { jobId: "GMM-0004", invoiceNumber: "GMM-INV-0004", createdAt: "2026-08-21T18:00:00.000Z",
      vehicle: "2012 Chevrolet Cruze", agreedWork: "Brakes", suggestions: "",
      laborCents: 20000, partsCents: 5000, totalCents: 25000, workSeconds: 7200 },
    { jobId: "GMM-0001", invoiceNumber: "GMM-INV-0001", createdAt: "2026-08-20T18:00:00.000Z",
      vehicle: "2012 Chevrolet Cruze", agreedWork: "Oil filter housing", suggestions: "Rear pads soon",
      laborCents: 30000, partsCents: 8000, totalCents: 38000, workSeconds: 9000 }
  ]}};

  const context = {
    console, setTimeout, clearTimeout, document: dom.document,
    Response: globalThis.Response, Event: dom.Event, CustomEvent: dom.CustomEvent,
    fetch: async (url) => {
      requests.push(String(url));
      const body = String(url).includes("/customers/") ? PROFILE : DIRECTORY;
      return new Response(JSON.stringify(body), { status: 200 });
    }
  };
  context.window = context; context.self = context;
  context.location = { hash: "", origin: "https://x.github.io", pathname: "/gmm/portal.html" };
  context.scrollTo = () => {};
  vm.createContext(context);
  vm.runInContext(readFileSync(`${DOCS}/portal.js`, "utf8"), context, { filename: "portal.js" });
  const settle = () => new Promise((r) => setTimeout(r, 40));
  await settle();

  const doc = dom.document;
  const ok = () => {};

  // Everyone is listed, with no sign-in in the way.
  let list = doc.getElementById("portalList").innerHTML;
  assert.match(list, /Ada Lin/);
  assert.match(list, /deShaun O&#39;Brien-Katz|deShaun O'Brien-Katz/);
  assert.match(list, /2 invoices/);
  assert.doesNotMatch(doc.body.innerHTML, /sign in|Sign in/i);
  ok("every customer is listed with no sign-in");

  // Search narrows the list.
  const search = doc.getElementById("portalSearch");
  search.value = "ada";
  search.dispatchEvent(new dom.Event("input"));
  list = doc.getElementById("portalList").innerHTML;
  assert.match(list, /Ada Lin/);
  assert.doesNotMatch(list, /Brien/);
  ok("search narrows the directory");

  search.value = "";
  search.dispatchEvent(new dom.Event("input"));

  // Anyone can open anyone.
  const rows = [...doc.querySelectorAll("[data-customer]")];
  assert.equal(rows.length, 2);
  rows.find((r) => r.dataset.customer === "bbb").dispatchEvent(new dom.Event("click", { bubbles: true }));
  await settle();

  assert.equal(doc.getElementById("portalName").textContent, "deShaun O'Brien-Katz");
  assert.match(doc.getElementById("portalSummary").textContent, /2 invoices · \$630\.00 of work/);
  const out = doc.getElementById("portalInvoices").innerHTML;
  assert.match(out, /GMM-INV-0004/);
  assert.match(out, /GMM-INV-0001/);
  assert.match(out, /\$250\.00/);
  assert.match(out, /2h 30m/);
  assert.match(out, /Rear pads soon/);
  assert.equal(doc.getElementById("portalDirectory").classList.contains("hidden"), true);
  ok("clicking a customer opens their invoices");

  // Deep link recorded so a profile can be shared.
  assert.equal(context.location.hash, "customer/bbb");
  ok("a profile is linkable");

  // Back returns to the list.
  doc.getElementById("portalBack").dispatchEvent(new dom.Event("click"));
  assert.equal(doc.getElementById("portalDirectory").classList.contains("hidden"), false);
  assert.equal(doc.getElementById("portalProfile").classList.contains("hidden"), true);
  ok("back returns to the directory");

  // Re-rendering on every keystroke must not stack listeners: one click, one fetch.
  const before = requests.length;
  search.value = "de";
  search.dispatchEvent(new dom.Event("input"));
  search.value = "des";
  search.dispatchEvent(new dom.Event("input"));
  doc.querySelector("[data-customer]").dispatchEvent(new dom.Event("click", { bubbles: true }));
  await settle();
  assert.equal(requests.length, before + 1);
  ok("a tap fires exactly one request after re-rendering");


});
