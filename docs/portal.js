/**
 * Gold Mobile Mechanic customer portal.
 *
 * Customers sign in with the two things they actually remember — their first
 * name and their phone number — and see the invoices already filed against
 * their own jobs. Nothing here can create, edit, or close a job: the only call
 * it makes is the read-only lookup, and the worker decides what comes back.
 *
 * The credentials are deliberately low-friction, so they are held in
 * sessionStorage only (gone when the tab closes) and never written to the
 * address bar or to localStorage.
 */
(() => {
  "use strict";

  const SYNC_API = "https://gold-mobile-mechanic-sync.forevergoldai.workers.dev";
  const SESSION_KEY = "gold-mobile-mechanic-portal-session";

  const $ = (id) => document.getElementById(id);
  const signInView = $("portalSignIn");
  const resultsView = $("portalResults");
  const form = $("portalForm");
  const errorBox = $("portalError");
  const submitButton = $("portalSubmit");

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[character]));
  }

  function money(cents) {
    const value = Number(cents || 0) / 100;
    return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
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

  function invoiceMarkup(invoice) {
    const lines = [
      ["Labor", invoice.laborCents],
      ["Parts and materials", invoice.partsCents]
    ]
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
            <h2>${escapeHtml(invoice.vehicle || "Your vehicle")}</h2>
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
            <span class="detail-label">What we recommend next</span>
            <p>${escapeHtml(invoice.suggestions)}</p>
          </div>` : ""}
      </article>`;
  }

  function renderInvoices(payload, firstName) {
    const invoices = Array.isArray(payload.invoices) ? payload.invoices : [];
    $("portalGreeting").textContent = `${payload.customerName || firstName}'s invoices`;
    $("portalCount").textContent = invoices.length
      ? `${invoices.length} invoice${invoices.length === 1 ? "" : "s"} on file.`
      : "";
    $("portalInvoices").innerHTML = invoices.length
      ? invoices.map(invoiceMarkup).join("")
      : `<article class="content-card"><p>No invoices are filed under this name and number yet.
           A job that is still open does not have an invoice until it's finished.</p></article>`;
    signInView.classList.add("hidden");
    resultsView.classList.remove("hidden");
  }

  async function lookup(firstName, phone) {
    const response = await fetch(`${SYNC_API}/api/portal/lookup`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName, phone })
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new Error(payload?.error || "We couldn't reach the invoice system. Try again in a moment.");
    }
    return payload || { invoices: [] };
  }

  async function signIn(firstName, phone, { remember = true } = {}) {
    clearError();
    submitButton.disabled = true;
    submitButton.textContent = "Checking…";
    try {
      const payload = await lookup(firstName, phone);
      if (remember) {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ firstName, phone }));
      }
      renderInvoices(payload, firstName);
    } catch (error) {
      showError(error instanceof Error ? error.message : "Sign-in failed.");
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "See my invoices";
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const firstName = String(data.get("firstName") || "").trim();
    const phone = String(data.get("phone") || "").trim();
    if (!firstName || phone.replace(/\D/g, "").length < 10) {
      showError("Enter your first name and your full 10-digit phone number.");
      return;
    }
    void signIn(firstName, phone);
  });

  $("portalSignOut").addEventListener("click", () => {
    sessionStorage.removeItem(SESSION_KEY);
    $("portalInvoices").innerHTML = "";
    form.reset();
    resultsView.classList.add("hidden");
    signInView.classList.remove("hidden");
  });

  // Coming back to the tab within the same session skips re-typing the number.
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    if (saved?.firstName && saved?.phone) void signIn(saved.firstName, saved.phone, { remember: false });
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
  }
})();
