/**
 * Gold Mobile Mechanic customer portal — open door.
 *
 * Every customer with a filed invoice is listed by name. Anyone can open
 * anyone's profile and read the work and the totals: that is the deliberate
 * design, chosen by Thomas, not an oversight.
 *
 * What the worker never sends and this page therefore cannot show: phone
 * numbers, email addresses, receipt images, cost basis, the clock ledger, and
 * any job that has not been invoiced yet.
 *
 * Read-only throughout — the only calls it makes are two GETs.
 */
(() => {
  "use strict";

  const SYNC_API = "https://gold-mobile-mechanic-sync.forevergoldai.workers.dev";

  const $ = (id) => document.getElementById(id);
  const directoryView = $("portalDirectory");
  const profileView = $("portalProfile");
  const listBox = $("portalList");
  const errorBox = $("portalError");
  const searchInput = $("portalSearch");

  let customers = [];

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[character]));
  }

  function money(cents) {
    return (Number(cents || 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  }

  function calendarDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function hoursLabel(seconds) {
    const minutes = Math.max(0, Math.round(Number(seconds || 0) / 60));
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove("hidden");
  }

  function clearError() {
    errorBox.textContent = "";
    errorBox.classList.add("hidden");
  }

  async function getJson(path) {
    const response = await fetch(`${SYNC_API}${path}`, { cache: "no-store" });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new Error(payload?.error || "We couldn't reach the invoice system. Try again in a moment.");
    }
    return payload || {};
  }

  // ----------------------------------------------------------------- directory

  function customerRow(customer) {
    const vehicles = (customer.vehicles || []).join(" · ");
    const count = Number(customer.invoiceCount || 0);
    return `
      <button class="content-card portal-customer" type="button" data-customer="${escapeHtml(customer.id)}">
        <span class="portal-customer-name">${escapeHtml(customer.name)}</span>
        ${vehicles ? `<span class="portal-customer-vehicles">${escapeHtml(vehicles)}</span>` : ""}
        <span class="portal-customer-meta">${count} invoice${count === 1 ? "" : "s"}${customer.latestAt ? ` · latest ${escapeHtml(calendarDate(customer.latestAt))}` : ""}</span>
      </button>`;
  }

  function renderList() {
    const term = searchInput.value.trim().toLowerCase();
    const matches = term
      ? customers.filter((customer) => String(customer.name).toLowerCase().includes(term))
      : customers;
    listBox.innerHTML = matches.length
      ? matches.map(customerRow).join("")
      : `<p class="history-empty">${customers.length
        ? "No customer matches that name."
        : "No invoices have been filed yet."}</p>`;
  }

  // ------------------------------------------------------------------- profile

  function invoiceMarkup(invoice) {
    const lines = [["Labor", invoice.laborCents], ["Parts and materials", invoice.partsCents]]
      .map(([label, cents]) => `
        <div class="portal-line">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(money(cents))}</strong>
        </div>`)
      .join("");

    return `
      <article class="content-card portal-invoice">
        <div class="card-heading">
          <div>
            <p class="eyebrow">${escapeHtml(invoice.invoiceNumber || "Invoice")}</p>
            <h2>${escapeHtml(invoice.vehicle || "Vehicle")}</h2>
          </div>
          <span class="status-pill invoiced">${escapeHtml(calendarDate(invoice.createdAt))}</span>
        </div>
        ${invoice.agreedWork ? `<p class="portal-work">${escapeHtml(invoice.agreedWork)}</p>` : ""}
        ${invoice.workSeconds ? `<p class="portal-hours">${escapeHtml(hoursLabel(invoice.workSeconds))} of labor</p>` : ""}
        ${lines}
        <div class="portal-line portal-total">
          <span>Total</span>
          <strong>${escapeHtml(money(invoice.totalCents))}</strong>
        </div>
        ${invoice.suggestions ? `
          <div class="portal-notes">
            <span class="detail-label">What we recommended next</span>
            <p>${escapeHtml(invoice.suggestions)}</p>
          </div>` : ""}
      </article>`;
  }

  function renderProfile(customer) {
    const invoices = Array.isArray(customer.invoices) ? customer.invoices : [];
    const total = invoices.reduce((sum, invoice) => sum + Number(invoice.totalCents || 0), 0);
    $("portalName").textContent = customer.name;
    $("portalSummary").textContent = invoices.length
      ? `${invoices.length} invoice${invoices.length === 1 ? "" : "s"} · ${money(total)} of work`
      : "No invoices filed yet.";
    $("portalInvoices").innerHTML = invoices.length
      ? invoices.map(invoiceMarkup).join("")
      : `<article class="content-card"><p>No invoices are filed for this customer yet.</p></article>`;
    directoryView.classList.add("hidden");
    profileView.classList.remove("hidden");
    window.scrollTo({ top: 0 });
  }

  async function openCustomer(id) {
    clearError();
    try {
      const payload = await getJson(`/api/portal/customers/${encodeURIComponent(id)}`);
      if (!payload.customer) throw new Error("That customer could not be found.");
      renderProfile(payload.customer);
      window.location.hash = `customer/${encodeURIComponent(id)}`;
    } catch (error) {
      showError(error instanceof Error ? error.message : "Could not open that customer.");
    }
  }

  function showDirectory() {
    profileView.classList.add("hidden");
    directoryView.classList.remove("hidden");
    if (window.location.hash) window.location.hash = "";
  }

  // The list is re-rendered on every search keystroke, so the click handler is
  // bound once on the container rather than per row — binding per render would
  // stack a fresh listener on every keystroke and fire a tap several times.
  listBox.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-customer]");
    if (button) void openCustomer(button.dataset.customer);
  });

  searchInput.addEventListener("input", renderList);
  $("portalBack").addEventListener("click", showDirectory);

  async function initialize() {
    try {
      const payload = await getJson("/api/portal/customers");
      customers = Array.isArray(payload.customers) ? payload.customers : [];
      renderList();
    } catch (error) {
      listBox.innerHTML = "";
      showError(error instanceof Error ? error.message : "Could not load the customer list.");
      return;
    }
    // A shared link opens straight to that customer.
    const deepLink = /^#customer\/(.+)$/.exec(window.location.hash || "");
    if (deepLink) await openCustomer(decodeURIComponent(deepLink[1]));
  }

  void initialize();
})();
