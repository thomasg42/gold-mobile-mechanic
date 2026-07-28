(() => {
  "use strict";

  const STORAGE_KEY = "gold-mobile-mechanic-phone-v1";
  const RECEIPT_DB = "gold-mobile-mechanic-receipts";
  const RECEIPT_STORE = "receipts";
  const SYNC_API = "https://gold-mobile-mechanic-sync.forevergoldai.workers.dev";
  const SYNC_KEY_STORAGE = "gold-mobile-mechanic-sync-key-v1";
  const OCR_BASE = "./vendor/tesseract";
  const PENDING_JOBS_STORAGE = "gold-mobile-mechanic-pending-jobs-v1";
  const PENDING_RECEIPTS_STORAGE = "gold-mobile-mechanic-pending-receipts-v1";
  const STATUS_COPY = {
    draft: "Ready",
    in_progress: "On the clock",
    on_break: "On break",
    completed: "Clocked out",
    invoiced: "Invoice ready"
  };

  const $ = (id) => document.getElementById(id);
  const boardView = $("boardView");
  const jobView = $("jobView");
  const jobDialog = $("jobDialog");
  const jobForm = $("jobForm");
  const receiptDialog = $("receiptDialog");
  const receiptForm = $("receiptForm");
  const materialRows = $("materialRows");
  const toastElement = $("toast");

  let selectedJobId = null;
  let receiptJobId = null;
  let receiptPreviewUrl = null;
  let pendingCapture = null;
  let draftReceipts = [];
  let activeObjectUrls = [];
  let toastTimer = null;
  let syncInFlight = null;
  let ocrWorkerPromise = null;
  let pendingScan = { vendor: "", amount: 0, orderId: "", receiptParts: "" };

  function arrayFromStorage(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function writeStorageArray(key, values) {
    localStorage.setItem(key, JSON.stringify(values));
  }

  function derivedEventHistory(job) {
    const entries = [...(job.timeEntries || [])]
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const events = [];
    entries.forEach((entry, index) => {
      const action = entry.kind === "break"
        ? "break_start"
        : index === 0
          ? "clock_in"
          : "break_end";
      events.push({
        id: `legacy-${job.id}-${action}-${entry.startedAt}`,
        action,
        occurredAt: entry.startedAt
      });
    });
    if (job.endedAt) {
      events.push({
        id: `legacy-${job.id}-clock_out-${job.endedAt}`,
        action: "clock_out",
        occurredAt: job.endedAt
      });
    }
    return events;
  }

  function normalizeJob(job) {
    const normalized = {
      ...job,
      materials: Array.isArray(job.materials) ? job.materials : [],
      timeEntries: Array.isArray(job.timeEntries) ? job.timeEntries : [],
      receipts: (Array.isArray(job.receipts) ? job.receipts : []).map((receipt) => {
        const addCents = Number.isFinite(Number(receipt.addCents)) ? Math.max(0, Math.round(Number(receipt.addCents))) : 0;
        const subtractCents = Number.isFinite(Number(receipt.subtractCents)) ? Math.max(0, Math.round(Number(receipt.subtractCents))) : 0;
        let adjustCents = Number.isFinite(Number(receipt.adjustCents)) ? Math.max(0, Math.round(Number(receipt.adjustCents))) : 0;
        let adjustSign = Number(receipt.adjustSign) < 0 ? -1 : 1;
        if (!adjustCents && (addCents || subtractCents)) {
          if (subtractCents && !addCents) {
            adjustCents = subtractCents;
            adjustSign = -1;
          } else if (addCents) {
            adjustCents = addCents;
            adjustSign = 1;
          }
        }
        return {
          ...receipt,
          orderId: receipt.orderId || "",
          receiptParts: String(receipt.receiptParts || receipt.orderId || "").trim(),
          addCents,
          subtractCents,
          adjustCents,
          adjustSign
        };
      }),
      manualWorkSeconds: Number.isFinite(Number(job.manualWorkSeconds))
        ? Math.max(0, Math.round(Number(job.manualWorkSeconds)))
        : 0,
      laborAmountCents: job.laborAmountCents === null || job.laborAmountCents === undefined || job.laborAmountCents === ""
        ? null
        : (Number.isFinite(Number(job.laborAmountCents))
          ? Math.max(0, Math.round(Number(job.laborAmountCents)))
          : null),
      laborAdjustmentCents: Number.isFinite(Number(job.laborAdjustmentCents))
        ? Math.round(Number(job.laborAdjustmentCents))
        : 0,
      laborAdjustSign: Number(job.laborAdjustSign) < 0 ? -1 : 1,
      difficultyLevel: String(job.difficultyLevel || "Standard"),
      eventHistory: Array.isArray(job.eventHistory) && job.eventHistory.length
        ? job.eventHistory
        : derivedEventHistory(job)
    };
    normalized.updatedAt = normalized.updatedAt || normalized.createdAt || new Date().toISOString();
    return normalized;
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (saved && saved.version === 1 && Array.isArray(saved.jobs)) {
        return { ...saved, jobs: saved.jobs.map(normalizeJob) };
      }
    } catch {
      // A malformed local value should never prevent the app from opening.
    }
    return { version: 1, jobs: [] };
  }

  let state = loadState();

  function consumePairingKey() {
    const match = /^#sync=(\d{6})$/.exec(window.location.hash);
    if (!match) return false;
    localStorage.setItem(SYNC_KEY_STORAGE, match[1]);
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    return true;
  }

  const pairedFromUrl = consumePairingKey();

  function syncKey() {
    return localStorage.getItem(SYNC_KEY_STORAGE) || "";
  }

  function normalizeOwnerPin(value) {
    const digits = String(value || "").replace(/\D/g, "");
    return /^\d{6}$/.test(digits) ? digits : "";
  }

  async function ensureCloudSync() {
    if (!syncKey()) {
      const entered = window.prompt("Enter your 6-digit Gold Mobile PIN:");
      const pin = normalizeOwnerPin(entered);
      if (!pin) {
        notify("Cloud sync needs your 6-digit PIN before creating or changing jobs.", true);
        return false;
      }
      localStorage.setItem(SYNC_KEY_STORAGE, pin);
    }
    try {
      await syncFromCloud();
      return true;
    } catch (error) {
      localStorage.removeItem(SYNC_KEY_STORAGE);
      setSyncStatus("disconnected");
      notify(error instanceof Error ? error.message : "Cloud sync could not connect. Check the 6-digit PIN.", true);
      return false;
    }
  }

  function pendingJobIds() {
    return arrayFromStorage(PENDING_JOBS_STORAGE).filter((id) => typeof id === "string");
  }

  function pendingReceipts() {
    return arrayFromStorage(PENDING_RECEIPTS_STORAGE)
      .filter((item) => item && typeof item.jobId === "string" && typeof item.receiptId === "string");
  }

  function setSyncStatus(mode, detail) {
    const label = $("storageLabel");
    const dot = $("syncDot");
    if (!label || !dot) return;
    const count = `${state.jobs.length} job${state.jobs.length === 1 ? "" : "s"}`;
    const copy = {
      synced: `Cloud synced · ${count}`,
      syncing: `Syncing · ${count}`,
      pending: `Saved offline · ${count}`,
      disconnected: `Cloud not connected · ${count}`,
      error: `Sync needs attention · ${count}`
    };
    label.textContent = detail || copy[mode] || copy.disconnected;
    dot.dataset.sync = mode;
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      const message = String(error?.message || error || "");
      throw new Error(/quota|storage/i.test(message)
        ? "Job list storage is full on this phone browser. Receipt photos may still be saved — free Safari/Chrome site data and retry File All."
        : `Could not save job list: ${message || "unknown error"}`);
    }
    if (!syncKey()) setSyncStatus("disconnected");
    else if (pendingJobIds().length || pendingReceipts().length) {
      setSyncStatus(navigator.onLine ? "syncing" : "pending");
    }
  }

  function replaceJob(job) {
    const normalized = normalizeJob(job);
    const index = state.jobs.findIndex((item) => item.id === normalized.id);
    if (index === -1) state.jobs.push(normalized);
    else state.jobs[index] = normalized;
  }

  function queueJobSync(job) {
    job.updatedAt = new Date().toISOString();
    const ids = new Set(pendingJobIds());
    ids.add(job.id);
    writeStorageArray(PENDING_JOBS_STORAGE, [...ids]);
    saveState();
    void flushSyncQueue().catch(() => {});
  }

  function queueReceiptSync(jobIdValue, receiptId) {
    const pending = pendingReceipts();
    if (!pending.some((item) => item.jobId === jobIdValue && item.receiptId === receiptId)) {
      pending.push({ jobId: jobIdValue, receiptId });
      writeStorageArray(PENDING_RECEIPTS_STORAGE, pending);
    }
    saveState();
    void flushSyncQueue().catch(() => {});
  }

  async function cloudFetch(path, options = {}) {
    const key = syncKey();
    if (!key) throw new Error("Cloud sync is not connected.");
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${key}`);
    const response = await fetch(`${SYNC_API}${path}`, {
      ...options,
      cache: "no-store",
      headers
    });
    if (!response.ok) {
      let message = `Cloud sync failed (${response.status}).`;
      try {
        const payload = await response.json();
        if (payload?.error) message = payload.error;
      } catch {
        // Keep the status-based message when the response is not JSON.
      }
      throw new Error(message);
    }
    return response;
  }

  async function flushSyncQueue() {
    if (syncInFlight) return syncInFlight;
    if (!navigator.onLine || !syncKey()) {
      setSyncStatus(syncKey() ? "pending" : "disconnected");
      return;
    }

    syncInFlight = (async () => {
      setSyncStatus("syncing");
      try {
        let jobIds = pendingJobIds();
        for (const id of jobIds) {
          const job = findJob(id);
          if (!job) continue;
          const response = await cloudFetch(`/api/jobs/${encodeURIComponent(id)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(job)
          });
          const payload = await response.json();
          replaceJob(payload.job);
          jobIds = jobIds.filter((value) => value !== id);
          writeStorageArray(PENDING_JOBS_STORAGE, jobIds);
          saveState();
        }

        let receipts = pendingReceipts();
        for (const item of receipts) {
          const stored = await getReceipt(item.receiptId).catch(() => null);
          if (stored?.blob) {
            await cloudFetch(
              `/api/jobs/${encodeURIComponent(item.jobId)}/receipts/${encodeURIComponent(item.receiptId)}`,
              {
                method: "PUT",
                headers: { "Content-Type": stored.blob.type || "image/jpeg" },
                body: stored.blob
              }
            );
          }
          receipts = receipts.filter(
            (value) => value.jobId !== item.jobId || value.receiptId !== item.receiptId
          );
          writeStorageArray(PENDING_RECEIPTS_STORAGE, receipts);
        }
        localStorage.setItem("gold-mobile-mechanic-last-sync", new Date().toISOString());
        saveState();
        setSyncStatus("synced");
      } catch (error) {
        setSyncStatus(navigator.onLine ? "error" : "pending");
        throw error;
      } finally {
        syncInFlight = null;
      }
    })();

    return syncInFlight;
  }

  async function syncFromCloud() {
    if (!syncKey() || !navigator.onLine) {
      setSyncStatus(syncKey() ? "pending" : "disconnected");
      return;
    }

    setSyncStatus("syncing");
    const response = await cloudFetch("/api/jobs");
    const payload = await response.json();
    const remoteJobs = Array.isArray(payload.jobs) ? payload.jobs.map(normalizeJob) : [];
    const remoteIds = new Set(remoteJobs.map((job) => job.id));
    const pendingIds = new Set(pendingJobIds());

    remoteJobs.forEach((remote) => {
      const local = findJob(remote.id);
      if (!local || !pendingIds.has(remote.id)) replaceJob(remote);
    });

    state.jobs.forEach((local) => {
      if (!remoteIds.has(local.id)) {
        const ids = new Set(pendingJobIds());
        ids.add(local.id);
        writeStorageArray(PENDING_JOBS_STORAGE, [...ids]);
        local.receipts.forEach((receipt) => queueReceiptSync(local.id, receipt.id));
      }
    });

    saveState();
    await flushSyncQueue();
    setSyncStatus("synced");
  }

  function uid() {
    return crypto.randomUUID();
  }

  function jobId() {
    const now = new Date();
    const day = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0")
    ].join("");
    const token = crypto.randomUUID().replaceAll("-", "").slice(0, 4).toUpperCase();
    return `GMM-${day}-${token}`;
  }

  function parseCents(value) {
    const amount = Number.parseFloat(String(value || "").replaceAll(",", ""));
    return Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100)) : 0;
  }

  function parseSignedCents(value) {
    const amount = Number.parseFloat(String(value || "").replaceAll(",", ""));
    return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
  }

  function money(cents) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD"
    }).format((Number(cents) || 0) / 100);
  }

  function duration(seconds) {
    const safe = Math.max(0, Math.floor(seconds || 0));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const remaining = safe % 60;
    return [hours, minutes, remaining]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
  }

  function clockTime(value) {
    if (!value) return "—";
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date(value));
  }

  function calendarDate(value) {
    if (!value) return "—";
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric"
    }).format(new Date(value));
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    })[character]);
  }

  function vehicleName(job) {
    return [job.vehicleYear, job.vehicleMake, job.vehicleModel].filter(Boolean).join(" ");
  }

  function elapsedSeconds(job, kind, now = Date.now()) {
    return (job.timeEntries || [])
      .filter((entry) => entry.kind === kind)
      .reduce((total, entry) => {
        const start = Date.parse(entry.startedAt);
        const end = entry.endedAt ? Date.parse(entry.endedAt) : now;
        return total + Math.max(0, Math.floor((end - start) / 1000));
      }, 0);
  }

  function manualWorkSeconds(job) {
    const value = Number(job?.manualWorkSeconds);
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  }

  function billableSeconds(job, now = Date.now()) {
    return elapsedSeconds(job, "work", now) + manualWorkSeconds(job);
  }

  function hoursMinutes(seconds) {
    const total = Math.max(0, Math.round(seconds / 60));
    return { hours: Math.floor(total / 60), minutes: total % 60 };
  }

  function materialTotal(_job) {
    // Approved materials are a checklist only. Money comes from receipt capture.
    return 0;
  }

  function receiptEffectiveCents(receipt) {
    const base = Number(receipt.amountCents || 0);
    const adjust = Math.max(0, Number(receipt.adjustCents || 0));
    if (adjust) {
      const sign = Number(receipt.adjustSign) < 0 ? -1 : 1;
      return base + sign * adjust;
    }
    return base
      + Math.max(0, Number(receipt.addCents || 0))
      - Math.max(0, Number(receipt.subtractCents || 0));
  }

  function receiptTotal(job) {
    return (job.receipts || []).reduce(
      (total, receipt) => total + receiptEffectiveCents(receipt),
      0
    );
  }

  function partsTotal(job) {
    return receiptTotal(job);
  }

  function laborAdjustMagnitude(job) {
    const signed = Number(job.laborAdjustmentCents || 0);
    if (signed) return Math.abs(signed);
    return 0;
  }

  function laborAdjustSignValue(job) {
    if (Number(job.laborAdjustmentCents || 0) < 0) return -1;
    if (Number(job.laborAdjustSign) < 0) return -1;
    return 1;
  }

  function invoiceDraft(job) {
    const workSeconds = billableSeconds(job);
    const timedLaborCents = Math.round((workSeconds / 3600) * job.laborRateCents);
    const hasOwnLabor = job.laborAmountCents !== null && job.laborAmountCents !== undefined
      && Number.isFinite(Number(job.laborAmountCents));
    const baseLaborCents = hasOwnLabor
      ? Math.max(0, Math.round(Number(job.laborAmountCents)))
      : timedLaborCents;
    const magnitude = laborAdjustMagnitude(job);
    const sign = laborAdjustSignValue(job);
    const laborAdjustmentCents = sign * magnitude;
    const laborCents = Math.max(0, baseLaborCents + laborAdjustmentCents);
    const materialsCents = partsTotal(job);
    return {
      invoiceNumber: job.id.replace(/^GMM-/, "GMM-INV-"),
      createdAt: job.invoice?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workSeconds,
      timedLaborCents,
      baseLaborCents,
      laborAdjustmentCents,
      laborCents,
      materialsCents,
      totalCents: laborCents + materialsCents,
      difficultyLevel: String(job.difficultyLevel || "Standard")
    };
  }

  function requiredStar(label) {
    return `${escapeHtml(label)} <span class="req-star" aria-hidden="true">*</span>`;
  }

  function jobReadyForInvoice(job) {
    if (!Number(job.laborRateCents || 0)) {
      return "Enter the hourly labor rate before clock out & invoice.";
    }
    for (const receipt of job.receipts || []) {
      if (!String(receipt.vendor || "").trim()) return "Every receipt needs a vendor before clock out & invoice.";
      if (!String(receipt.receiptParts || receipt.orderId || "").trim()) {
        return "Every receipt needs receipt parts before clock out & invoice.";
      }
      if (!Number(receipt.amountCents || 0)) return "Every receipt needs a total amount before clock out & invoice.";
    }
    return "";
  }

  function laborAdjustmentNote(job, draft = invoiceDraft(job)) {
    const magnitude = Math.abs(Number(draft.laborAdjustmentCents || 0));
    if (!magnitude) return "No labor adjustment.";
    const sign = Number(draft.laborAdjustmentCents) < 0 ? "−" : "+";
    return `Adjusted by ${sign}${money(magnitude)} · original ${money(draft.timedLaborCents)} → new ${money(draft.laborCents)}`;
  }

  function receiptAdjustmentNote(receipt) {
    const adjust = Math.max(0, Number(receipt.adjustCents || 0));
    if (!adjust) {
      const legacy = Math.max(0, Number(receipt.addCents || 0)) + Math.max(0, Number(receipt.subtractCents || 0));
      if (!legacy) return "No receipt adjustment.";
    }
    const effective = receiptEffectiveCents(receipt);
    const base = Number(receipt.amountCents || 0);
    const delta = effective - base;
    if (!delta) return "No receipt adjustment.";
    const sign = delta < 0 ? "−" : "+";
    return `Adjusted by ${sign}${money(Math.abs(delta))} · original ${money(base)} → new ${money(effective)}`;
  }

  function upsertInvoice(job) {
    job.receiptReview = true;
    job.invoice = invoiceDraft(job);
    job.status = "invoiced";
    queueJobSync(job);
    return job.invoice;
  }

  function findJob(id) {
    return state.jobs.find((job) => job.id === id);
  }

  function notify(message, isError = false) {
    toastElement.textContent = message;
    toastElement.className = `toast${isError ? " error" : ""}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastElement.classList.add("hidden"), 3600);
  }

  function revokeObjectUrls() {
    activeObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    activeObjectUrls = [];
  }

  function openReceiptDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(RECEIPT_DB, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(RECEIPT_STORE)) {
          database.createObjectStore(RECEIPT_STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function receiptDatabaseAction(mode, action) {
    const database = await openReceiptDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(RECEIPT_STORE, mode);
      const store = transaction.objectStore(RECEIPT_STORE);
      let request;
      try {
        request = action(store);
      } catch (error) {
        database.close();
        reject(error);
        return;
      }
      if (request && typeof request === "object" && "onsuccess" in request) {
        request.onsuccess = () => {};
        request.onerror = () => {
          database.close();
          reject(request.error || new Error("Receipt storage request failed."));
        };
      }
      transaction.oncomplete = () => {
        database.close();
        resolve(request && "result" in request ? request.result : request);
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error || new Error("Receipt storage transaction failed."));
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error || new Error("Receipt storage aborted."));
      };
    });
  }

  async function storeReceipt(id, blob) {
    if (!(blob instanceof Blob) || !blob.size) {
      throw new Error("Receipt photo is empty.");
    }
    const type = blob.type || "image/jpeg";
    let buffer;
    try {
      buffer = await blob.arrayBuffer();
    } catch (error) {
      throw new Error(`Could not read receipt bytes: ${error?.message || error}`);
    }
    if (!buffer || !buffer.byteLength) throw new Error("Receipt photo bytes are empty.");
    try {
      await receiptDatabaseAction("readwrite", (store) => store.put({ id, buffer, type }));
    } catch (error) {
      // Safari sometimes rejects ArrayBuffer clones; fall back to a plain JPEG Blob.
      try {
        const fallback = new Blob([buffer], { type });
        await receiptDatabaseAction("readwrite", (store) => store.put({ id, blob: fallback, type }));
      } catch (fallbackError) {
        throw new Error(`Receipt storage failed: ${fallbackError?.message || error?.message || error}`);
      }
    }
  }

  async function getReceipt(id) {
    const row = await receiptDatabaseAction("readonly", (store) => store.get(id));
    if (!row) return null;
    if (row.blob instanceof Blob && row.blob.size) return { id: row.id || id, blob: row.blob };
    if (row.buffer) {
      return {
        id: row.id || id,
        blob: new Blob([row.buffer], { type: row.type || "image/jpeg" })
      };
    }
    return null;
  }

  async function getReceiptForJob(jobIdValue, receiptId) {
    const local = await getReceipt(receiptId).catch(() => null);
    if (local?.blob || !syncKey() || !navigator.onLine) return local;
    try {
      const response = await cloudFetch(
        `/api/jobs/${encodeURIComponent(jobIdValue)}/receipts/${encodeURIComponent(receiptId)}`
      );
      const blob = await response.blob();
      await storeReceipt(receiptId, blob);
      return { id: receiptId, blob };
    } catch {
      return null;
    }
  }

  function clearReceiptStore() {
    return receiptDatabaseAction("readwrite", (store) => store.clear());
  }

  function fileToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function dataUrlToBlob(value) {
    const [header, encoded] = value.split(",");
    const mime = /data:([^;]+)/.exec(header)?.[1] || "application/octet-stream";
    const bytes = atob(encoded);
    const array = new Uint8Array(bytes.length);
    for (let index = 0; index < bytes.length; index += 1) array[index] = bytes.charCodeAt(index);
    return new Blob([array], { type: mime });
  }

  async function compressReceipt(file) {
    const source = file instanceof Blob ? file : null;
    if (!source || !source.size) throw new Error("No receipt photo to compress.");

    const drawToJpeg = async (bitmapLike) => {
      const width = bitmapLike.width || bitmapLike.naturalWidth || 0;
      const height = bitmapLike.height || bitmapLike.naturalHeight || 0;
      if (!width || !height) throw new Error("Could not read receipt photo size.");
      const limit = 1600;
      const scale = Math.min(1, limit / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Receipt canvas unavailable.");
      context.drawImage(bitmapLike, 0, 0, canvas.width, canvas.height);
      if (typeof bitmapLike.close === "function") bitmapLike.close();
      for (const quality of [0.82, 0.72, 0.62, 0.52, 0.42]) {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (blob && blob.size) return blob;
      }
      throw new Error("Could not encode receipt JPEG.");
    };

    try {
      if (typeof createImageBitmap === "function") {
        return await drawToJpeg(await createImageBitmap(source));
      }
    } catch {
      // Fall through to HTMLImageElement path for older/quirky WebKit.
    }

    const objectUrl = URL.createObjectURL(source);
    try {
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("Could not open receipt photo."));
        element.src = objectUrl;
      });
      return await drawToJpeg(image);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function showBoard() {
    selectedJobId = null;
    window.location.hash = "";
    jobView.classList.add("hidden");
    boardView.classList.remove("hidden");
    revokeObjectUrls();
    renderBoard();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderBoard() {
    saveState();
    const jobs = [...state.jobs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (!jobs.length) {
      $("jobGrid").innerHTML = `
        <div class="empty-state">
          <strong>No work orders yet.</strong>
          <p>Create the first job when you arrive. The timer, receipts, notes, and final invoice will stay together.</p>
          <button class="button button-dark" id="emptyNewJob" type="button">Create first job</button>
        </div>`;
      $("emptyNewJob").addEventListener("click", openNewJob);
      return;
    }

    $("jobGrid").innerHTML = jobs.map((job) => `
      <button class="job-card" type="button" data-job-id="${escapeHtml(job.id)}" data-status="${escapeHtml(job.status)}">
        <span class="job-card-top">
          <span class="job-id">${escapeHtml(job.id)}</span>
          <span class="status-pill ${escapeHtml(job.status)}">${escapeHtml(STATUS_COPY[job.status] || job.status)}</span>
        </span>
        <h3>${escapeHtml(vehicleName(job) || "Vehicle not named")}</h3>
        <p class="customer">${escapeHtml(job.customerName)}</p>
        <span class="card-stats">
          <span><span>Work</span><strong>${duration(billableSeconds(job))}</strong></span>
          <span><span>Receipts</span><strong>${job.receipts.length}</strong></span>
          <span><span>Materials</span><strong>${job.materials.length}</strong></span>
        </span>
      </button>
    `).join("");

    document.querySelectorAll("[data-job-id]").forEach((button) => {
      button.addEventListener("click", () => openJob(button.dataset.jobId));
    });
  }

  async function openJob(id) {
    const job = findJob(id);
    if (!job) {
      showBoard();
      return;
    }
    selectedJobId = id;
    window.location.hash = `job/${encodeURIComponent(id)}`;
    boardView.classList.add("hidden");
    jobView.classList.remove("hidden");
    await renderJob();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function timerControls(job) {
    if (job.status === "draft") {
      return `<button class="button button-green" data-timer-action="clock_in" type="button">Clock in</button>`;
    }
    if (job.status === "in_progress") {
      return `<button class="button button-dark" data-timer-action="break_start" type="button">Start break</button>`;
    }
    if (job.status === "on_break") {
      return `<button class="button button-green" data-timer-action="break_end" type="button">End break</button>`;
    }
    return `<button class="button button-quiet" type="button" disabled>${job.status === "invoiced" ? "Invoice filed" : "Job complete"}</button>`;
  }

  function materialsMarkup(job, locked) {
    const items = Array.isArray(job.materials) ? job.materials : [];
    if (locked) {
      if (!items.length) return `<p class="materials-empty">No approved materials were entered for this job.</p>`;
      return `<ul class="materials-list">${items.map((item) => `<li>${escapeHtml(item.description || "")}</li>`).join("")}</ul>`;
    }

    const rows = items.length ? items : [{ id: uid(), description: "" }];
    return `
      <div id="jobMaterialRows">
        ${rows.map((item) => `
          <div class="material-row" data-material-id="${escapeHtml(item.id || uid())}">
            <label class="field">
              <span>Material</span>
              <input name="jobMaterialDescription" autocomplete="off" value="${escapeHtml(item.description || "")}" placeholder="Alternator">
            </label>
            <button class="icon-button" type="button" data-remove-material aria-label="Remove material">×</button>
          </div>`).join("")}
      </div>
      <div class="save-row materials-actions">
        <button class="button button-quiet" id="addJobMaterialButton" type="button">+ Add material</button>
        <button class="button button-quiet" id="saveMaterialsButton" type="button">Save materials</button>
      </div>`;
  }

  function invoiceMarkup(job) {
    if (!job.invoice) return "";
    return `
      <article class="content-card invoice-card">
        <div class="card-heading">
          <div>
            <p class="eyebrow">Filed invoice</p>
            <h2>${escapeHtml(job.invoice.invoiceNumber)}</h2>
            <p>${calendarDate(job.invoice.createdAt)} · ${escapeHtml(job.customerEmail || "Recipient email not entered")}</p>
          </div>
          <span class="status-pill invoiced">Ready</span>
        </div>
        <div class="invoice-meta">
          <span>Labor · ${money(job.invoice.laborCents)}</span>
          <span>Parts · ${money(job.invoice.materialsCents)}</span>
          <span>${job.receipts.length} receipt${job.receipts.length === 1 ? "" : "s"} filed</span>
        </div>
        <div class="invoice-total"><span>Total</span><strong>${money(job.invoice.totalCents)}</strong></div>
        <div class="invoice-actions">
          <button class="button button-dark" id="shareInvoiceButton" type="button">Share invoice</button>
          <button class="button button-quiet" id="downloadInvoiceButton" type="button">Download</button>
          <button class="button button-gold" id="emailInvoiceButton" type="button">Prepare email</button>
        </div>
      </article>`;
  }

  function receiptSuggestLabel(receipt) {
    const suggested = Number(receipt.suggestedAmountCents || 0);
    if (!suggested) return "";
    return `<span class="receipt-suggested">Suggested ${money(suggested)}</span>`;
  }

  async function receiptMarkup(job) {
    revokeObjectUrls();
    if (!job.receipts.length) return `<p class="receipt-empty">No receipts filed yet.</p>`;
    const locked = job.status === "invoiced";
    const rows = await Promise.all(job.receipts.map(async (receipt) => {
      const stored = await getReceiptForJob(job.id, receipt.id);
      let image = `<span class="receipt-thumb">▧</span>`;
      if (stored?.blob) {
        const url = URL.createObjectURL(stored.blob);
        activeObjectUrls.push(url);
        image = `<span class="receipt-thumb"><img src="${escapeHtml(url)}" alt=""></span>`;
      }
      const effective = receiptEffectiveCents(receipt);
      const adjustAbs = Math.max(0, Number(receipt.adjustCents || 0));
      const adjustSign = Number(receipt.adjustSign) < 0 ? -1 : 1;
      return `
        <article class="filed-receipt-card folder-receipt-card" data-folder-receipt="${escapeHtml(receipt.id)}">
          <button type="button" class="filed-receipt-photo" data-receipt-id="${escapeHtml(receipt.id)}">${image}</button>
          <div class="filed-receipt-body">
            <label class="field">
              <span>${requiredStar("Vendor")}</span>
              <input data-folder-vendor="${escapeHtml(receipt.id)}" value="${escapeHtml(receipt.vendor || "")}" placeholder="Auto Zone" ${locked ? "disabled" : ""}>
            </label>
            <label class="field">
              <span>${requiredStar("Receipt parts")}</span>
              <input data-folder-parts="${escapeHtml(receipt.id)}" value="${escapeHtml(receipt.receiptParts || receipt.orderId || "")}" placeholder="Receipt parts" ${locked ? "disabled" : ""}>
            </label>
            <label class="field">
              <span>${requiredStar("Receipt amount")}</span>
              <span class="money-input"><b>$</b><input data-folder-amount="${escapeHtml(receipt.id)}" inputmode="decimal" value="${Number(receipt.amountCents || 0) ? (Math.abs(Number(receipt.amountCents)) / 100).toFixed(2) : ""}" placeholder="0.00" ${locked ? "disabled" : ""}></span>
            </label>
            ${locked ? "" : `
              <label class="field">
                <span>Adjust amount</span>
                <span class="money-input draft-amount-input">
                  <b>$</b>
                  <input data-folder-adjust="${escapeHtml(receipt.id)}" inputmode="decimal" value="${adjustAbs ? (adjustAbs / 100).toFixed(2) : ""}" placeholder="0.00">
                  <button type="button" class="amount-sign-toggle" data-folder-sign="${escapeHtml(receipt.id)}" aria-label="Toggle add or subtract">${adjustSign < 0 ? "−" : "+"}</button>
                </span>
              </label>`}
            <p class="adjust-note" data-folder-adjust-note="${escapeHtml(receipt.id)}">${escapeHtml(receiptAdjustmentNote(receipt))}</p>
            <div class="folder-receipt-subtotal">
              <span>Subtotal to that receipt</span>
              <strong data-folder-subtotal="${escapeHtml(receipt.id)}">${money(effective)}</strong>
            </div>
          </div>
        </article>`;
    }));
    return `${rows.join("")}
      <div class="receipt-total">
        <span>${job.receipts.length} receipt${job.receipts.length === 1 ? "" : "s"} added together</span>
        <strong data-folder-parts-total>${money(receiptTotal(job))}</strong>
      </div>`;
  }

  function clockHistoryMarkup(job) {
    const labels = {
      clock_in: "Clocked in",
      break_start: "Paused for break",
      break_end: "Resumed work",
      clock_out: "Clocked out"
    };
    const events = [...(job.eventHistory || [])]
      .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)));
    if (!events.length) return `<p class="history-empty">No clock events yet.</p>`;
    return `
      <ol class="clock-history">
        ${events.map((event) => `
          <li>
            <span class="history-dot" aria-hidden="true"></span>
            <span>
              <strong>${escapeHtml(labels[event.action] || event.action)}</strong>
              <small>${calendarDate(event.occurredAt)} · ${clockTime(event.occurredAt)}</small>
            </span>
          </li>`).join("")}
      </ol>`;
  }

  async function renderJob() {
    const job = findJob(selectedJobId);
    if (!job) {
      showBoard();
      return;
    }
    const workSeconds = billableSeconds(job);
    const breakSeconds = elapsedSeconds(job, "break");
    const timedSeconds = elapsedSeconds(job, "work");
    const adjustment = hoursMinutes(manualWorkSeconds(job));
    const receipts = await receiptMarkup(job);
    const locked = job.status === "invoiced";
    const draft = invoiceDraft(job);

    jobView.innerHTML = `
      <div class="job-hero">
        <button class="back-button" id="backButton" type="button">← All jobs</button>
        <p class="eyebrow">${escapeHtml(job.id)}</p>
        <h1>${escapeHtml(vehicleName(job) || "Vehicle")} <em>work order.</em></h1>
        <p>${escapeHtml(job.customerName)} · ${escapeHtml(job.vehiclePlate || "No plate recorded")}</p>
        <div class="job-hero-meta">
          <span class="status-pill ${escapeHtml(job.status)}">${escapeHtml(STATUS_COPY[job.status])}</span>
          <span>Opened ${calendarDate(job.createdAt)}</span>
          <span>${money(job.laborRateCents)}/hour</span>
        </div>
      </div>

      <div class="detail-layout">
        <div class="detail-column">
          <article class="content-card">
            <div class="card-heading">
              <div>
                <p class="eyebrow">Job timer</p>
                <h2>${job.status === "on_break" ? "Break in progress" : job.status === "draft" ? "Ready to begin" : "Work ledger"}</h2>
              </div>
              <span class="status-pill ${escapeHtml(job.status)}">${escapeHtml(STATUS_COPY[job.status])}</span>
            </div>
            <div class="timer-face">
              <span>Billable work time</span>
              <strong id="liveWorkTimer">${duration(workSeconds)}</strong>
            </div>
            <div class="timer-summary">
              <div><span class="detail-label">Clocked in</span><strong>${clockTime(job.startedAt)}</strong></div>
              <div><span class="detail-label">Break time</span><strong id="liveBreakTimer">${duration(breakSeconds)}</strong></div>
            </div>
            <div class="timer-buttons">${timerControls(job)}</div>
            <div class="time-edit">
              <div class="time-edit-heading">
                <span class="detail-label">Billable hours on the invoice</span>
                <strong id="billableSummary">${duration(workSeconds)}</strong>
              </div>
              <p class="time-edit-note">Timer ${duration(timedSeconds)}${manualWorkSeconds(job) ? ` · added ${adjustment.hours}h ${adjustment.minutes}m` : ""} · timer labor ${money(draft.timedLaborCents)}</p>
              ${locked ? "" : `
                <div class="time-edit-fields">
                  <label class="field">
                    <span>Hours</span>
                    <input id="manualHoursInput" inputmode="numeric" value="${adjustment.hours}">
                  </label>
                  <label class="field">
                    <span>Minutes</span>
                    <input id="manualMinutesInput" inputmode="numeric" value="${adjustment.minutes}">
                  </label>
                </div>
                <div class="save-row time-edit-actions">
                  <button class="button button-quiet" id="setManualTimeButton" type="button">Set added time</button>
                  <button class="button button-quiet" id="addManualTimeButton" type="button">Add to total</button>
                </div>
                <div class="labor-cash">
                  <p class="detail-label">Labor charge</p>
                  <label class="field">
                    <span>${requiredStar("Hourly rate")}</span>
                    <span class="money-input"><b>$</b><input id="laborRateInput" inputmode="decimal" value="${(Number(job.laborRateCents || 0) / 100).toFixed(2)}" placeholder="60.00"></span>
                  </label>
                  <p class="time-edit-note">Timer labor from hours × rate: <strong id="timedLaborLive">${money(draft.timedLaborCents)}</strong></p>
                  <label class="field">
                    <span>Adjust amount</span>
                    <span class="money-input draft-amount-input">
                      <b>$</b>
                      <input id="laborAdjustInput" inputmode="decimal" value="${laborAdjustMagnitude(job) ? (laborAdjustMagnitude(job) / 100).toFixed(2) : ""}" placeholder="0.00">
                      <button type="button" class="amount-sign-toggle" id="laborAdjustSign" aria-label="Toggle add or subtract">${laborAdjustSignValue(job) < 0 ? "−" : "+"}</button>
                    </span>
                  </label>
                  <p class="adjust-note" id="laborAdjustNote">${escapeHtml(laborAdjustmentNote(job, draft))}</p>
                  <label class="field">
                    <span>Difficulty level</span>
                    <select id="difficultySelect">
                      ${["Standard", "Easy", "Moderate", "Hard", "Expert"].map((level) => `
                        <option value="${level}" ${String(job.difficultyLevel || "Standard") === level ? "selected" : ""}>${level}</option>`).join("")}
                    </select>
                  </label>
                  <div class="labor-total-row">
                    <span>Labor total</span>
                    <strong id="laborTotalLive">${money(draft.laborCents)}</strong>
                  </div>
                  <div class="save-row time-edit-actions">
                    <button class="button button-quiet" id="saveLaborButton" type="button">Save labor</button>
                  </div>
                </div>`}
            </div>
            <div class="history-panel">
              <p class="eyebrow">Permanent audit trail</p>
              <h3>Clock history</h3>
              ${clockHistoryMarkup(job)}
            </div>
          </article>

          <article class="content-card">
            <div class="card-heading">
              <div>
                <p class="eyebrow">Approved scope</p>
                <h2>Agreed work</h2>
              </div>
            </div>
            <p class="work-copy">${escapeHtml(job.agreedWork)}</p>
          </article>

          <article class="content-card">
            <div class="card-heading">
              <div>
                <p class="eyebrow">Agreed parts list</p>
                <h2>Materials</h2>
                <p>Checklist of what is needed for the job. Prices come from receipts later.</p>
              </div>
            </div>
            ${materialsMarkup(job, locked)}
          </article>

          <article class="content-card">
            <div class="card-heading">
              <div>
                <p class="eyebrow">Professional notes</p>
                <h2>Mechanic's suggestions</h2>
                <p>Your opinion and recommended next steps print on the invoice.</p>
              </div>
            </div>
            <textarea class="suggestions" id="suggestionsInput" ${locked ? "disabled" : ""} placeholder="Example: Front brake pads are nearing replacement thickness. Recheck within 3,000 miles.">${escapeHtml(job.suggestions || "")}</textarea>
            ${locked ? "" : `<div class="save-row"><button class="button button-quiet" id="saveSuggestionsButton" type="button">Save suggestions</button></div>`}
          </article>
        </div>

        <aside class="detail-column">
          <article class="content-card">
            <div class="card-heading">
              <div>
                <p class="eyebrow">Job files</p>
                <h2>Receipt folder</h2>
                <p>${job.receipts.length} receipt${job.receipts.length === 1 ? "" : "s"} saved with this cloud job.</p>
              </div>
              <button class="button button-quiet" id="addReceiptButton" type="button" ${locked ? "disabled" : ""}>+ Receipt</button>
            </div>
            <div class="receipt-list">${receipts}</div>
            ${locked ? `
              <p class="time-edit-note">${job.receiptReview ? "Receipt folder saved." : "Receipt folder not saved yet."}</p>
            ` : `
              <div class="save-row">
                <button class="button button-gold" id="saveReceiptFolderButton" type="button">Save receipt folder</button>
              </div>
              <p class="time-edit-note">Saves vendor, receipt parts, receipt amount, and +/- adjust for every receipt. Stars (*) are required before Clock out & invoice. Edits also auto-save.</p>
            `}
          </article>

          ${job.status !== "invoiced" ? `
            <article class="content-card invoice-card">
              <div class="card-heading">
                <div>
                  <p class="eyebrow">Invoice at capture</p>
                  <h2>${job.status === "completed" ? "Ready to bill" : "Running invoice"}</h2>
                  <p>Receipt photos roll into parts the moment you file them. Clock out files the invoice so you can share it for payment.</p>
                </div>
              </div>
              <div class="invoice-meta">
                <span>Labor · ${money(draft.laborCents)}</span>
                <span>Parts · ${money(draft.materialsCents)}</span>
                <span>${job.receipts.length} receipt${job.receipts.length === 1 ? "" : "s"}</span>
              </div>
              <div class="invoice-total"><span>Total so far</span><strong>${money(draft.totalCents)}</strong></div>
              ${job.status === "completed" ? `<button class="button button-gold" id="createInvoiceButton" type="button">Create & share invoice</button>` : ""}
            </article>` : ""}

          ${invoiceMarkup(job)}
        </aside>
      </div>

      <section class="clock-out-zone">
        <div>
          <p class="eyebrow">Bottom of work order</p>
          <h3>${job.status === "completed" || job.status === "invoiced" ? "Job clock is closed." : "Finished with the vehicle?"}</h3>
          <p>${job.status === "on_break" ? "End the current break before clocking out." : job.status === "draft" ? "Clock in first so the invoice receives an accurate labor total." : "Clocking out closes the timer and files the invoice in the same step so you can get paid."}</p>
        </div>
        <button class="button button-red" id="clockOutButton" type="button" ${job.status === "in_progress" ? "" : "disabled"}>Clock out & invoice</button>
      </section>`;

    bindJobEvents(job);
    updateLiveTimer();
  }

  function bindJobEvents(job) {
    $("backButton").addEventListener("click", showBoard);
    document.querySelectorAll("[data-timer-action]").forEach((button) => {
      button.addEventListener("click", () => timerAction(job, button.dataset.timerAction));
    });

    const clockOutButton = $("clockOutButton");
    if (clockOutButton) {
      clockOutButton.addEventListener("click", () => {
        if ($("laborRateInput")) applyLaborFromForm(job);
        if (job.receipts.length) readFolderReceiptInputs(job);
        const blocked = jobReadyForInvoice(job);
        if (blocked) {
          notify(blocked, true);
          return;
        }
        timerAction(job, "clock_out");
      });
    }

    const addReceiptButton = $("addReceiptButton");
    if (addReceiptButton) addReceiptButton.addEventListener("click", () => openReceiptDialog(job.id));

    document.querySelectorAll("[data-receipt-id]").forEach((button) => {
      button.addEventListener("click", () => viewReceipt(button.dataset.receiptId));
    });

    const saveSuggestionsButton = $("saveSuggestionsButton");
    if (saveSuggestionsButton) {
      saveSuggestionsButton.addEventListener("click", () => {
        job.suggestions = $("suggestionsInput").value.trim();
        queueJobSync(job);
        notify("Mechanic's suggestions saved.");
      });
    }

    function readManualEntry() {
      const hours = Number.parseInt($("manualHoursInput")?.value ?? "", 10);
      const minutes = Number.parseInt($("manualMinutesInput")?.value ?? "", 10);
      const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 0;
      const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
      return safeHours * 3600 + safeMinutes * 60;
    }

    function applyManualSeconds(seconds, message) {
      job.manualWorkSeconds = Math.max(0, Math.round(seconds));
      if (job.invoice) job.invoice = invoiceDraft(job);
      queueJobSync(job);
      renderJob();
      notify(message);
    }

    const setManualTimeButton = $("setManualTimeButton");
    if (setManualTimeButton) {
      setManualTimeButton.addEventListener("click", () => {
        const entered = readManualEntry();
        const summary = hoursMinutes(entered);
        applyManualSeconds(entered, `Added time set to ${summary.hours}h ${summary.minutes}m.`);
      });
    }

    const addManualTimeButton = $("addManualTimeButton");
    if (addManualTimeButton) {
      addManualTimeButton.addEventListener("click", () => {
        const entered = readManualEntry();
        if (!entered) {
          notify("Enter hours or minutes before adding time.", true);
          return;
        }
        const total = manualWorkSeconds(job) + entered;
        const summary = hoursMinutes(total);
        applyManualSeconds(total, `Added time now ${summary.hours}h ${summary.minutes}m.`);
      });
    }

    const jobMaterialRows = $("jobMaterialRows");
    if (jobMaterialRows) {
      jobMaterialRows.querySelectorAll("[data-remove-material]").forEach((button) => {
        button.addEventListener("click", () => {
          const row = button.closest(".material-row");
          if (!row) return;
          if (jobMaterialRows.children.length === 1) {
            const input = row.querySelector('[name="jobMaterialDescription"]');
            if (input) input.value = "";
            row.dataset.materialId = uid();
          } else {
            row.remove();
          }
        });
      });
    }

    const addJobMaterialButton = $("addJobMaterialButton");
    if (addJobMaterialButton && jobMaterialRows) {
      addJobMaterialButton.addEventListener("click", () => {
        const row = document.createElement("div");
        row.className = "material-row";
        row.dataset.materialId = uid();
        row.innerHTML = `
          <label class="field">
            <span>Material</span>
            <input name="jobMaterialDescription" autocomplete="off" value="" placeholder="Alternator">
          </label>
          <button class="icon-button" type="button" data-remove-material aria-label="Remove material">×</button>`;
        row.querySelector("[data-remove-material]").addEventListener("click", () => {
          if (jobMaterialRows.children.length === 1) {
            const input = row.querySelector('[name="jobMaterialDescription"]');
            if (input) input.value = "";
            row.dataset.materialId = uid();
          } else {
            row.remove();
          }
        });
        jobMaterialRows.appendChild(row);
        row.querySelector("input")?.focus();
      });
    }

    const saveMaterialsButton = $("saveMaterialsButton");
    if (saveMaterialsButton && jobMaterialRows) {
      saveMaterialsButton.addEventListener("click", () => {
        job.materials = [...jobMaterialRows.querySelectorAll(".material-row")]
          .map((row) => ({
            id: row.dataset.materialId || uid(),
            description: row.querySelector('[name="jobMaterialDescription"]')?.value.trim() || ""
          }))
          .filter((item) => item.description);
        queueJobSync(job);
        renderJob();
        notify("Materials list saved.");
      });
    }

    const reviewInput = $("receiptReviewInput");
    if (reviewInput && !reviewInput.disabled) {
      reviewInput.addEventListener("change", () => {
        job.receiptReview = reviewInput.checked;
        queueJobSync(job);
        renderJob();
        notify(job.receiptReview ? "Receipt folder approved." : "Receipt review reopened.");
      });
    }

    const saveReceiptFolderButton = $("saveReceiptFolderButton");
    if (saveReceiptFolderButton) {
      saveReceiptFolderButton.addEventListener("click", () => {
        readFolderReceiptInputs(job);
        const blocked = jobReadyForInvoice(job);
        if (blocked && job.receipts.length) {
          notify(blocked, true);
        }
        job.receiptReview = !jobReadyForInvoice(job);
        job.receiptFolderSavedAt = new Date().toISOString();
        if (job.invoice) job.invoice = invoiceDraft(job);
        queueJobSync(job);
        renderJob();
        notify(`Receipt folder saved · parts ${money(receiptTotal(job))}.`);
      });
    }

    function liveLaborTotal() {
      const rateCents = parseCents($("laborRateInput")?.value);
      const timed = Math.round((billableSeconds(job) / 3600) * rateCents);
      const magnitude = parseCents($("laborAdjustInput")?.value);
      const sign = ($("laborAdjustSign")?.textContent || "+").includes("−") || ($("laborAdjustSign")?.textContent || "").includes("-") ? -1 : 1;
      const total = Math.max(0, timed + sign * magnitude);
      const timedLive = $("timedLaborLive");
      const laborLive = $("laborTotalLive");
      const note = $("laborAdjustNote");
      if (timedLive) timedLive.textContent = money(timed);
      if (laborLive) laborLive.textContent = money(total);
      if (note) {
        note.textContent = magnitude
          ? `Adjusted by ${sign < 0 ? "−" : "+"}${money(magnitude)} · original ${money(timed)} → new ${money(total)}`
          : "No labor adjustment.";
      }
      scheduleLaborAutoSave();
    }

    function applyLaborFromForm(targetJob) {
      const rateCents = parseCents($("laborRateInput")?.value);
      if (rateCents) targetJob.laborRateCents = rateCents;
      targetJob.laborAmountCents = null;
      const magnitude = parseCents($("laborAdjustInput")?.value);
      const sign = ($("laborAdjustSign")?.textContent || "+").includes("−") || ($("laborAdjustSign")?.textContent || "").includes("-") ? -1 : 1;
      targetJob.laborAdjustmentCents = sign * magnitude;
      targetJob.laborAdjustSign = sign;
      if ($("difficultySelect")) targetJob.difficultyLevel = $("difficultySelect").value || "Standard";
      if (targetJob.invoice) targetJob.invoice = invoiceDraft(targetJob);
    }

    let laborAutoSaveTimer = null;
    function scheduleLaborAutoSave() {
      clearTimeout(laborAutoSaveTimer);
      laborAutoSaveTimer = setTimeout(() => {
        applyLaborFromForm(job);
        queueJobSync(job);
      }, 500);
    }

    const saveLaborButton = $("saveLaborButton");
    if (saveLaborButton) {
      saveLaborButton.addEventListener("click", () => {
        const rateCents = parseCents($("laborRateInput")?.value);
        if (!rateCents) {
          notify("Enter an hourly rate greater than zero.", true);
          return;
        }
        applyLaborFromForm(job);
        queueJobSync(job);
        renderJob();
        notify(`Labor saved · ${money(invoiceDraft(job).laborCents)} · ${job.difficultyLevel}.`);
      });
    }

    const laborAdjustSign = $("laborAdjustSign");
    if (laborAdjustSign) {
      laborAdjustSign.addEventListener("click", () => {
        const next = (laborAdjustSign.textContent || "+").includes("−") || (laborAdjustSign.textContent || "").includes("-") ? "+" : "−";
        laborAdjustSign.textContent = next;
        liveLaborTotal();
      });
    }
    ["laborRateInput", "laborAdjustInput"].forEach((id) => {
      const input = $(id);
      if (input) input.addEventListener("input", liveLaborTotal);
    });
    const difficultySelect = $("difficultySelect");
    if (difficultySelect) difficultySelect.addEventListener("change", scheduleLaborAutoSave);

    function readFolderReceiptInputs(targetJob) {
      targetJob.receipts.forEach((receipt) => {
        const vendorInput = document.querySelector(`[data-folder-vendor="${receipt.id}"]`);
        const partsInput = document.querySelector(`[data-folder-parts="${receipt.id}"]`);
        const amountInput = document.querySelector(`[data-folder-amount="${receipt.id}"]`);
        const adjustInput = document.querySelector(`[data-folder-adjust="${receipt.id}"]`);
        const signButton = document.querySelector(`[data-folder-sign="${receipt.id}"]`);
        if (vendorInput) receipt.vendor = canonicalizeVendor(vendorInput.value, targetJob);
        if (partsInput) {
          receipt.receiptParts = partsInput.value.trim();
          receipt.orderId = receipt.receiptParts;
        }
        if (amountInput) receipt.amountCents = parseCents(amountInput.value);
        if (adjustInput) receipt.adjustCents = parseCents(adjustInput.value);
        if (signButton) {
          receipt.adjustSign = (signButton.textContent || "+").includes("−") || (signButton.textContent || "").includes("-") ? -1 : 1;
        }
        if (receipt.adjustSign < 0) {
          receipt.addCents = 0;
          receipt.subtractCents = receipt.adjustCents;
        } else {
          receipt.addCents = receipt.adjustCents;
          receipt.subtractCents = 0;
        }
      });
    }

    let folderAutoSaveTimer = null;
    function scheduleFolderAutoSave() {
      clearTimeout(folderAutoSaveTimer);
      folderAutoSaveTimer = setTimeout(() => {
        readFolderReceiptInputs(job);
        job.receiptReview = !jobReadyForInvoice(job);
        job.receiptFolderSavedAt = new Date().toISOString();
        if (job.invoice) job.invoice = invoiceDraft(job);
        queueJobSync(job);
      }, 500);
    }

    function refreshFolderSubtotal(id) {
      const amount = parseCents(document.querySelector(`[data-folder-amount="${id}"]`)?.value);
      const adjust = parseCents(document.querySelector(`[data-folder-adjust="${id}"]`)?.value);
      const signButton = document.querySelector(`[data-folder-sign="${id}"]`);
      const sign = (signButton?.textContent || "+").includes("−") || (signButton?.textContent || "").includes("-") ? -1 : 1;
      const effective = amount + sign * adjust;
      const label = document.querySelector(`[data-folder-subtotal="${id}"]`);
      if (label) label.textContent = money(effective);
      const note = document.querySelector(`[data-folder-adjust-note="${id}"]`);
      if (note) {
        note.textContent = adjust
          ? `Adjusted by ${sign < 0 ? "−" : "+"}${money(adjust)} · original ${money(amount)} → new ${money(effective)}`
          : "No receipt adjustment.";
      }
      const parts = document.querySelector("[data-folder-parts-total]");
      if (parts) {
        let total = 0;
        job.receipts.forEach((receipt) => {
          const receiptAmount = parseCents(document.querySelector(`[data-folder-amount="${receipt.id}"]`)?.value);
          const receiptAdjust = parseCents(document.querySelector(`[data-folder-adjust="${receipt.id}"]`)?.value);
          const receiptSignButton = document.querySelector(`[data-folder-sign="${receipt.id}"]`);
          const receiptSign = (receiptSignButton?.textContent || "+").includes("−") || (receiptSignButton?.textContent || "").includes("-") ? -1 : 1;
          total += receiptAmount + receiptSign * receiptAdjust;
        });
        parts.textContent = money(total);
      }
      scheduleFolderAutoSave();
    }

    document.querySelectorAll("[data-folder-amount], [data-folder-adjust], [data-folder-vendor], [data-folder-parts]").forEach((input) => {
      input.addEventListener("input", () => {
        const id = input.dataset.folderAmount || input.dataset.folderAdjust || input.dataset.folderVendor || input.dataset.folderParts;
        if (input.dataset.folderAmount || input.dataset.folderAdjust) refreshFolderSubtotal(id);
        else scheduleFolderAutoSave();
      });
    });
    document.querySelectorAll("[data-folder-sign]").forEach((button) => {
      button.addEventListener("click", () => {
        const next = (button.textContent || "+").includes("−") || (button.textContent || "").includes("-") ? "+" : "−";
        button.textContent = next;
        refreshFolderSubtotal(button.dataset.folderSign);
      });
    });

    const createInvoiceButton = $("createInvoiceButton");
    if (createInvoiceButton) {
      createInvoiceButton.addEventListener("click", async () => {
        createInvoice(job);
        await shareInvoice(job);
      });
    }

    const downloadInvoiceButton = $("downloadInvoiceButton");
    if (downloadInvoiceButton) downloadInvoiceButton.addEventListener("click", () => downloadInvoice(job));

    const shareInvoiceButton = $("shareInvoiceButton");
    if (shareInvoiceButton) shareInvoiceButton.addEventListener("click", () => shareInvoice(job));

    const emailInvoiceButton = $("emailInvoiceButton");
    if (emailInvoiceButton) emailInvoiceButton.addEventListener("click", () => prepareEmail(job));
  }

  function timerAction(job, action) {
    const now = new Date().toISOString();
    const openEntry = job.timeEntries.find((entry) => !entry.endedAt);

    if (action === "clock_in" && job.status === "draft") {
      job.status = "in_progress";
      job.startedAt = now;
      job.timeEntries.push({ id: uid(), kind: "work", startedAt: now, endedAt: null });
      notify("Clocked in. Billable time is running.");
    } else if (action === "break_start" && job.status === "in_progress") {
      if (openEntry) openEntry.endedAt = now;
      job.timeEntries.push({ id: uid(), kind: "break", startedAt: now, endedAt: null });
      job.status = "on_break";
      notify("Break started. Billable time is paused.");
    } else if (action === "break_end" && job.status === "on_break") {
      if (openEntry) openEntry.endedAt = now;
      job.timeEntries.push({ id: uid(), kind: "work", startedAt: now, endedAt: null });
      job.status = "in_progress";
      notify("Break ended. Billable time resumed.");
    } else if (action === "clock_out" && job.status === "in_progress") {
      if (!window.confirm("Clock out, close the timer, and file the invoice for payment?")) return;
      if (openEntry) openEntry.endedAt = now;
      job.status = "completed";
      job.endedAt = now;
      job.eventHistory = Array.isArray(job.eventHistory) ? job.eventHistory : [];
      job.eventHistory.push({ id: uid(), action, occurredAt: now });
      const invoice = upsertInvoice(job);
      renderJob();
      notify(`${invoice.invoiceNumber} filed — share it to get paid.`);
      return;
    } else {
      notify("That timer action is not available right now.", true);
      return;
    }

    job.eventHistory = Array.isArray(job.eventHistory) ? job.eventHistory : [];
    job.eventHistory.push({ id: uid(), action, occurredAt: now });
    queueJobSync(job);
    renderJob();
  }

  function updateLiveTimer() {
    const job = selectedJobId ? findJob(selectedJobId) : null;
    if (!job) return;
    const work = $("liveWorkTimer");
    const rest = $("liveBreakTimer");
    const summary = $("billableSummary");
    if (work) work.textContent = duration(billableSeconds(job));
    if (rest) rest.textContent = duration(elapsedSeconds(job, "break"));
    if (summary) summary.textContent = duration(billableSeconds(job));
  }

  function addMaterialRow(values = {}) {
    const row = document.createElement("div");
    row.className = "material-row";
    row.dataset.materialId = values.id || uid();
    row.innerHTML = `
      <label class="field">
        <span>Material</span>
        <input name="materialDescription" autocomplete="off" value="" placeholder="Alternator">
      </label>
      <button class="icon-button" type="button" aria-label="Remove material">×</button>`;
    const input = row.querySelector('[name="materialDescription"]');
    if (values.description) input.value = String(values.description);
    row.querySelector("button").addEventListener("click", () => {
      if (materialRows.children.length === 1) {
        input.value = "";
        row.dataset.materialId = uid();
      } else {
        row.remove();
      }
    });
    materialRows.appendChild(row);
  }

  function openJobDialog() {
    jobForm.reset();
    materialRows.innerHTML = "";
    addMaterialRow();
    $("jobFormError").classList.add("hidden");
    jobDialog.showModal();
  }

  async function openNewJob() {
    if (await ensureCloudSync()) openJobDialog();
  }

  function closeJobDialog() {
    jobDialog.close();
  }

  jobForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(jobForm);
    const laborRateCents = parseCents(data.get("laborRate"));
    if (!laborRateCents) {
      $("jobFormError").textContent = "Enter a labor rate greater than zero.";
      $("jobFormError").classList.remove("hidden");
      return;
    }

    const materials = [...materialRows.querySelectorAll(".material-row")]
      .map((row) => {
        const description = row.querySelector('[name="materialDescription"]').value.trim();
        return {
          id: row.dataset.materialId || uid(),
          description
        };
      })
      .filter((item) => item.description);

    const job = {
      id: jobId(),
      customerName: String(data.get("customerName") || "").trim(),
      customerEmail: String(data.get("customerEmail") || "").trim(),
      vehicleYear: String(data.get("vehicleYear") || "").trim(),
      vehicleMake: String(data.get("vehicleMake") || "").trim(),
      vehicleModel: String(data.get("vehicleModel") || "").trim(),
      vehiclePlate: String(data.get("vehiclePlate") || "").trim().toUpperCase(),
      laborRateCents,
      agreedWork: String(data.get("agreedWork") || "").trim(),
      materials,
      suggestions: "",
      status: "draft",
      receiptReview: false,
      laborAmountCents: null,
      laborAdjustmentCents: 0,
      difficultyLevel: "Standard",
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      timeEntries: [],
      eventHistory: [],
      receipts: [],
      invoice: null,
      updatedAt: new Date().toISOString()
    };

    state.jobs.push(job);
    queueJobSync(job);
    closeJobDialog();
    notify(`${job.id} created.`);
    openJob(job.id);
  });

  function draftTotalCents() {
    return draftReceipts.reduce((total, receipt) => total + Number(receipt.amountCents || 0), 0);
  }

  function vendorKey(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function knownVendorSpellings(job) {
    const names = [];
    for (const receipt of job?.receipts || []) {
      const name = String(receipt.vendor || "").trim();
      if (name) names.push(name);
    }
    for (const draft of draftReceipts) {
      const name = String(draft.vendor || "").trim();
      if (name) names.push(name);
    }
    return names;
  }

  function cleanVendorName(value) {
    return String(value || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\s+(?:store\s*)?#?\d[\w-]*$/i, "")
      .replace(/\s+#\d[\w-]*$/g, "")
      .replace(/\s+\d{2,}[\w-]*$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function canonicalizeVendor(candidate, job = findJob(receiptJobId)) {
    const cleaned = cleanVendorName(candidate);
    if (!cleaned) return "";
    const key = vendorKey(cleaned);
    if (!key) return cleaned;
    const known = knownVendorSpellings(job).map(cleanVendorName);
    for (const name of known) {
      if (vendorKey(name) === key) return name;
    }
    for (const name of known) {
      const prior = vendorKey(name);
      if (!prior || prior[0] !== key[0]) continue;
      if (key.startsWith(prior) || prior.startsWith(key)) return name;
    }
    return cleaned;
  }

  function draftAmountAbs(receipt) {
    return Math.abs(Number(receipt.amountCents || 0));
  }

  function draftAmountSign(receipt) {
    return Number(receipt.amountCents || 0) < 0 ? -1 : 1;
  }

  function clearDraftReceipts() {
    draftReceipts.forEach((receipt) => {
      if (receipt.previewUrl) URL.revokeObjectURL(receipt.previewUrl);
    });
    draftReceipts = [];
  }

  function clearReceiptCapture() {
    const fileInput = $("receiptFile");
    if (fileInput) fileInput.value = "";
    receiptForm.querySelector('[name="vendor"]').value = "";
    const orderInput = receiptForm.querySelector('[name="receiptParts"]') || receiptForm.querySelector('[name="orderId"]');
    if (orderInput) orderInput.value = "";
    receiptForm.querySelector('[name="amount"]').value = "";
    $("receiptFormError").classList.add("hidden");
    $("receiptFormError").textContent = "";
    $("receiptPreview").classList.add("hidden");
    $("receiptPreview").innerHTML = "";
    setScanStatus("");
    clearSuggestRow();
    pendingScan = { vendor: "", amount: 0, orderId: "", receiptParts: "" };
    pendingCapture = null;
    if (receiptPreviewUrl) URL.revokeObjectURL(receiptPreviewUrl);
    receiptPreviewUrl = null;
  }

  function receiptErrorMessage(error) {
    const message = String(error?.message || error || "").trim();
    if (/quota|storage|space/i.test(message)) {
      return "Phone storage for this app is full. Free space or clear old jobs, then retry.";
    }
    if (message) return message;
    return "The receipt could not be saved. Retry the photo.";
  }

  function updateFileAllButton() {
    const button = $("fileAllReceiptsButton");
    if (!button) return;
    button.disabled = !draftReceipts.length;
    button.textContent = draftReceipts.length
      ? `File All Receipts (${draftReceipts.length})`
      : "File All Receipts";
  }

  async function refreshFiledReceiptsPanel() {
    const job = findJob(receiptJobId);
    const draftList = $("draftReceiptsList");
    const filedList = $("filedReceiptsList");
    const total = $("filedReceiptsTotal");
    if (!draftList || !filedList || !total) return;

    if (!draftReceipts.length) {
      draftList.innerHTML = `<p class="receipt-empty">No receipts staged yet. Take a photo or choose from your library, confirm vendor and amount, then Add a Receipt.</p>`;
    } else {
      draftList.innerHTML = draftReceipts.map((receipt) => `
        <article class="filed-receipt-card" data-draft-card="${escapeHtml(receipt.id)}">
          <button type="button" class="filed-receipt-photo" data-draft-preview="${escapeHtml(receipt.id)}">
            <span class="receipt-thumb"><img src="${escapeHtml(receipt.previewUrl)}" alt=""></span>
          </button>
          <div class="filed-receipt-body">
            <div class="filed-receipt-chips">
              ${receipt.suggestedVendor ? `<button type="button" class="receipt-suggest-chip" data-draft-apply="${escapeHtml(receipt.id)}" data-field="vendor" data-value="${escapeHtml(receipt.suggestedVendor)}">Saw ${escapeHtml(receipt.suggestedVendor)}</button>` : ""}
              ${receipt.suggestedAmountCents ? `<button type="button" class="receipt-suggest-chip" data-draft-apply="${escapeHtml(receipt.id)}" data-field="amount" data-value="${(receipt.suggestedAmountCents / 100).toFixed(2)}">Suggested ${money(receipt.suggestedAmountCents)}</button>` : ""}
            </div>
            <label class="field">
              <span>Vendor</span>
              <input data-draft-vendor="${escapeHtml(receipt.id)}" value="${escapeHtml(receipt.vendor || "")}" placeholder="Vendor">
            </label>
            <label class="field">
              <span>Receipt amount</span>
              <span class="money-input draft-amount-input">
                <b>$</b>
                <input data-draft-amount="${escapeHtml(receipt.id)}" inputmode="decimal" value="${draftAmountAbs(receipt) ? (draftAmountAbs(receipt) / 100).toFixed(2) : ""}" placeholder="0.00">
                <button type="button" class="amount-sign-toggle" data-draft-sign="${escapeHtml(receipt.id)}" aria-label="Toggle add or subtract">${draftAmountSign(receipt) < 0 ? "−" : "+"}</button>
              </span>
            </label>
            <button type="button" class="button button-quiet" data-remove-draft="${escapeHtml(receipt.id)}">Remove</button>
          </div>
        </article>`).join("");
      draftList.querySelectorAll("[data-remove-draft]").forEach((button) => {
        button.addEventListener("click", () => {
          const id = button.dataset.removeDraft;
          const index = draftReceipts.findIndex((item) => item.id === id);
          if (index === -1) return;
          const [removed] = draftReceipts.splice(index, 1);
          if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
          refreshFiledReceiptsPanel();
        });
      });
      draftList.querySelectorAll("[data-draft-apply]").forEach((button) => {
        button.addEventListener("click", () => {
          const draft = draftReceipts.find((item) => item.id === button.dataset.draftApply);
          if (!draft) return;
          if (button.dataset.field === "vendor") {
            draft.vendor = canonicalizeVendor(button.dataset.value || "");
            const input = draftList.querySelector(`[data-draft-vendor="${draft.id}"]`);
            if (input) input.value = draft.vendor;
          } else {
            const sign = draftAmountSign(draft);
            draft.amountCents = sign * parseCents(button.dataset.value);
            const input = draftList.querySelector(`[data-draft-amount="${draft.id}"]`);
            if (input) input.value = (draftAmountAbs(draft) / 100).toFixed(2);
          }
          button.classList.add("is-applied");
          refreshFiledReceiptsPanel();
        });
      });
      draftList.querySelectorAll("[data-draft-vendor]").forEach((input) => {
        input.addEventListener("change", () => {
          const draft = draftReceipts.find((item) => item.id === input.dataset.draftVendor);
          if (!draft) return;
          draft.vendor = canonicalizeVendor(input.value.trim());
          input.value = draft.vendor;
        });
      });
      draftList.querySelectorAll("[data-draft-amount]").forEach((input) => {
        input.addEventListener("change", () => {
          const draft = draftReceipts.find((item) => item.id === input.dataset.draftAmount);
          if (!draft) return;
          draft.amountCents = draftAmountSign(draft) * parseCents(input.value);
          refreshFiledReceiptsPanel();
        });
      });
      draftList.querySelectorAll("[data-draft-sign]").forEach((button) => {
        button.addEventListener("click", () => {
          const draft = draftReceipts.find((item) => item.id === button.dataset.draftSign);
          if (!draft || !draft.amountCents) {
            if (draft) draft.amountCents = draft.amountCents ? -Math.abs(draft.amountCents) : 0;
            refreshFiledReceiptsPanel();
            return;
          }
          draft.amountCents = -draft.amountCents;
          refreshFiledReceiptsPanel();
        });
      });
    }

    if (!job || !job.receipts.length) {
      filedList.innerHTML = `<p class="receipt-empty">None filed on this job yet.</p>`;
    } else {
      const rows = await Promise.all([...job.receipts].reverse().map(async (receipt) => {
        const stored = await getReceiptForJob(job.id, receipt.id);
        let image = `<span class="receipt-thumb">▧</span>`;
        if (stored?.blob) {
          const url = URL.createObjectURL(stored.blob);
          activeObjectUrls.push(url);
          image = `<span class="receipt-thumb"><img src="${escapeHtml(url)}" alt=""></span>`;
        }
        return `
          <article class="filed-receipt-card">
            <button type="button" class="filed-receipt-photo" data-receipt-id="${escapeHtml(receipt.id)}">${image}</button>
            <div class="filed-receipt-body">
              <strong>${escapeHtml(receipt.vendor || receipt.filename)}</strong>
              <small>${calendarDate(receipt.createdAt)} · ${money(receipt.amountCents)}</small>
            </div>
          </article>`;
      }));
      filedList.innerHTML = rows.join("");
      filedList.querySelectorAll("[data-receipt-id]").forEach((button) => {
        button.addEventListener("click", () => viewReceipt(button.dataset.receiptId));
      });
    }

    const filedCents = job ? receiptTotal(job) : 0;
    const stagedCents = draftTotalCents();
    const combined = filedCents + stagedCents;
    const stagedNote = draftReceipts.length
      ? ` · ${draftReceipts.length} ready to file (${money(stagedCents)})`
      : "";
    total.innerHTML = `
      <span>${(job?.receipts.length || 0)} filed${stagedNote}</span>
      <strong>${money(combined)}</strong>`;
    updateFileAllButton();
  }

  function openReceiptDialog(jobIdValue) {
    receiptJobId = jobIdValue;
    clearReceiptCapture();
    refreshFiledReceiptsPanel();
    receiptDialog.showModal();
  }

  function closeReceiptDialog() {
    if (draftReceipts.length) {
      const proceed = window.confirm(`Discard ${draftReceipts.length} receipt${draftReceipts.length === 1 ? "" : "s"} that are ready to file?`);
      if (!proceed) return;
      clearDraftReceipts();
    }
    clearReceiptCapture();
    receiptDialog.close();
    if (selectedJobId) renderJob();
  }

  function setScanStatus(message, tone = "") {
    const element = $("receiptScanStatus");
    if (!element) return;
    element.textContent = message || "";
    element.className = `receipt-scan-status${tone ? ` ${tone}` : ""}${message ? "" : " hidden"}`;
  }

  function clearSuggestRow() {
    const row = $("receiptSuggestRow");
    if (!row) return;
    row.innerHTML = "";
    row.classList.add("hidden");
  }

  function renderSuggestRow(vendor, amount, receiptParts = "") {
    const row = $("receiptSuggestRow");
    if (!row) return;
    const chips = [];
    if (vendor) {
      chips.push(`<button type="button" class="receipt-suggest-chip" data-apply="vendor" data-value="${escapeHtml(vendor)}">Vendor · ${escapeHtml(vendor)}</button>`);
    }
    if (receiptParts) {
      chips.push(`<button type="button" class="receipt-suggest-chip" data-apply="receiptParts" data-value="${escapeHtml(receiptParts)}">Receipt parts · ${escapeHtml(receiptParts)}</button>`);
    }
    if (amount) {
      chips.push(`<button type="button" class="receipt-suggest-chip" data-apply="amount" data-value="${amount.toFixed(2)}">Subtotal · $${amount.toFixed(2)}</button>`);
    }
    if (!chips.length) {
      clearSuggestRow();
      return;
    }
    row.innerHTML = `<p class="receipt-suggest-label">Tap if correct — or type it below</p>${chips.join("")}`;
    row.classList.remove("hidden");
    row.querySelectorAll("[data-apply]").forEach((button) => {
      button.addEventListener("click", () => {
        const field = button.dataset.apply;
        const value = button.dataset.value || "";
        if (field === "vendor") {
          const input = receiptForm.querySelector('[name="vendor"]');
          if (input) input.value = canonicalizeVendor(value);
        } else if (field === "receiptParts" || field === "orderId") {
          const input = receiptForm.querySelector('[name="receiptParts"]') || receiptForm.querySelector('[name="orderId"]');
          if (input) input.value = value;
        } else if (field === "amount") {
          const input = receiptForm.querySelector('[name="amount"]');
          if (input) input.value = value;
        }
        button.classList.add("is-applied");
      });
    });
  }

  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${OCR_BASE}/tesseract.min.js`;
      script.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error("Scanner failed to load.")));
      script.onerror = () => reject(new Error("Scanner failed to load."));
      document.head.appendChild(script);
    });
  }

  function ocrWorker() {
    if (!ocrWorkerPromise) {
      ocrWorkerPromise = (async () => {
        const Tesseract = await loadTesseract();
        return Tesseract.createWorker("eng", 1, {
          workerPath: `${OCR_BASE}/worker.min.js`,
          corePath: `${OCR_BASE}/`,
          langPath: `${OCR_BASE}/`,
          gzip: true
        });
      })().catch((error) => {
        ocrWorkerPromise = null;
        throw error;
      });
    }
    return ocrWorkerPromise;
  }

  function readVendor(lines) {
    const skip = /(receipt|invoice|order|customer|copy|thank|welcome|store\s*#|tel|phone|www\.|http|\d{3}[-.\s]\d{3}[-.\s]\d{4})/i;
    for (const line of lines.slice(0, 8)) {
      const cleaned = line.replace(/[^A-Za-z0-9&'’.\- ]/g, " ").replace(/\s+/g, " ").trim();
      const letters = cleaned.replace(/[^A-Za-z]/g, "");
      if (letters.length < 3 || skip.test(cleaned)) continue;
      return cleanVendorName(
        cleaned
          .split(" ")
          .map((word) => (word.length > 2 && word === word.toUpperCase()
            ? word.charAt(0) + word.slice(1).toLowerCase()
            : word))
          .join(" ")
          .slice(0, 48)
      );
    }
    return "";
  }

  function readOrderId(lines) {
    const patterns = [
      /\b(?:order|ord|invoice|inv|ticket|trans(?:action)?|auth)\s*(?:id|no\.?|number|#)?\s*[:#]?\s*([A-Z0-9-]{4,})\b/i,
      /\b(?:order|ticket)\s+#?\s*([A-Z0-9-]{4,})\b/i,
      /#\s*([A-Z0-9]{5,})\b/
    ];
    for (const pattern of patterns) {
      for (const line of lines) {
        const match = pattern.exec(line);
        if (match?.[1]) return String(match[1]).trim().slice(0, 32);
      }
    }
    return "";
  }

  function amountsIn(line) {
    return [...line.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)[.,](\d{2})(?!\d)/g)]
      .map((match) => Number.parseFloat(`${match[1].replace(/,/g, "")}.${match[2]}`))
      .filter((value) => Number.isFinite(value));
  }

  function readAmountFromLines(lines, patterns) {
    for (const pattern of patterns) {
      for (const line of [...lines].reverse()) {
        if (!pattern.test(line)) continue;
        const values = amountsIn(line);
        if (values.length) return values[values.length - 1];
      }
    }
    return 0;
  }

  function readSubtotal(lines) {
    const subtotal = readAmountFromLines(lines, [
      /\bsub[\s-]*total\b/i,
      /\bmerchandise\s*total\b/i
    ]);
    if (subtotal) return subtotal;
    const total = readAmountFromLines(lines, [
      /\b(grand\s*total|amount\s*due|balance\s*due|total\s*due)\b/i,
      /\btotal\b/i
    ]);
    if (total) return total;
    const all = lines.flatMap(amountsIn);
    return all.length ? Math.max(...all) : 0;
  }

  async function readReceiptScan(blob) {
    const worker = await ocrWorker();
    const { data } = await worker.recognize(blob);
    const lines = String(data?.text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return { vendor: "", amount: 0, orderId: "", receiptParts: "", lines: [] };
    const orderId = readOrderId(lines);
    return {
      vendor: readVendor(lines),
      amount: readSubtotal(lines),
      orderId,
      receiptParts: orderId,
      lines
    };
  }

  async function scanReceipt(file) {
    setScanStatus("Reading receipt…");
    clearSuggestRow();
    pendingScan = { vendor: "", amount: 0, orderId: "", receiptParts: "" };
    try {
      const { vendor, amount, orderId, receiptParts, lines } = await readReceiptScan(file);
      if (!lines.length) {
        setScanStatus("Could not read this photo. Type the vendor and amount.", "warn");
        return;
      }
      const matchedVendor = canonicalizeVendor(vendor);
      const parts = receiptParts || orderId || "";
      pendingScan = { vendor: matchedVendor, amount, orderId: parts, receiptParts: parts };
      renderSuggestRow(matchedVendor, amount, parts);
      if (matchedVendor || amount || parts) {
        setScanStatus("Tap a suggestion if it looks right, or enter vendor and amount yourself.");
      } else {
        setScanStatus("Could not read this photo. Type the vendor and amount.", "warn");
      }
    } catch {
      setScanStatus("Scanner unavailable. Type the vendor and amount.", "warn");
    }
  }

  async function stageCompressedReceipt(blob, filename, scan = {}) {
    const vendor = canonicalizeVendor(scan.vendor || "");
    const amount = Number(scan.amount || 0);
    const receiptParts = String(scan.receiptParts || scan.orderId || "").trim();
    const previewUrl = URL.createObjectURL(blob);
    draftReceipts.push({
      id: uid(),
      blob,
      previewUrl,
      filename: filename || `receipt-${Date.now()}.jpg`,
      vendor,
      orderId: receiptParts,
      receiptParts,
      amountCents: amount ? Math.round(amount * 100) : 0,
      addCents: 0,
      subtractCents: 0,
      adjustCents: 0,
      adjustSign: 1,
      suggestedVendor: vendor,
      suggestedAmountCents: amount ? Math.round(amount * 100) : 0,
      createdAt: new Date().toISOString()
    });
  }

  async function ingestReceiptFiles(fileList, { autoStage = false } = {}) {
    const files = [...fileList].filter((file) => file && file.type.startsWith("image/"));
    if (!files.length) throw new Error("No receipt images were selected.");

    if (!autoStage) {
      const file = files[0];
      setScanStatus("Saving photo…");
      clearSuggestRow();
      pendingScan = { vendor: "", amount: 0, orderId: "", receiptParts: "" };
      const vendorInput = receiptForm.querySelector('[name="vendor"]');
      const orderInput = receiptForm.querySelector('[name="receiptParts"]') || receiptForm.querySelector('[name="orderId"]');
      const amountInput = receiptForm.querySelector('[name="amount"]');
      if (vendorInput) vendorInput.value = "";
      if (orderInput) orderInput.value = "";
      if (amountInput) amountInput.value = "";
      const blob = await compressReceipt(file);
      if (receiptPreviewUrl) URL.revokeObjectURL(receiptPreviewUrl);
      receiptPreviewUrl = URL.createObjectURL(blob);
      pendingCapture = { blob, filename: file.name || `receipt-${Date.now()}.jpg` };
      $("receiptPreview").innerHTML = `<img src="${escapeHtml(receiptPreviewUrl)}" alt="Receipt preview">`;
      $("receiptPreview").classList.remove("hidden");
      scanReceipt(blob);
      return { staged: 0, reviewed: 1 };
    }

    setScanStatus(`Reading ${files.length} receipt${files.length === 1 ? "" : "s"} from library…`);
    let staged = 0;
    for (const [index, file] of files.entries()) {
      setScanStatus(`Reading library receipt ${index + 1} of ${files.length}…`);
      const blob = await compressReceipt(file);
      let scan = { vendor: "", amount: 0 };
      try {
        scan = await readReceiptScan(blob);
      } catch {
        scan = { vendor: "", amount: 0 };
      }
      await stageCompressedReceipt(blob, file.name || `receipt-${Date.now()}.jpg`, scan);
      staged += 1;
    }
    clearReceiptCapture();
    await refreshFiledReceiptsPanel();
    setScanStatus(`Staged ${staged} receipt${staged === 1 ? "" : "s"} from library. Check vendor/amount, then File All Receipts.`);
    notify(`${staged} receipt${staged === 1 ? "" : "s"} ready to file. Tap any suggested chip if needed, then File All.`);
    return { staged, reviewed: 0 };
  }

  $("receiptFile").addEventListener("change", async () => {
    const file = $("receiptFile").files?.[0];
    if (!file) return;
    $("receiptFormError").classList.add("hidden");
    $("receiptFormError").textContent = "";
    try {
      await ingestReceiptFiles([file], { autoStage: false });
    } catch (error) {
      pendingCapture = null;
      setScanStatus(receiptErrorMessage(error), "warn");
      $("receiptFormError").textContent = receiptErrorMessage(error);
      $("receiptFormError").classList.remove("hidden");
    }
  });

  $("receiptLibrary").addEventListener("change", async () => {
    const files = $("receiptLibrary").files;
    if (!files?.length) return;
    $("receiptFormError").classList.add("hidden");
    $("receiptFormError").textContent = "";
    try {
      await ingestReceiptFiles(files, { autoStage: true });
    } catch (error) {
      setScanStatus(receiptErrorMessage(error), "warn");
      $("receiptFormError").textContent = receiptErrorMessage(error);
      $("receiptFormError").classList.remove("hidden");
    } finally {
      $("receiptLibrary").value = "";
    }
  });

  receiptForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const job = findJob(receiptJobId);
    if (!job) {
      $("receiptFormError").textContent = "Open a job before adding receipts.";
      $("receiptFormError").classList.remove("hidden");
      return;
    }
    if (!pendingCapture?.blob) {
      $("receiptFormError").textContent = "Take a photo or choose from your library first.";
      $("receiptFormError").classList.remove("hidden");
      return;
    }

    const data = new FormData(receiptForm);
    const vendor = canonicalizeVendor(String(data.get("vendor") || "").trim());
    const orderId = String(data.get("receiptParts") || data.get("orderId") || pendingScan.receiptParts || pendingScan.orderId || "").trim();
    const amountCents = parseCents(data.get("amount"));
    if (!vendor || !amountCents) {
      $("receiptFormError").textContent = "Fill both vendor and receipt amount before adding.";
      $("receiptFormError").classList.remove("hidden");
      return;
    }

    const previewUrl = URL.createObjectURL(pendingCapture.blob);
    draftReceipts.push({
      id: uid(),
      blob: pendingCapture.blob,
      previewUrl,
      filename: pendingCapture.filename,
      vendor,
      orderId,
      receiptParts: orderId,
      amountCents,
      addCents: 0,
      subtractCents: 0,
      adjustCents: 0,
      adjustSign: 1,
      suggestedVendor: pendingScan.vendor || "",
      suggestedAmountCents: pendingScan.amount ? Math.round(pendingScan.amount * 100) : 0,
      createdAt: new Date().toISOString()
    });
    clearReceiptCapture();
    await refreshFiledReceiptsPanel();
    notify(`Receipt added. ${draftReceipts.length} ready — take another, choose more, or File All Receipts.`);
  });

  $("fileAllReceiptsButton").addEventListener("click", async () => {
    const job = findJob(receiptJobId);
    const button = $("fileAllReceiptsButton");
    if (!job || !draftReceipts.length) return;

    const incomplete = draftReceipts.find((draft) => !String(draft.vendor || "").trim() || !Number(draft.amountCents || 0));
    if (incomplete) {
      $("receiptFormError").textContent = "Every ready receipt needs a vendor and amount before File All.";
      $("receiptFormError").classList.remove("hidden");
      return;
    }

    button.disabled = true;
    $("receiptFormError").classList.add("hidden");
    try {
      const staged = [...draftReceipts];
      const pending = pendingReceipts();
      for (const draft of staged) {
        await storeReceipt(draft.id, draft.blob);
        job.receipts.push({
          id: draft.id,
          filename: draft.filename,
          vendor: draft.vendor,
          orderId: draft.receiptParts || draft.orderId || "",
          receiptParts: draft.receiptParts || draft.orderId || "",
          amountCents: draft.amountCents,
          addCents: Number(draft.addCents || 0),
          subtractCents: Number(draft.subtractCents || 0),
          adjustCents: Number(draft.adjustCents || 0),
          adjustSign: Number(draft.adjustSign) < 0 ? -1 : 1,
          suggestedVendor: draft.suggestedVendor,
          suggestedAmountCents: draft.suggestedAmountCents,
          createdAt: draft.createdAt
        });
        if (!pending.some((item) => item.jobId === job.id && item.receiptId === draft.id)) {
          pending.push({ jobId: job.id, receiptId: draft.id });
        }
      }
      writeStorageArray(PENDING_RECEIPTS_STORAGE, pending);
      clearDraftReceipts();
      job.updatedAt = new Date().toISOString();
      job.receiptReview = false;
      if (job.status === "completed" || job.status === "invoiced") {
        job.receiptReview = true;
        job.invoice = invoiceDraft(job);
        job.status = "invoiced";
      }
      const pendingJobs = new Set(pendingJobIds());
      pendingJobs.add(job.id);
      writeStorageArray(PENDING_JOBS_STORAGE, [...pendingJobs]);
      try {
        saveState();
      } catch (error) {
        $("receiptFormError").textContent = `${receiptErrorMessage(error)} Receipt images are stored on-device — free browser site data, then tap Sync now.`;
        $("receiptFormError").classList.remove("hidden");
      }
      void flushSyncQueue().catch(() => {});
      await refreshFiledReceiptsPanel();
      await renderJob();
      notify(`${staged.length} receipt${staged.length === 1 ? "" : "s"} filed · parts ${money(receiptTotal(job))}.`);
    } catch (error) {
      $("receiptFormError").textContent = receiptErrorMessage(error);
      $("receiptFormError").classList.remove("hidden");
      updateFileAllButton();
    }
  });

  async function viewReceipt(id) {
    const job = selectedJobId ? findJob(selectedJobId) : null;
    const stored = job ? await getReceiptForJob(job.id, id) : null;
    if (!stored?.blob) {
      notify("That receipt image is not available locally or in cloud storage.", true);
      return;
    }
    const url = URL.createObjectURL(stored.blob);
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function createInvoice(job) {
    if (job.status !== "completed" && job.status !== "invoiced") {
      notify("Clock out first so labor is closed, then the invoice files automatically.", true);
      return;
    }
    const invoice = upsertInvoice(job);
    renderJob();
    notify(`${invoice.invoiceNumber} ready — share it to get paid.`);
  }

  async function invoiceHtml(job) {
    const receiptPages = [];
    for (const [index, receipt] of job.receipts.entries()) {
      const stored = await getReceiptForJob(job.id, receipt.id);
      if (!stored?.blob) continue;
      const dataUrl = await fileToDataUrl(stored.blob);
      receiptPages.push(`
        <section class="receipt-page">
          <p class="eyebrow">Receipt ${index + 1} of ${job.receipts.length}</p>
          <h2>${escapeHtml(receipt.vendor || receipt.filename)}${(receipt.receiptParts || receipt.orderId) ? ` · ${escapeHtml(receipt.receiptParts || receipt.orderId)}` : ""} · ${money(receiptEffectiveCents(receipt))}</h2>
          <img src="${dataUrl}" alt="Receipt ${index + 1}">
        </section>`);
    }

    const agreedMaterialsMarkup = (job.materials || []).length
      ? `<div class="box"><span class="eyebrow">Agreed materials</span><ul>${job.materials.map((item) => `<li>${escapeHtml(item.description || "")}</li>`).join("")}</ul></div>`
      : "";

    const receiptRowsMarkup = (job.receipts || [])
      .filter((receipt) => receiptEffectiveCents(receipt) !== 0)
      .map((receipt) => `
      <tr>
        <td>Receipt — ${escapeHtml(receipt.vendor || receipt.filename)}${(receipt.receiptParts || receipt.orderId) ? ` (${escapeHtml(receipt.receiptParts || receipt.orderId)})` : ""}</td>
        <td>1</td>
        <td>${money(receiptEffectiveCents(receipt))}</td>
        <td>${money(receiptEffectiveCents(receipt))}</td>
      </tr>`).join("");

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(job.invoice.invoiceNumber)} — Gold Mobile Mechanic</title>
  <style>
    *{box-sizing:border-box}body{margin:0;padding:40px;color:#171717;font:14px/1.5 Arial,sans-serif}
    main,.receipt-page{max-width:820px;margin:0 auto}header{display:flex;justify-content:space-between;border-bottom:4px solid #b48624;padding-bottom:24px}
    h1{margin:0;font-size:30px;letter-spacing:-.04em}h2{margin:8px 0 20px}.gold{color:#9d7219}.eyebrow{text-transform:uppercase;letter-spacing:.16em;font-weight:700;color:#7a5a18}
    .meta{text-align:right}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:30px 0}.box{border:1px solid #ddd;border-radius:10px;padding:16px}
    table{width:100%;border-collapse:collapse;margin:24px 0}th,td{border-bottom:1px solid #ddd;padding:12px 8px;text-align:left}th:last-child,td:last-child{text-align:right}
    .totals{margin-left:auto;width:320px}.totals div{display:flex;justify-content:space-between;padding:8px 0}.total{border-top:2px solid #171717;font-size:20px;font-weight:800}
    .notes{margin-top:36px;white-space:pre-wrap}.receipt-page{break-before:page;padding-top:24px}.receipt-page img{max-width:100%;max-height:930px;object-fit:contain;border:1px solid #ddd}
    ul{margin:8px 0 0;padding-left:18px}@media(max-width:600px){body{padding:22px}.grid{grid-template-columns:1fr}.totals{width:100%}}@media print{body{padding:0}}
  </style>
</head>
<body>
  <main>
    <header>
      <div><p class="eyebrow">Gold Mobile Mechanic</p><h1>Service <span class="gold">Invoice</span></h1></div>
      <div class="meta"><strong>${escapeHtml(job.invoice.invoiceNumber)}</strong><br>${calendarDate(job.invoice.createdAt)}<br>Job ${escapeHtml(job.id)}</div>
    </header>
    <div class="grid">
      <div class="box"><span class="eyebrow">Bill to</span><br><strong>${escapeHtml(job.customerName)}</strong><br>${escapeHtml(job.customerEmail || "Email not provided")}</div>
      <div class="box"><span class="eyebrow">Vehicle</span><br><strong>${escapeHtml(vehicleName(job))}</strong><br>${escapeHtml(job.vehiclePlate || "No plate recorded")}</div>
    </div>
    <div class="box"><span class="eyebrow">Agreed work</span><p>${escapeHtml(job.agreedWork)}</p></div>
    ${agreedMaterialsMarkup}
    <table>
      <thead><tr><th>Service / part</th><th>Qty / hours</th><th>Rate</th><th>Amount</th></tr></thead>
      <tbody>
        <tr><td>Mobile mechanic labor</td><td>${(job.invoice.workSeconds / 3600).toFixed(2)} hrs</td><td>${money(job.laborRateCents)}/hr</td><td>${money(job.invoice.laborCents)}</td></tr>
        ${receiptRowsMarkup}
      </tbody>
    </table>
    <div class="totals">
      <div><span>Labor</span><strong>${money(job.invoice.laborCents)}</strong></div>
      <div><span>Parts (from receipts)</span><strong>${money(job.invoice.materialsCents)}</strong></div>
      <div class="total"><span>Total</span><span>${money(job.invoice.totalCents)}</span></div>
    </div>
    <div class="notes box"><span class="eyebrow">Mechanic's suggestions</span><p>${escapeHtml(job.suggestions || "No additional suggestions.")}</p></div>
    <div class="notes box"><span class="eyebrow">Difficulty</span><p>${escapeHtml(job.difficultyLevel || "Standard")}</p></div>
    <p>${job.receipts.length} receipt${job.receipts.length === 1 ? "" : "s"} filed with this invoice.</p>
  </main>
  ${receiptPages.join("")}
</body>
</html>`;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function invoiceFile(job) {
    const html = await invoiceHtml(job);
    return new File([html], `${job.invoice.invoiceNumber}.html`, { type: "text/html" });
  }

  async function downloadInvoice(job) {
    const file = await invoiceFile(job);
    downloadBlob(file, file.name);
    notify("Invoice downloaded. Open it to print or save as PDF.");
  }

  async function shareInvoice(job) {
    const file = await invoiceFile(job);
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      try {
        await navigator.share({
          title: job.invoice.invoiceNumber,
          text: `Gold Mobile Mechanic invoice for ${vehicleName(job)}`,
          files: [file]
        });
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    downloadBlob(file, file.name);
    notify("Invoice downloaded because file sharing is unavailable here.");
  }

  function prepareEmail(job) {
    const recipient = job.customerEmail || "";
    const subject = `${job.invoice.invoiceNumber} — Gold Mobile Mechanic`;
    const body = [
      `Hi ${job.customerName},`,
      "",
      `Your Gold Mobile Mechanic invoice for ${vehicleName(job)} is ready.`,
      `Invoice total: ${money(job.invoice.totalCents)}`,
      "",
      "Attach the downloaded invoice file to this message before sending.",
      "",
      "Thank you,"
    ].join("\n");
    window.location.href = `mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  async function backupData() {
    try {
      const receiptFiles = [];
      for (const job of state.jobs) {
        for (const receipt of job.receipts) {
          const stored = await getReceiptForJob(job.id, receipt.id);
          if (stored?.blob) {
            receiptFiles.push({ id: receipt.id, dataUrl: await fileToDataUrl(stored.blob) });
          }
        }
      }
      const payload = {
        app: "Gold Mobile Mechanic",
        version: 1,
        exportedAt: new Date().toISOString(),
        state,
        receiptFiles
      };
      const filename = `gold-mobile-mechanic-backup-${new Date().toISOString().slice(0, 10)}.json`;
      downloadBlob(new Blob([JSON.stringify(payload)], { type: "application/json" }), filename);
      notify("Full phone backup downloaded.");
    } catch {
      notify("The backup could not be created.", true);
    }
  }

  async function restoreData(file) {
    try {
      const payload = JSON.parse(await file.text());
      if (payload?.app !== "Gold Mobile Mechanic" || payload?.version !== 1 || !Array.isArray(payload?.state?.jobs)) {
        throw new Error("Invalid backup");
      }
      if (!window.confirm("Replace all Gold Mobile Mechanic jobs and receipts currently saved on this phone?")) return;
      await clearReceiptStore();
      for (const receipt of payload.receiptFiles || []) {
        if (receipt.id && receipt.dataUrl) await storeReceipt(receipt.id, dataUrlToBlob(receipt.dataUrl));
      }
      state = {
        ...payload.state,
        jobs: payload.state.jobs.map(normalizeJob)
      };
      saveState();
      state.jobs.forEach((job) => {
        queueJobSync(job);
        job.receipts.forEach((receipt) => queueReceiptSync(job.id, receipt.id));
      });
      showBoard();
      notify("Backup restored and queued for cloud sync.");
    } catch {
      notify("That file is not a valid Gold Mobile Mechanic backup.", true);
    } finally {
      $("restoreInput").value = "";
    }
  }

  $("homeButton").addEventListener("click", showBoard);
  $("newJobButton").addEventListener("click", openNewJob);
  $("syncButton").addEventListener("click", async () => {
    if (await ensureCloudSync()) {
      renderBoard();
      notify("Cloud ledger is up to date.");
    }
  });
  $("closeJobDialog").addEventListener("click", closeJobDialog);
  $("cancelJobButton").addEventListener("click", closeJobDialog);
  $("addMaterialButton").addEventListener("click", () => addMaterialRow());
  $("closeReceiptDialog").addEventListener("click", closeReceiptDialog);
  $("cancelReceiptButton").addEventListener("click", closeReceiptDialog);
  $("backupButton").addEventListener("click", backupData);
  $("restoreButton").addEventListener("click", () => $("restoreInput").click());
  $("restoreInput").addEventListener("change", () => {
    const file = $("restoreInput").files?.[0];
    if (file) restoreData(file);
  });

  [jobDialog, receiptDialog].forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  window.addEventListener("hashchange", () => {
    const match = /^#job\/(.+)$/.exec(window.location.hash);
    if (match) openJob(decodeURIComponent(match[1]));
    else if (selectedJobId) showBoard();
  });

  window.addEventListener("online", () => {
    void syncFromCloud()
      .then(() => {
        if (selectedJobId) renderJob();
        else renderBoard();
      })
      .catch(() => setSyncStatus("error"));
  });
  window.addEventListener("offline", () => setSyncStatus(syncKey() ? "pending" : "disconnected"));

  setInterval(updateLiveTimer, 1000);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }

  async function initialize() {
    saveState();
    if (syncKey()) {
      try {
        await syncFromCloud();
        if (pairedFromUrl) notify("This phone is connected to the permanent cloud ledger.");
      } catch (error) {
        setSyncStatus("error");
        notify(error instanceof Error ? error.message : "Cloud sync could not connect.", true);
      }
    }
    const initialMatch = /^#job\/(.+)$/.exec(window.location.hash);
    if (initialMatch && findJob(decodeURIComponent(initialMatch[1]))) {
      await openJob(decodeURIComponent(initialMatch[1]));
    } else {
      renderBoard();
    }
  }

  void initialize();
})();
