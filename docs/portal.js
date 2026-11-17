/**
 * Gold Mobile Mechanic customer portal — open door.
 *
 * Every customer with a filed invoice is listed by name. Anyone can open
 * anyone's profile and read the work and the totals: that is the deliberate
 * design, chosen by Thomas, not an oversight.
 *
 * What the worker never sends and this page therefore cannot show: phone
 * numbers, email addresses, receipt images, cost basis, the clock ledger, and
 * any job that has not been invoiced yet — with one exception. An estimate
 * link (#estimate/TOKEN) opens that one open job's estimate: first name,
 * vehicle, priced lines. It is never listed; only the token reaches it.
 *
 * Read-only except one write: a customer answering an estimate link posts
 * their per-line answers and typed signature.
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
    const lines = [
      ["Labor", invoice.laborCents],
      ["Parts and materials", invoice.partsCents],
      ["Approved parts and fees", invoice.quotedCents],
      ["Shop supplies", invoice.shopSuppliesCents],
      ["Sales tax", invoice.taxCents]
    ]
      .filter(([label, cents]) => Number(cents || 0) || label === "Labor" || label === "Parts and materials")
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
        ${invoice.flatLabor
          ? `<p class="portal-hours">Flat-rate labor from your approved estimate</p>`
          : invoice.workSeconds ? `<p class="portal-hours">${escapeHtml(hoursLabel(invoice.workSeconds))} of labor</p>` : ""}
        ${lines}
        <div class="portal-line portal-total">
          <span>Total</span>
          <strong>${escapeHtml(money(invoice.totalCents))}</strong>
        </div>
        ${Number(invoice.depositCents || 0) ? `
          <div class="portal-line"><span>Deposit received</span><strong>−${escapeHtml(money(invoice.depositCents))}</strong></div>
          <div class="portal-line portal-total"><span>Balance due</span><strong>${escapeHtml(money(invoice.balanceDueCents))}</strong></div>` : ""}
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

  // ------------------------------------------------------------------ estimate
  //
  // Reached only from the link the mechanic sends (#estimate/TOKEN). The one
  // write this page makes: the customer's per-line answers and typed signature.

  const estimateView = $("portalEstimate");
  let estimateToken = "";
  let estimateData = null;
  const answers = {};

  function estimateTotalsFor(estimate, keep) {
    const lines = estimate.lines.filter(keep);
    const labor = lines.filter((l) => l.kind === "labor").reduce((s, l) => s + l.amountCents, 0);
    const other = lines.filter((l) => l.kind !== "labor").reduce((s, l) => s + l.amountCents, 0);
    const supplies = Math.round(labor * (estimate.shopSuppliesPct || 0) / 100);
    const tax = Math.round((labor + other + supplies) * (estimate.taxRatePct || 0) / 100);
    return { labor, other, supplies, tax, total: labor + other + supplies + tax };
  }

  function renderEstimate() {
    const estimate = estimateData;
    const answered = estimate.status === "responded";
    $("estimateNumber").textContent = estimate.estimateNumber || "Estimate";
    $("estimateTitle").textContent = estimate.vehicle || "Your estimate";
    $("estimateIntro").textContent = answered
      ? `Signed by ${estimate.signatureName} on ${calendarDate(estimate.respondedAt)}. Thank you.`
      : `${estimate.firstName ? `Hi ${estimate.firstName}. ` : ""}Approve or decline each item, then sign at the bottom.`;
    const bulk = !answered && estimate.lines.length > 1
      ? `<div class="estimate-bulk"><button type="button" class="button button-quiet" data-answer-all="approved">Approve all</button></div>`
      : "";
    $("estimateLines").innerHTML = bulk + estimate.lines.map((line) => {
      const choice = answered ? line.decision : answers[line.id];
      const detail = line.kind === "labor" ? `${line.quantity} hr` : `Qty ${line.quantity}`;
      return `
        <div class="estimate-line" data-line="${escapeHtml(line.id)}">
          <div><strong>${escapeHtml(line.description)}</strong>
            <span class="portal-hours">${escapeHtml(detail)} · ${escapeHtml(money(line.unitCents))} each</span></div>
          <div class="estimate-line-end">
            <strong>${escapeHtml(money(line.amountCents))}</strong>
            ${answered
              ? `<span class="status-pill ${choice === "approved" ? "invoiced" : "archived"}">${choice === "approved" ? "Approved" : "Declined"}</span>`
              : `<span class="estimate-choice" role="group" aria-label="Approve or decline ${escapeHtml(line.description)}">
                  <button type="button" class="button ${choice === "approved" ? "button-gold" : "button-quiet"}" data-answer="approved" data-id="${escapeHtml(line.id)}" aria-pressed="${choice === "approved"}">Approve</button>
                  <button type="button" class="button ${choice === "declined" ? "button-dark" : "button-quiet"}" data-answer="declined" data-id="${escapeHtml(line.id)}" aria-pressed="${choice === "declined"}">Decline</button>
                </span>`}
          </div>
        </div>`;
    }).join("");
    const totals = estimateTotalsFor(estimate, (line) =>
      (answered ? line.decision : answers[line.id]) !== "declined");
    const row = (label, cents) => `<div class="portal-line"><span>${escapeHtml(label)}</span><strong>${escapeHtml(money(cents))}</strong></div>`;
    $("estimateTotals").innerHTML = [
      row("Labor", totals.labor),
      row("Parts and fees", totals.other),
      totals.supplies ? row("Shop supplies", totals.supplies) : "",
      totals.tax ? row("Sales tax", totals.tax) : "",
      `<div class="portal-line portal-total"><span>${answered ? "Approved total" : "Total for what you approve"}</span><strong>${escapeHtml(money(totals.total))}</strong></div>`,
      estimate.depositCents ? `<p class="portal-hours">Deposit requested before work starts: ${escapeHtml(money(estimate.depositCents))}</p>` : ""
    ].join("");
    $("estimateNotes").textContent = estimate.notes || "";
    $("estimateSign").classList.toggle("hidden", answered);
  }

  async function openEstimate(token) {
    estimateToken = token;
    document.title = "Your estimate · Gold Mobile Mechanic";
    const brandLabel = document.querySelector(".brand small");
    if (brandLabel) brandLabel.textContent = "Estimate";
    directoryView.classList.add("hidden");
    profileView.classList.add("hidden");
    estimateView.classList.remove("hidden");
    try {
      const payload = await getJson(`/api/portal/estimates/${encodeURIComponent(token)}`);
      if (!payload.estimate) throw new Error("This estimate link is no longer active.");
      estimateData = payload.estimate;
      $("estimateForm").classList.remove("hidden");
      renderEstimate();
    } catch (error) {
      $("estimateForm").classList.add("hidden");
      $("estimateError").textContent = error instanceof Error ? error.message : "Could not open this estimate.";
      $("estimateError").classList.remove("hidden");
    }
  }

  $("estimateLines").addEventListener("click", (event) => {
    if (!estimateData || estimateData.status === "responded") return;
    const all = event.target.closest?.("[data-answer-all]");
    if (all) {
      estimateData.lines.forEach((line) => { answers[line.id] = all.dataset.answerAll; });
      renderEstimate();
      return;
    }
    const button = event.target.closest?.("[data-answer]");
    if (!button) return;
    answers[button.dataset.id] = button.dataset.answer;
    renderEstimate();
  });

  $("estimateForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!estimateData || estimateData.status === "responded") return;
    const errorLine = $("estimateError");
    errorLine.classList.add("hidden");
    const missing = estimateData.lines.some((line) => !answers[line.id]);
    const signatureName = $("estimateSignature").value.trim();
    const problem = missing ? "Approve or decline every item first."
      : signatureName.length < 2 ? "Type your full name to sign."
      : !$("estimateAgree").checked ? "Tick the box to confirm." : "";
    if (problem) {
      errorLine.textContent = problem;
      errorLine.classList.remove("hidden");
      return;
    }
    const submit = $("estimateSubmit");
    submit.disabled = true;
    try {
      let response;
      try {
        response = await fetch(`${SYNC_API}/api/portal/estimates/${encodeURIComponent(estimateToken)}/decision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decisions: answers, signatureName, agree: true })
        });
      } catch {
        throw new Error("We couldn't reach the shop's system. Check your signal and try again.");
      }
      const payload = await response.json().catch(() => ({}));
      if (response.status === 409) {
        // Already answered (another tab, a double tap): show what is on file.
        await openEstimate(estimateToken);
        throw new Error(payload.error || "This estimate was already answered.");
      }
      if (!response.ok) throw new Error(payload.error || "That didn't go through. Try again.");
      estimateData = payload.estimate;
      renderEstimate();
      $("estimateDone").textContent = "Sent. Your mechanic has your answers.";
      $("estimateDone").classList.remove("hidden");
    } catch (error) {
      errorLine.textContent = error instanceof Error ? error.message : "That didn't go through. Try again.";
      errorLine.classList.remove("hidden");
      submit.disabled = false;
    }
  });

  async function initialize() {
    const estimateLink = /^#estimate\/([A-Za-z0-9_-]+)$/.exec(window.location.hash || "");
    if (estimateLink) {
      await openEstimate(estimateLink[1]);
      return;
    }
    // The open directory starts hidden so an estimate link never flashes it.
    directoryView.classList.remove("hidden");
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
