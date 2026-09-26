(() => {
  "use strict";

  const STORAGE_KEY = "gold-mobile-mechanic-phone-v1";
  const NEW_JOB_DRAFT_STORAGE = "gold-mobile-mechanic-new-job-draft-v1";
  const RECEIPT_DB = "gold-mobile-mechanic-receipts";
  const RECEIPT_STORE = "receipts";
  // Where customers look their own invoices up. Same GitHub Pages site.
  const PORTAL_URL = `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, "")}portal.html`;
  const OCR_BASE = "./vendor/tesseract";
  const PENDING_JOBS_STORAGE = "gold-mobile-mechanic-pending-jobs-v1";
  const PENDING_RECEIPTS_STORAGE = "gold-mobile-mechanic-pending-receipts-v1";
  const PENDING_DELETES_STORAGE = "gold-mobile-mechanic-pending-deletes-v1";
  const PENDING_EVENTS_STORAGE = "gold-mobile-mechanic-pending-events-v1";
  const STATUS_COPY = {
    draft: "Ready",
    in_progress: "On the clock",
    clocked_out: "Off the clock",
    completed: "Finished job",
    invoiced: "Invoice ready",
    archived: "Archived"
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
  let syncQueueDirty = false;
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

  /**
   * Rebuilds a clock ledger for a job saved before events were recorded. Breaks
   * no longer exist, so a job only ever has billable work spans: each one opens
   * with a clock in and closes with a clock out. A legacy break entry is simply
   * the gap between two of those spans and needs no event of its own.
   */
  function derivedEventHistory(job) {
    const events = [];
    [...(job.timeEntries || [])]
      .filter((entry) => entry.kind === "work" && !entry.voided)
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
      .forEach((entry) => {
        events.push({
          id: `legacy-${job.id}-clock_in-${entry.startedAt}`,
          action: "clock_in",
          occurredAt: entry.startedAt
        });
        if (entry.endedAt) {
          events.push({
            id: `legacy-${job.id}-clock_out-${entry.endedAt}`,
            action: "clock_out",
            occurredAt: entry.endedAt
          });
        }
      });
    return events;
  }

  function normalizeJob(job) {
    const normalized = {
      ...job,
      archived: Boolean(job.archived),
      materials: Array.isArray(job.materials) ? job.materials : [],
      timeEntries: (Array.isArray(job.timeEntries) ? job.timeEntries : []).map((entry) => ({
        ...entry,
        // Every span has to be addressable to be correctable on the time sheet.
        // A row with no id is dropped by the cloud merge anyway, so stamping
        // one here can only rescue a local row, never duplicate a synced one.
        id: entry?.id || uid(),
        // A tombstone has to survive every reload and every merge, so it is
        // normalized like any other field rather than left undefined.
        voided: Boolean(entry && entry.voided)
      })),
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
      manualWorkSign: Number(job.manualWorkSign) < 0 ? -1 : 1,
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
      customerPhone: String(job.customerPhone || ""),
      // "on_break" cannot occur any more; a job saved mid-break reopens simply
      // off the clock, which is exactly what a break was.
      status: job.status === "on_break" ? "clocked_out" : job.status,
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

  async function ensureCloudSync() {
    try {
      await syncFromCloud();
      return true;
    } catch (error) {
      setSyncStatus("error");
      notify(error instanceof Error ? error.message : "Cloud sync could not connect.", true);
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
    if (
      pendingJobIds().length ||
      pendingReceipts().length ||
      pendingDeletes().length ||
      pendingClockEvents().length
    ) {
      setSyncStatus(navigator.onLine ? "syncing" : "pending");
    }
  }

  /**
   * Folds a job from the cloud into local state IN PLACE. Swapping in a fresh
   * object instead would silently orphan every reference already handed out —
   * the rendered job page holds the record its buttons mutate, so after one
   * background sync a clock in or clock out would update a detached copy,
   * toast "Clocked out", and persist nothing.
   */
  function replaceJob(job) {
    const normalized = normalizeJob(job);
    const existing = state.jobs.find((item) => item.id === normalized.id);
    if (!existing) {
      state.jobs.push(normalized);
      return;
    }
    for (const key of Object.keys(existing)) {
      if (!(key in normalized)) delete existing[key];
    }
    Object.assign(existing, normalized);
  }

  function pendingDeletes() {
    return arrayFromStorage(PENDING_DELETES_STORAGE).filter((id) => typeof id === "string");
  }

  function pendingClockEvents() {
    return arrayFromStorage(PENDING_EVENTS_STORAGE).filter(
      (item) => item && typeof item.jobId === "string" && typeof item.id === "string"
    );
  }

  function dropPendingClockEvent(eventId) {
    writeStorageArray(
      PENDING_EVENTS_STORAGE,
      pendingClockEvents().filter((item) => item.id !== eventId)
    );
  }

  // Ids currently being posted. The tap fires its own request straight away and
  // the queue flush runs moments later off the same job sync, so without this
  // every clock event would go up twice.
  const clockEventsInFlight = new Set();

  async function pushClockEvent(item) {
    if (clockEventsInFlight.has(item.id)) return;
    clockEventsInFlight.add(item.id);
    try {
      await cloudFetch(`/api/jobs/${encodeURIComponent(item.jobId)}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, action: item.action, occurredAt: item.occurredAt })
      });
      dropPendingClockEvent(item.id);
    } finally {
      clockEventsInFlight.delete(item.id);
    }
  }

  /**
   * Records one clock in or clock out and makes it durable on its own, right
   * now. The event is written to this phone's storage and posted to its own
   * cloud endpoint the instant it is tapped — it is never left waiting on a
   * profile save, a batch, or the whole-job sync that follows it. If the post
   * fails the event stays queued and is replayed on the next flush, so the
   * timestamp is the moment of the tap either way.
   */
  function logClockEvent(job, action, occurredAt) {
    const event = { id: uid(), action, occurredAt };
    job.eventHistory = Array.isArray(job.eventHistory) ? job.eventHistory : [];
    job.eventHistory.push(event);

    const queued = pendingClockEvents();
    queued.push({ ...event, jobId: job.id });
    writeStorageArray(PENDING_EVENTS_STORAGE, queued);
    // Straight to disk before anything else can throw or navigate away.
    saveState();

    // Deliberately not routed through flushSyncQueue: that call holds a single
    // in-flight lock behind receipt uploads and job bodies, and a clock event
    // must not wait in line behind a 900 KB photo.
    if (navigator.onLine) {
      void pushClockEvent({ ...event, jobId: job.id }).catch(() => {
        // Still queued; flushSyncQueue will replay it.
      });
    }
    return event;
  }

  function queueJobDelete(jobIdValue) {
    const pending = new Set(pendingDeletes());
    pending.add(jobIdValue);
    writeStorageArray(PENDING_DELETES_STORAGE, [...pending]);
    const jobsPending = pendingJobIds().filter((id) => id !== jobIdValue);
    writeStorageArray(PENDING_JOBS_STORAGE, jobsPending);
    const receipts = pendingReceipts().filter((item) => item.jobId !== jobIdValue);
    writeStorageArray(PENDING_RECEIPTS_STORAGE, receipts);
  }

  async function deleteJobEverywhere(jobIdValue) {
    state.jobs = state.jobs.filter((job) => job.id !== jobIdValue);
    queueJobDelete(jobIdValue);
    saveState();
    try {
      if (navigator.onLine) {
        await cloudFetch(`/api/jobs/${encodeURIComponent(jobIdValue)}`, { method: "DELETE" });
        writeStorageArray(PENDING_DELETES_STORAGE, pendingDeletes().filter((id) => id !== jobIdValue));
      }
    } catch {
      // Keep the delete queued for the next successful sync.
    }
    void flushSyncQueue().catch(() => {});
  }

  function queueJobSync(job) {
    job.updatedAt = new Date().toISOString();
    const ids = new Set(pendingJobIds());
    ids.add(job.id);
    writeStorageArray(PENDING_JOBS_STORAGE, [...ids]);
    saveState();
    void flushSyncQueue().catch(() => {});
  }

  function archiveJob(jobIdValue) {
    const job = findJob(jobIdValue);
    if (!job) return;
    job.archived = true;
    queueJobSync(job);
  }

  function unarchiveJob(jobIdValue) {
    const job = findJob(jobIdValue);
    if (!job) return;
    job.archived = false;
    queueJobSync(job);
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

  /**
   * Every call that touches the shop's own records. The Authorization header,
   * the one-time PIN prompt and the retry after a 401 all live in
   * `sync-auth.js`; this wrapper only turns a failure into a sentence.
   *
   * The `GMMAuth` guard is not defensive padding. A phone running a stale
   * service-worker shell can have `app.js` without the newer file beside it,
   * and an app that throws at boot over a missing helper is worse than one
   * that runs and reports that sync is unavailable.
   */
  async function cloudFetch(path, options = {}) {
    if (!window.GMMAuth) throw new Error("This app needs to finish updating. Close it and reopen.");
    const response = await window.GMMAuth.request(path, options);
    if (response.status === 401) {
      throw new Error("This phone isn't paired yet. Enter your PIN to sync.");
    }
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

  /**
   * Drains everything waiting to reach the cloud: deletes, clock events, job
   * bodies, then receipt files.
   *
   * Two things here look fussy and are not. First, the in-flight lock is
   * claimed BEFORE the body is allowed to finish. An empty queue drains
   * without ever hitting an await, so the body used to run start to finish —
   * clearing `syncInFlight` in its own `finally` — before the assignment that
   * installs it had even executed. The assignment then re-installed an
   * already-settled promise and every later flush returned it instantly
   * without doing any work. On a phone that is one line: the first sync at
   * boot has nothing to send, so nothing the mechanic entered afterwards ever
   * uploaded. The job lived only in this phone's storage until Safari evicted
   * it, which is exactly what "I made the customer, clocked in, and it deleted
   * itself" looks like from the driveway.
   *
   * Second, work queued while a pass is already running is retried by that
   * pass rather than dropped. `pendingJobIds()` is read once per pass, so a
   * job saved a moment after the pass started would otherwise sit in the queue
   * with nothing left to trigger it.
   */
  async function flushSyncQueue() {
    if (syncInFlight) {
      syncQueueDirty = true;
      return syncInFlight;
    }
    if (!navigator.onLine) {
      setSyncStatus("pending");
      return;
    }

    const run = (async () => {
      // Yields so the assignment below lands before this body can clear it.
      await Promise.resolve();
      setSyncStatus("syncing");
      try {
        do {
          syncQueueDirty = false;
          let deleteIds = pendingDeletes();
          for (const id of deleteIds) {
            await cloudFetch(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
            deleteIds = deleteIds.filter((value) => value !== id);
            writeStorageArray(PENDING_DELETES_STORAGE, deleteIds);
          }

          // Clock events go before job bodies and receipts: they are the
          // smallest, most time-sensitive writes in the queue.
          for (const item of pendingClockEvents()) {
            await pushClockEvent(item);
          }

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
            // A job the mechanic touched while this request was in the air is
            // newer than the answer coming back. Clock in and clock out are one
            // tap each and can easily land inside that window, so a stale echo
            // must never be allowed to undo them.
            const local = findJob(id);
            const localTime = Date.parse(String(local?.updatedAt || 0));
            const remoteTime = Date.parse(String(payload.job?.updatedAt || 0));
            if (!Number.isFinite(localTime) || !Number.isFinite(remoteTime) || remoteTime >= localTime) {
              replaceJob(payload.job);
            }
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
        } while (syncQueueDirty);
        setSyncStatus("synced");
      } catch (error) {
        setSyncStatus(navigator.onLine ? "error" : "pending");
        throw error;
      } finally {
        syncInFlight = null;
      }
    })();

    syncInFlight = run;
    return run;
  }

  async function syncFromCloud() {
    if (!navigator.onLine) {
      setSyncStatus("pending");
      return;
    }

    setSyncStatus("syncing");
    const response = await cloudFetch("/api/jobs");
    const payload = await response.json();
    const remoteJobs = Array.isArray(payload.jobs) ? payload.jobs.map(normalizeJob) : [];
    const remoteIds = new Set(remoteJobs.map((job) => job.id));
    const pendingIds = new Set(pendingJobIds());
    const deleteIds = new Set(pendingDeletes());

    remoteJobs.forEach((remote) => {
      if (deleteIds.has(remote.id)) return;
      const local = findJob(remote.id);
      if (!local || !pendingIds.has(remote.id)) replaceJob(remote);
    });

    state.jobs.forEach((local) => {
      if (deleteIds.has(local.id)) return;
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
      // A removed session is tombstoned, never spliced out: the cloud merges
      // timeEntries as a union of ids, so a spliced entry comes straight back
      // on the next sync and bills the customer for it again.
      .filter((entry) => entry.kind === kind && !entry.voided)
      .reduce((total, entry) => {
        const start = Date.parse(entry.startedAt);
        const end = entry.endedAt ? Date.parse(entry.endedAt) : now;
        return total + Math.max(0, Math.floor((end - start) / 1000));
      }, 0);
  }

  /** Every session that still counts, oldest first. */
  function workSessions(job) {
    return (job.timeEntries || [])
      .filter((entry) => entry.kind === "work" && !entry.voided)
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  }

  function toDateInputValue(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (part) => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function toTimeInputValue(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (part) => String(part).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /**
   * A phone's date picker and time picker, read together as one local moment.
   * Built field by field rather than by parsing a string, because "2026-09-24
   * 08:00" is read as UTC by some engines and as local time by others — a five
   * or seven hour swing straight onto a customer's invoice.
   */
  function fromDateAndTime(dateValue, timeValue) {
    const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || ""));
    const timeParts = /^(\d{2}):(\d{2})/.exec(String(timeValue || ""));
    if (!dateParts || !timeParts) return null;
    const date = new Date(
      Number(dateParts[1]), Number(dateParts[2]) - 1, Number(dateParts[3]),
      Number(timeParts[1]), Number(timeParts[2]), 0, 0
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function spokenSpan(startIso, endIso) {
    return `${calendarDate(startIso)} · ${clockTime(startIso)} – ${clockTime(endIso)}`;
  }

  function manualWorkSeconds(job) {
    const value = Number(job?.manualWorkSeconds);
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  }

  function manualWorkSignValue(job) {
    return Number(job?.manualWorkSign) < 0 ? -1 : 1;
  }

  function manualWorkSignedSeconds(job) {
    return manualWorkSignValue(job) * manualWorkSeconds(job);
  }

  function billableSeconds(job, now = Date.now()) {
    return Math.max(0, elapsedSeconds(job, "work", now) + manualWorkSignedSeconds(job));
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
      return "Enter the hourly labor rate before Finish Project.";
    }
    for (const receipt of job.receipts || []) {
      if (!String(receipt.vendor || "").trim()) return "Every receipt needs a vendor before Finish Project.";
      if (!String(receipt.receiptParts || receipt.orderId || "").trim()) {
        return "Every receipt needs receipt parts before Finish Project.";
      }
      if (!Number(receipt.amountCents || 0)) return "Every receipt needs a total amount before Finish Project.";
    }
    return "";
  }

  /**
   * Anya's finish check, computed on the phone rather than guessed by the model
   * — the same principle as the Worker overruling `ready`. Returns the boxes
   * that MUST be filled before this can be a real invoice, the ones worth having
   * but not required, the next workflow step, and a plain-English history of
   * this exact job so she can double-check it the way a person would before
   * filing.
   */
  function buildInvoiceReview(job) {
    const has = (value) => String(value ?? "").trim().length > 0;

    const blocking = [];
    if (!has(job.customerName)) blocking.push("the customer's name");
    if (!has(job.vehicleMake)) blocking.push("the vehicle make");
    if (!has(job.vehicleModel)) blocking.push("the vehicle model");
    if (!has(job.agreedWork)) blocking.push("the agreed work the invoice bills against");
    if (!Number(job.laborRateCents || 0)) blocking.push("the hourly labor rate");
    (job.receipts || []).forEach((receipt, index) => {
      const label = `receipt ${index + 1}`;
      if (!has(receipt.vendor)) blocking.push(`${label} is missing its vendor`);
      if (!has(receipt.receiptParts || receipt.orderId)) blocking.push(`${label} is missing its parts`);
      if (!Number(receipt.amountCents || 0)) blocking.push(`${label} is missing its total amount`);
    });

    const recommended = [];
    if (!has(job.customerPhone)) recommended.push("a phone number");
    if (!has(job.customerEmail)) recommended.push("an email to send the invoice to");
    if (!has(job.vehicleYear)) recommended.push("the vehicle year");
    if (!has(job.vehiclePlate)) recommended.push("the license plate");
    if (!has(job.suggestions)) recommended.push("any notes or recommendations to print on the invoice");

    // The workflow step still owed, kept apart from missing data so she doesn't
    // report "clock out" as if it were a blank field.
    let nextStep = "";
    if (job.status === "in_progress") nextStep = "He's still on the clock — Finish Project closes the timer and files it.";
    else if (job.status === "clocked_out") nextStep = "Clocked out — Finish Project files the invoice.";
    else if (job.status === "draft") nextStep = "Not clocked in yet, so there's no billable time on it.";
    else if (job.status === "completed") nextStep = "Timer's closed — Create & share invoice files it.";
    else if (job.status === "invoiced") nextStep = "Already filed. Unsubmit it first to change anything.";

    const draft = invoiceDraft(job);
    return {
      ready: blocking.length === 0,
      blocking,
      recommended,
      nextStep,
      billedMinutes: Math.round((draft.workSeconds || 0) / 60),
      laborRate: job.laborRateCents ? money(job.laborRateCents) : "",
      total: money(draft.totalCents),
      history: summarizeJobHistory(job)
    };
  }

  /** A compact, spoken-friendly log of the clock events on this exact job. */
  function summarizeJobHistory(job) {
    const label = {
      clock_in: "clocked in", clock_out: "clocked out",
      finished: "finished", invoice_reopened: "invoice reopened",
      time_added: "worked time added by hand", time_edited: "worked time corrected by hand",
      time_removed: "worked time removed by hand"
    };
    const parts = (Array.isArray(job.eventHistory) ? job.eventHistory : [])
      .map((event) => {
        const name = label[event.action] || String(event.action || "").replace(/_/g, " ");
        const at = clockTime(event.occurredAt);
        return at ? `${name} ${at}` : name;
      })
      .filter(Boolean);
    return parts.length ? parts.join(", ") : "no clock events recorded yet";
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

  // The customer portal groups a customer's filed invoices under an opaque id
  // that is a hash of their name and phone. The worker computes it in
  // sync-worker/index.ts (customerKey); this is the identical function so the
  // phone can build a customer's own portal link offline, without asking the
  // server for it.
  function portalPhoneDigits(value) {
    const digits = String(value ?? "").replace(/\D/g, "");
    return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  }

  function customerPortalId(job) {
    const normalizedName = String(job.customerName ?? "")
      .trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    let hash = 0x811c9dc5;
    for (const character of `${normalizedName}|${portalPhoneDigits(job.customerPhone)}`) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36).padStart(7, "0");
  }

  // The permanent link to hand one customer: it opens the portal straight to
  // that customer's own filed invoices. Stable as long as their name and phone
  // stay the same — correcting either one after the fact mints a new link.
  function customerPortalLink(job) {
    if (!String(job.customerName || "").trim()) return "";
    return `${PORTAL_URL}#customer/${customerPortalId(job)}`;
  }

  // The exact reverse of the "finish" action. The timer reopens clocked out, the
  // filed invoice is withdrawn (so it leaves the customer portal), and every
  // field unlocks for editing again. Billable time, intervals, receipts, and the
  // clock-history ledger are all left untouched — this only undoes the filing.
  function reopenInvoice(job) {
    if (job.status !== "invoiced") return;
    const now = new Date().toISOString();
    job.status = "clocked_out";
    job.endedAt = null;
    job.invoice = null;
    job.eventHistory = Array.isArray(job.eventHistory) ? job.eventHistory : [];
    job.eventHistory.push({ id: uid(), action: "invoice_reopened", occurredAt: now });
    // A real clock-out event with the current timestamp so the cloud merge
    // resolves this job to "clocked out" no matter whose history it lands beside.
    logClockEvent(job, "clock_out", now);
    queueJobSync(job);
    renderJob();
    notify("Invoice reopened. Fix anything, then Finish Project to file it again.");
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

  let lastAutosaveToastAt = 0;
  function notifyAutoSaved() {
    const now = Date.now();
    if (now - lastAutosaveToastAt < 900) return;
    lastAutosaveToastAt = now;
    notify("Auto saved");
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
    if (local?.blob || !navigator.onLine) return local;
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
    flushOpenJobAutosave = null;
    selectedJobId = null;
    // Unsaved time-sheet rows belong to the job that was open. Carrying them to
    // the next job would offer to bill one customer for another's hours.
    timeSheetDrafts = [];
    window.location.hash = "";
    jobView.classList.add("hidden");
    boardView.classList.remove("hidden");
    revokeObjectUrls();
    renderBoard();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function closeOpenSwipes(exceptRow = null) {
    document.querySelectorAll(".job-swipe.is-open").forEach((row) => {
      if (exceptRow && row === exceptRow) return;
      row.classList.remove("is-open");
      const front = row.querySelector(".job-swipe-front");
      if (front) front.style.transform = "";
    });
  }

  function bindJobSwipe(row) {
    const front = row.querySelector(".job-swipe-front");
    if (!front) return;
    const reveal = 148;
    let startX = 0;
    let startY = 0;
    let currentX = 0;
    let tracking = false;
    let horizontal = null;
    let moved = false;
    let suppressClick = false;

    const setOffset = (x) => {
      currentX = Math.max(-reveal, Math.min(0, x));
      front.style.transform = `translateX(${currentX}px)`;
    };

    const finish = () => {
      if (!tracking) return;
      tracking = false;
      front.style.transition = "";
      if (!moved) {
        if (row.classList.contains("is-open")) {
          row.classList.remove("is-open");
          front.style.transform = "";
          suppressClick = true;
          return;
        }
        suppressClick = true;
        openJob(row.dataset.jobId);
        return;
      }
      if (currentX <= -reveal / 2) {
        row.classList.add("is-open");
        front.style.transform = `translateX(${-reveal}px)`;
      } else {
        row.classList.remove("is-open");
        front.style.transform = "";
      }
      suppressClick = true;
    };

    front.addEventListener(
      "touchstart",
      (event) => {
        if (!event.touches.length) return;
        closeOpenSwipes(row);
        tracking = true;
        horizontal = null;
        moved = false;
        startX = event.touches[0].clientX;
        startY = event.touches[0].clientY;
        currentX = row.classList.contains("is-open") ? -reveal : 0;
        front.style.transition = "none";
      },
      { passive: true }
    );

    front.addEventListener(
      "touchmove",
      (event) => {
        if (!tracking || !event.touches.length) return;
        const dx = event.touches[0].clientX - startX;
        const dy = event.touches[0].clientY - startY;
        if (horizontal === null) {
          if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
          horizontal = Math.abs(dx) > Math.abs(dy);
          if (!horizontal) {
            tracking = false;
            return;
          }
        }
        if (!horizontal) return;
        moved = true;
        event.preventDefault();
        const base = row.classList.contains("is-open") ? -reveal : 0;
        setOffset(base + dx);
      },
      { passive: false }
    );

    front.addEventListener("touchend", finish, { passive: true });
    front.addEventListener("touchcancel", finish, { passive: true });

    front.addEventListener("click", (event) => {
      if (suppressClick) {
        event.preventDefault();
        event.stopPropagation();
        suppressClick = false;
        return;
      }
      if (row.classList.contains("is-open")) {
        event.preventDefault();
        row.classList.remove("is-open");
        front.style.transform = "";
        return;
      }
      openJob(row.dataset.jobId);
    });
  }

  // -------------------------------------------------------------------------
  // Every customer, every job
  //
  // THERE IS NO CUSTOMER TABLE. The live ledger is `jobs(id, data, updated_at)`
  // — one JSON blob per work order — so a customer exists only as a name and a
  // phone number copied onto each job. Nothing below merges, rewrites or
  // deletes a record: the grouping is derived at render time from the jobs
  // already loaded. That is deliberate. It means a wrong grouping is a
  // cosmetic bug that a reload re-derives, never a lost invoice, and it is why
  // this needed no D1 write and no union-merge safety dance.
  //
  // Thomas's rule, verbatim: "if the name is somewhat similar and/or the phone
  // number is the same, put those invoices together because it is obviously
  // the same person."
  // -------------------------------------------------------------------------

  /** Digits only, last ten — so (406) 555-0147 and 4065550147 are one number. */
  function phoneKey(value) {
    const digits = String(value || "").replace(/\D/g, "");
    return digits.length >= 10 ? digits.slice(-10) : "";
  }

  function nameTokens(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1);
  }

  /** Plate, then year+make+model — the two ways the same car shows up twice. */
  function vehicleKeys(job) {
    const keys = [];
    const plate = String(job.vehiclePlate || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (plate.length >= 4) keys.push(`plate:${plate}`);
    const parts = [job.vehicleYear, job.vehicleMake, job.vehicleModel]
      .map((part) => String(part || "").trim().toLowerCase())
      .filter(Boolean);
    if (parts.length >= 2) keys.push(`model:${parts.join(" ")}`);
    return keys;
  }

  /** One typo apart — Klaver / Claver, thumbed in at the roadside. */
  function withinOneEdit(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    const short = a.length <= b.length ? a : b;
    const long = a.length <= b.length ? b : a;
    let i = 0;
    let j = 0;
    let slack = 1;
    while (i < short.length && j < long.length) {
      if (short[i] === long[j]) {
        i += 1;
        j += 1;
        continue;
      }
      if (!slack) return false;
      slack -= 1;
      if (short.length === long.length) i += 1;
      j += 1;
    }
    return true;
  }

  /**
   * "Somewhat similar", made precise: every token of the SHORTER name has to
   * land in the longer one. So `Klaver` matches `Mike Klaver` and `Josh`
   * matches `Josh Berg`, while `Jane Smith` and `John Smith` stay apart —
   * a shared surname on its own is not a person.
   */
  function namesLookAlike(aTokens, bTokens) {
    if (!aTokens.length || !bTokens.length) return false;
    const small = aTokens.length <= bTokens.length ? aTokens : bTokens;
    const large = aTokens.length <= bTokens.length ? bTokens : aTokens;
    let shared = 0;
    for (const token of small) {
      const hit = large.find((other) => other === token
        || (token.length >= 4 && other.length >= 4 && withinOneEdit(token, other)));
      if (!hit) return false;
      if (hit.length >= 3) shared += 1;
    }
    return shared > 0;
  }

  /**
   * Folds the job list into one entry per person, newest activity first.
   *
   * Pass 1 joins on the phone number, which is the strong signal and needs no
   * help from the name. Pass 2 joins on the name, which is why a group can end
   * up holding two different numbers — that group is flagged `needsReview`
   * rather than quietly presented as fact.
   */
  function customerGroups(jobs = state.jobs) {
    const list = [...jobs];
    const parent = new Map(list.map((job) => [job.id, job.id]));
    const find = (id) => {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root);
      let walk = id;
      while (parent.get(walk) !== root) {
        const next = parent.get(walk);
        parent.set(walk, root);
        walk = next;
      }
      return root;
    };
    const union = (a, b) => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent.set(rootB, rootA);
    };

    // Pass 1 — same number, same person, whatever the name says.
    const byPhone = new Map();
    for (const job of list) {
      const key = phoneKey(job.customerPhone);
      if (!key) continue;
      if (byPhone.has(key)) union(byPhone.get(key), job.id);
      else byPhone.set(key, job.id);
    }

    // Pass 2 — similar name. Tens of jobs, so the pairwise sweep is free.
    //
    // ONE EXCEPTION, AND IT MATTERS. A job saved under a bare first name is a
    // bridge: "Josh" looks similar to every Josh on the books, and because
    // grouping is transitive, one such record would fold two unrelated
    // customers into a single card. So a single-token name has to be
    // corroborated by the car before it joins anything. That is what rescues
    // "Klaver" — one word, no number — onto the right 2008 Honda, while a
    // stray "Josh" on a different truck stays where it is.
    const tokens = new Map(list.map((job) => [job.id, nameTokens(job.customerName)]));
    const cars = new Map(list.map((job) => [job.id, vehicleKeys(job)]));
    for (let i = 0; i < list.length; i += 1) {
      for (let k = i + 1; k < list.length; k += 1) {
        const a = list[i].id;
        const b = list[k].id;
        if (find(a) === find(b)) continue;
        if (!namesLookAlike(tokens.get(a), tokens.get(b))) continue;
        const thin = tokens.get(a).length < 2 || tokens.get(b).length < 2;
        if (thin && !cars.get(a).some((key) => cars.get(b).includes(key))) continue;
        union(a, b);
      }
    }

    const groups = new Map();
    for (const job of list) {
      const root = find(job.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(job);
    }

    return [...groups.entries()]
      .map(([id, members]) => {
        const newestFirst = [...members].sort((a, b) =>
          String(b.createdAt).localeCompare(String(a.createdAt)));
        // The card needs one label. Fullest spelling first ("Mike Klaver" over
        // "Klaver"), then the spelling he used most often, then the earliest —
        // a typo is usually the one-off, and the one-off is usually the later
        // entry. It is only a label: every job below keeps the name it was
        // saved under, and any spelling that lost is listed as an alias, so
        // nothing rides on this tiebreak.
        const spellings = newestFirst
          .map((job) => String(job.customerName || "").trim())
          .filter(Boolean);
        const uses = spellings.reduce((tally, spelling) => {
          tally.set(spelling, (tally.get(spelling) || 0) + 1);
          return tally;
        }, new Map());
        const ranked = [...new Set(spellings)].sort((a, b) =>
          nameTokens(b).length - nameTokens(a).length
          || uses.get(b) - uses.get(a)
          || spellings.lastIndexOf(b) - spellings.lastIndexOf(a));
        const name = ranked[0] || "Name not recorded";
        const aliases = ranked.slice(1);
        // One entry per actual number. `4065550188` and `(406) 555-0188` are
        // the same phone typed twice, and printing both reads like a bug.
        // The better-punctuated spelling wins, because that is the one a thumb
        // can dial off the screen.
        const phones = [...newestFirst
          .map((job) => String(job.customerPhone || "").trim())
          .filter(Boolean)
          .reduce((best, spelling) => {
            const key = phoneKey(spelling) || spelling;
            const held = best.get(key);
            const formatting = (value) => value.replace(/\d/g, "").length;
            if (!held || formatting(spelling) > formatting(held)) best.set(key, spelling);
            return best;
          }, new Map())
          .values()];
        const vehicles = [...new Set(newestFirst.map((job) => vehicleName(job)).filter(Boolean))];
        const distinctNumbers = new Set(newestFirst.map((job) => phoneKey(job.customerPhone)).filter(Boolean));
        return {
          id,
          name,
          aliases,
          phones,
          vehicles,
          jobs: newestFirst,
          // Only a name-based join can land two numbers in one group, so this
          // is exactly the "same name, different person?" case — his to call.
          needsReview: distinctNumbers.size > 1
        };
      })
      .sort((a, b) => String(b.jobs[0].createdAt).localeCompare(String(a.jobs[0].createdAt)));
  }

  function renderBoardModes() {
    const byCustomer = state.boardMode === "customer";
    const jobsButton = $("boardModeJobs");
    const customersButton = $("boardModeCustomers");
    if (!jobsButton || !customersButton) return;
    jobsButton.classList.toggle("is-active", !byCustomer);
    customersButton.classList.toggle("is-active", byCustomer);
    jobsButton.setAttribute("aria-pressed", String(!byCustomer));
    customersButton.setAttribute("aria-pressed", String(byCustomer));
  }

  function renderCustomerBoard() {
    const grid = $("customerGrid");
    if (!grid) return;
    const groups = customerGroups(state.jobs.filter((job) => !job.archived));

    if (!groups.length) {
      grid.innerHTML = `
        <div class="empty-state">
          <strong>No customers yet.</strong>
          <p>Every work order you save files itself under the person who owns the car.</p>
        </div>`;
      return;
    }

    grid.innerHTML = groups.map((group) => {
      const review = group.needsReview
        ? `<p class="customer-review">Two different numbers under this name. Check it is one person.</p>`
        : "";
      const vehicles = group.vehicles.length
        ? `<span class="customer-cars">${group.vehicles.map((car) => `<span>${escapeHtml(car)}</span>`).join("")}</span>`
        : `<span class="customer-cars"><span>Vehicle not recorded</span></span>`;
      const jobs = group.jobs.map((job) => `
        <button class="customer-job" type="button" data-job-id="${escapeHtml(job.id)}" data-status="${escapeHtml(job.status)}">
          <span class="customer-job-id">${escapeHtml(job.id)}</span>
          <span class="customer-job-car">${escapeHtml(vehicleName(job) || "Vehicle not named")}</span>
          <span class="status-pill ${escapeHtml(job.status)}">${escapeHtml(STATUS_COPY[job.status] || job.status)}</span>
          <span class="customer-job-time">${duration(billableSeconds(job))}</span>
        </button>`).join("");
      return `
        <article class="customer-card" data-customer-id="${escapeHtml(group.id)}">
          <header class="customer-card-head">
            <h3>${escapeHtml(group.name)}</h3>
            <span class="customer-count">${group.jobs.length} ${group.jobs.length === 1 ? "job" : "jobs"}</span>
          </header>
          ${group.aliases.length ? `<p class="customer-aliases">Also entered as ${group.aliases.map(escapeHtml).join(" · ")}</p>` : ""}
          <p class="customer-phones">${group.phones.length ? group.phones.map(escapeHtml).join(" · ") : "No number on file"}</p>
          ${vehicles}
          ${review}
          <div class="customer-jobs">${jobs}</div>
        </article>`;
    }).join("");

    // Bound once, on the container. Re-binding per button after an innerHTML
    // swap is how a tap ends up firing twice.
    grid.onclick = (event) => {
      const button = event.target.closest("[data-job-id]");
      if (!button) return;
      openJob(button.dataset.jobId);
    };
  }

  function renderBoard() {
    saveState();
    renderBoardModes();
    const byCustomer = state.boardMode === "customer";
    const jobGrid = $("jobGrid");
    const customerGrid = $("customerGrid");
    if (jobGrid) jobGrid.classList.toggle("hidden", byCustomer);
    if (customerGrid) customerGrid.classList.toggle("hidden", !byCustomer);
    const archiveToggleHost = document.querySelector(".job-archive-toggle");
    if (archiveToggleHost) archiveToggleHost.classList.toggle("hidden", byCustomer);
    if (byCustomer) {
      renderCustomerBoard();
      return;
    }
    const showArchived = Boolean(state.showArchivedJobs);
    const allJobs = [...state.jobs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const archivedCount = allJobs.filter((job) => job.archived).length;
    const jobs = allJobs.filter((job) => (showArchived ? job.archived : !job.archived));

    if (!allJobs.length) {
      $("jobGrid").innerHTML = `
        <div class="empty-state">
          <strong>No work orders yet.</strong>
          <p>Create the first job when you arrive. The timer, receipts, notes, and final invoice will stay together.</p>
          <button class="button button-dark" id="emptyNewJob" type="button">Create first job</button>
        </div>`;
      $("emptyNewJob").addEventListener("click", openNewJob);
      return;
    }

    const emptyCopy = showArchived
      ? `<div class="empty-state"><strong>No archived jobs.</strong><p>Swipe left on a job to archive one that was started by mistake.</p></div>`
      : `<div class="empty-state"><strong>No active jobs.</strong><p>Create a work order, or show archived jobs below.</p><button class="button button-dark" id="emptyNewJob" type="button">Create job</button></div>`;

    const listMarkup = jobs.length
      ? jobs
          .map((job) => {
            const statusLabel = job.archived
              ? "Archived"
              : STATUS_COPY[job.status] || job.status;
            const restoreButton = job.archived
              ? `<button class="job-swipe-action restore" type="button" data-restore-job="${escapeHtml(job.id)}">Restore</button>`
              : `<button class="job-swipe-action archive" type="button" data-archive-job="${escapeHtml(job.id)}">Archive</button>`;
            return `
      <div class="job-swipe" data-job-id="${escapeHtml(job.id)}">
        <div class="job-swipe-actions" aria-hidden="true">
          ${restoreButton}
          <button class="job-swipe-action delete" type="button" data-delete-job="${escapeHtml(job.id)}">Delete</button>
        </div>
        <button class="job-card job-swipe-front" type="button" data-status="${escapeHtml(job.archived ? "archived" : job.status)}">
          <span class="job-card-top">
            <span class="job-id">${escapeHtml(job.id)}</span>
            <span class="status-pill ${escapeHtml(job.archived ? "archived" : job.status)}">${escapeHtml(statusLabel)}</span>
          </span>
          <h3>${escapeHtml(vehicleName(job) || "Vehicle not named")}</h3>
          <p class="customer">${escapeHtml(job.customerName)}</p>
          <span class="card-stats">
            <span><span>Work</span><strong>${duration(billableSeconds(job))}</strong></span>
            <span><span>Receipts</span><strong>${job.receipts.length}</strong></span>
            <span><span>Materials</span><strong>${job.materials.length}</strong></span>
          </span>
        </button>
      </div>`;
          })
          .join("")
      : emptyCopy;

    const archivedToggle =
      archivedCount > 0
        ? `<div class="job-archive-toggle">
            <button class="button button-quiet" id="toggleArchivedJobs" type="button">
              ${showArchived ? "Hide archived jobs" : `Show archived (${archivedCount})`}
            </button>
          </div>`
        : "";

    $("jobGrid").innerHTML = `${listMarkup}${archivedToggle}`;

    const emptyNew = $("emptyNewJob");
    if (emptyNew) emptyNew.addEventListener("click", openNewJob);

    const toggle = $("toggleArchivedJobs");
    if (toggle) {
      toggle.addEventListener("click", () => {
        state.showArchivedJobs = !state.showArchivedJobs;
        renderBoard();
      });
    }

    document.querySelectorAll(".job-swipe").forEach((row) => bindJobSwipe(row));

    document.querySelectorAll("[data-archive-job]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        archiveJob(button.dataset.archiveJob);
        closeOpenSwipes();
        renderBoard();
      });
    });

    document.querySelectorAll("[data-restore-job]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        unarchiveJob(button.dataset.restoreJob);
        closeOpenSwipes();
        renderBoard();
      });
    });

    document.querySelectorAll("[data-delete-job]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const id = button.dataset.deleteJob;
        const job = findJob(id);
        const label = job ? vehicleName(job) || job.id : id;
        if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
        await deleteJobEverywhere(id);
        closeOpenSwipes();
        renderBoard();
      });
    });
  }

  async function openJob(id) {
    const job = findJob(id);
    if (!job) {
      showBoard();
      return;
    }
    if (selectedJobId !== id) timeSheetDrafts = [];
    selectedJobId = id;
    window.location.hash = `job/${encodeURIComponent(id)}`;
    boardView.classList.add("hidden");
    jobView.classList.remove("hidden");
    await renderJob();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Two states, nothing else: on the clock or off it. Clocking out stops
  // billable time and leaves the job open — finishing the job is the separate
  // Finish Project button further down the page.
  function timerControls(job) {
    if (job.status === "draft" || job.status === "clocked_out") {
      return `<button class="button button-green" data-timer-action="clock_in" type="button">Clock in</button>`;
    }
    if (job.status === "in_progress") {
      return `<button class="button button-dark" data-timer-action="clock_out" type="button">Clock out</button>`;
    }
    return `<button class="button button-quiet" type="button" disabled>${job.status === "invoiced" ? "Invoice filed" : "Finished job"}</button>`;
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
      </div>
      <p class="time-edit-note">Tap away or scroll and it auto-saves.</p>`;
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
        ${customerPortalLink(job) ? `
          <div class="customer-link-row">
            <span class="detail-label">Customer's invoice link — send this</span>
            <code class="customer-link-url">${escapeHtml(customerPortalLink(job))}</code>
            <button class="button button-quiet button-compact" id="copyCustomerLinkButton" type="button" data-link="${escapeHtml(customerPortalLink(job))}">Copy link</button>
          </div>` : ""}
        <button class="button button-quiet unsubmit-button" data-unsubmit-invoice type="button">Unsubmit invoice</button>
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

  /**
   * Rows he has started but not saved yet. Held outside the job so a re-render
   * — a Done on the row above, the live timer, a sync landing — does not wipe a
   * half-typed row, and so nothing reaches the invoice until he taps Done.
   */
  let timeSheetDrafts = [];

  function newTimeSheetDraft() {
    const now = new Date();
    return { draftId: uid(), date: toDateInputValue(now.toISOString()), start: "", end: "" };
  }

  /**
   * Copies what is currently typed in the draft rows back into timeSheetDrafts.
   * Called before anything re-renders, so a second half-filled row survives a
   * Done on the first one.
   */
  function readTimeSheetDrafts() {
    document.querySelectorAll("[data-draft-id]").forEach((row) => {
      const draft = timeSheetDrafts.find((item) => item.draftId === row.dataset.draftId);
      if (!draft) return;
      draft.date = row.querySelector("[data-session-date]")?.value || "";
      draft.start = row.querySelector("[data-session-start]")?.value || "";
      draft.end = row.querySelector("[data-session-end]")?.value || "";
    });
  }

  function sessionRowMarkup({ key, attr, date, start, end, running, length }) {
    return `
      <li class="session-row" ${attr}="${escapeHtml(key)}">
        <div class="session-fields">
          <label class="field">
            <span>Date</span>
            <input type="date" data-session-date value="${escapeHtml(date)}">
          </label>
          <label class="field">
            <span>Clock in</span>
            <input type="time" data-session-start value="${escapeHtml(start)}">
          </label>
          <label class="field">
            <span>Clock out</span>
            ${running
              ? `<input type="time" value="" disabled placeholder="Running">`
              : `<input type="time" data-session-end value="${escapeHtml(end)}">`}
          </label>
        </div>
        <div class="session-actions">
          <span class="session-length">${running ? "On the clock now" : escapeHtml(length)}</span>
          <button class="button button-quiet" type="button" data-session-done>Done</button>
          ${running
            ? ""
            : `<button class="icon-button" type="button" data-session-remove aria-label="Remove this worked time">×</button>`}
        </div>
      </li>`;
  }

  /**
   * The hand-written time sheet. He worked and never touched the clock, so each
   * span he actually worked is entered here: date, in, out, Done — as many as
   * he wants. What is saved here is billable time, exactly like a tapped span.
   */
  function timeSheetMarkup(job) {
    const sessions = workSessions(job);
    const rows = sessions.map((entry) => {
      const running = !entry.endedAt;
      const seconds = running
        ? 0
        : Math.max(0, Math.floor((Date.parse(entry.endedAt) - Date.parse(entry.startedAt)) / 1000));
      const span = hoursMinutes(seconds);
      return sessionRowMarkup({
        key: entry.id,
        attr: "data-entry-id",
        date: toDateInputValue(entry.startedAt),
        start: toTimeInputValue(entry.startedAt),
        end: toTimeInputValue(entry.endedAt),
        running,
        length: `${span.hours}h ${String(span.minutes).padStart(2, "0")}m`
      });
    });
    const drafts = timeSheetDrafts.map((draft) => sessionRowMarkup({
      key: draft.draftId,
      attr: "data-draft-id",
      date: draft.date,
      start: draft.start,
      end: draft.end,
      running: false,
      length: "Not saved yet"
    }));
    const all = [...rows, ...drafts];
    return `
      <div class="time-sheet" id="timeSheet">
        <div class="time-edit-heading">
          <span class="detail-label">Times you worked</span>
          <strong>${sessions.length} session${sessions.length === 1 ? "" : "s"}</strong>
        </div>
        <p class="time-edit-note">Worked without tapping the clock? Put the date and the hours in here. Each one you save is billable time on this invoice, same as a tapped clock-in.</p>
        ${all.length ? `<ol class="session-list">${all.join("")}</ol>` : `<p class="time-edit-note">No worked time recorded yet.</p>`}
        <div class="save-row time-edit-actions">
          <button class="button button-quiet" id="addWorkedTimeButton" type="button">+ Add a time you worked</button>
        </div>
      </div>`;
  }

  function clockHistoryMarkup(job) {
    const labels = {
      clock_in: "Clocked in",
      clock_out: "Clocked out",
      // Kept only so a job saved before breaks were removed still reads
      // correctly in its own history.
      break_start: "Clocked out",
      break_end: "Clocked in",
      finished: "Finished project",
      // Entered by hand, and labelled as such — the trail never claims a tap
      // that never happened.
      time_added: "Worked time added by hand",
      time_edited: "Worked time corrected by hand",
      time_removed: "Worked time removed by hand"
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
              ${event.detail ? `<small>${escapeHtml(event.detail)}</small>` : ""}
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
        <p>${escapeHtml(job.customerName)} · ${escapeHtml(job.customerPhone || "No phone recorded")} · ${escapeHtml(job.vehiclePlate || "No plate recorded")}</p>
        <div class="job-hero-meta">
          <span class="status-pill ${escapeHtml(job.status)}">${escapeHtml(STATUS_COPY[job.status])}</span>
          <span>Opened ${calendarDate(job.createdAt)}</span>
          <span>${money(job.laborRateCents)}/hour</span>
          ${locked ? "" : `<button class="text-button" id="editDetailsShortcut" type="button">Edit details</button>`}
        </div>
      </div>

      <div class="detail-layout">
        <div class="detail-column">
          <article class="content-card">
            <div class="card-heading">
              <div>
                <p class="eyebrow">Job timer</p>
                <h2>${job.status === "draft" ? "Ready to begin" : job.status === "clocked_out" ? "Off the clock" : "Work ledger"}</h2>
              </div>
              <span class="status-pill ${escapeHtml(job.status)}">${escapeHtml(STATUS_COPY[job.status])}</span>
            </div>
            <div class="timer-face">
              <span>Billable work time</span>
              <strong id="liveWorkTimer">${duration(workSeconds)}</strong>
            </div>
            <div class="timer-summary">
              <div><span class="detail-label">First clocked in</span><strong>${clockTime(job.startedAt)}</strong></div>
              <div><span class="detail-label">Clock events</span><strong>${(job.eventHistory || []).filter((event) => event.action === "clock_in" || event.action === "clock_out").length}</strong></div>
            </div>
            <div class="timer-buttons">${timerControls(job)}</div>
            <div class="time-edit">
              <div class="time-edit-heading">
                <span class="detail-label">Billable hours on the invoice</span>
                <strong id="billableSummary">${duration(workSeconds)}</strong>
              </div>
              <p class="time-edit-note">Timer ${duration(timedSeconds)}${manualWorkSeconds(job) ? ` · ${manualWorkSignValue(job) < 0 ? "subtracted" : "added"} ${adjustment.hours}h ${adjustment.minutes}m` : ""} · timer labor ${money(draft.timedLaborCents)}</p>
              ${locked ? "" : `
                ${timeSheetMarkup(job)}
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
                  <button class="button button-quiet" id="manualTimeSign" type="button" aria-label="Toggle add or subtract">${manualWorkSignValue(job) < 0 ? "− Subtract" : "+ Add"}</button>
                  <button class="button button-quiet" id="setManualTimeButton" type="button">Set adjustment</button>
                  <button class="button button-quiet" id="addManualTimeButton" type="button">Add to adjustment</button>
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
                  <p class="time-edit-note">Tap away or scroll and it auto-saves.</p>
                </div>`}
            </div>
            <div class="history-panel">
              <p class="eyebrow">Permanent audit trail</p>
              <h3>Clock history</h3>
              ${clockHistoryMarkup(job)}
            </div>
          </article>

          <article class="content-card" id="jobDetailsCard">
            <div class="card-heading">
              <div>
                <p class="eyebrow">Work order details</p>
                <h2>Customer &amp; vehicle</h2>
                <p>Every line here can be corrected — name, caller's number, email, vehicle, or plate.</p>
              </div>
              ${locked ? "" : `<div class="card-cta"><button class="button button-quiet" type="button" data-edit-toggle="jobDetailsCard">Edit</button></div>`}
            </div>
            <div class="edit-read">
              <div class="detail-readout">
                <div class="readout-row"><span class="detail-label">Customer</span><strong>${escapeHtml(job.customerName || "Not entered")}</strong></div>
                <div class="readout-row"><span class="detail-label">Phone</span><strong>${escapeHtml(job.customerPhone || "Not entered")}</strong></div>
                <div class="readout-row"><span class="detail-label">Email</span><strong>${escapeHtml(job.customerEmail || "Not entered")}</strong></div>
                <div class="readout-row"><span class="detail-label">Vehicle</span><strong>${escapeHtml(vehicleName(job) || "Not entered")}</strong></div>
                <div class="readout-row"><span class="detail-label">Plate</span><strong>${escapeHtml(job.vehiclePlate || "Not entered")}</strong></div>
                <div class="readout-row"><span class="detail-label">Hourly rate</span><strong>${money(job.laborRateCents)}</strong></div>
              </div>
            </div>
            ${locked ? "" : `
              <div class="edit-form" id="jobDetailsFields">
                <div class="form-grid">
                  <label class="field field-wide">
                    <span>${requiredStar("Customer name")}</span>
                    <input data-job-field="customerName" autocomplete="name" value="${escapeHtml(job.customerName || "")}">
                  </label>
                  <label class="field field-wide">
                    <span>Caller / phone</span>
                    <input data-job-field="customerPhone" type="tel" inputmode="tel" value="${escapeHtml(job.customerPhone || "")}" placeholder="406 555 0147">
                  </label>
                  <label class="field field-wide">
                    <span>Email</span>
                    <input data-job-field="customerEmail" type="email" inputmode="email" value="${escapeHtml(job.customerEmail || "")}">
                  </label>
                </div>
                <div class="form-grid vehicle-grid">
                  <label class="field">
                    <span>Year</span>
                    <input data-job-field="vehicleYear" inputmode="numeric" maxlength="4" value="${escapeHtml(job.vehicleYear || "")}" placeholder="2018">
                  </label>
                  <label class="field">
                    <span>${requiredStar("Make")}</span>
                    <input data-job-field="vehicleMake" value="${escapeHtml(job.vehicleMake || "")}" placeholder="Ford">
                  </label>
                  <label class="field">
                    <span>${requiredStar("Model")}</span>
                    <input data-job-field="vehicleModel" value="${escapeHtml(job.vehicleModel || "")}" placeholder="F-150">
                  </label>
                  <label class="field">
                    <span>Plate</span>
                    <input data-job-field="vehiclePlate" autocapitalize="characters" value="${escapeHtml(job.vehiclePlate || "")}" placeholder="Add it later">
                  </label>
                </div>
                <p class="time-edit-note">The hourly rate lives with the labor total in the Job timer card above, so there is only ever one of it.</p>
                <div class="save-row">
                  <button class="button button-quiet" id="saveDetailsButton" type="button">Save details</button>
                </div>
                <p class="time-edit-note">Tap away or scroll and it auto-saves.</p>
              </div>`}
          </article>

          <article class="content-card" id="agreedWorkCard">
            <div class="card-heading">
              <div>
                <p class="eyebrow">Approved scope</p>
                <h2>Agreed work</h2>
              </div>
              ${locked ? "" : `<div class="card-cta"><button class="button button-quiet" type="button" data-edit-toggle="agreedWorkCard">Edit</button></div>`}
            </div>
            <div class="edit-read">
              <p class="work-copy">${escapeHtml(job.agreedWork || "No agreed work recorded yet.")}</p>
            </div>
            ${locked ? "" : `
              <div class="edit-form">
                <label class="field field-wide">
                  <span>${requiredStar("Work description")}</span>
                  <textarea class="suggestions" id="agreedWorkInput" rows="4" placeholder="Diagnose no-start condition and replace the agreed failed component.">${escapeHtml(job.agreedWork || "")}</textarea>
                </label>
                <div class="save-row">
                  <button class="button button-quiet" id="saveAgreedWorkButton" type="button">Save agreed work</button>
                </div>
                <p class="time-edit-note">Tap away or scroll and it auto-saves.</p>
              </div>`}
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
            ${locked ? "" : `<div class="save-row"><button class="button button-quiet" id="saveSuggestionsButton" type="button">Save suggestions</button></div>
              <p class="time-edit-note">Tap away or scroll and it auto-saves.</p>`}
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
              <div class="card-cta">
                <button class="button button-voice" id="voiceReceiptButton" type="button" ${locked ? "disabled" : ""}><span aria-hidden="true">🎙</span> Receipts by voice</button>
                <button class="button button-talk hidden" id="jobShopAgentButton" type="button"><span aria-hidden="true">💬</span> Ask Anya</button>
                <button class="button button-quiet" id="addReceiptButton" type="button" ${locked ? "disabled" : ""}>+ Receipt</button>
              </div>
            </div>
            <div class="receipt-list">${receipts}</div>
            ${locked ? `
              <p class="time-edit-note">${job.receiptReview ? "Receipt folder saved." : "Receipt folder not saved yet."}</p>
            ` : `
              <div class="save-row">
                <button class="button button-gold" id="saveReceiptFolderButton" type="button">Save receipt folder</button>
              </div>
              <p class="time-edit-note">Tap away or scroll to auto-save vendor, receipt parts, amount, and +/-. Stars (*) required before Finish Project.</p>
            `}
          </article>

          ${job.status !== "invoiced" ? `
            <article class="content-card invoice-card">
              <div class="card-heading">
                <div>
                  <p class="eyebrow">Invoice at capture</p>
                  <h2>${job.status === "completed" ? "Ready to bill" : "Running invoice"}</h2>
                  <p>Receipt photos roll into parts the moment you file them. Finish Project files the invoice so you can share it for payment.</p>
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
          <h3>${job.status === "invoiced" ? "Invoice filed." : job.status === "completed" ? "Job clock is closed." : "Finished with the vehicle?"}</h3>
          <p>${job.status === "invoiced"
            ? "The invoice is filed and the customer can open it on their link. Need to change something? Unsubmit it — the job reopens clocked out and every field unlocks, then Finish Project files it again."
            : job.status === "draft"
              ? "Clock in first so the invoice receives an accurate labor total."
              : "Finish Project closes the timer and files the invoice so you can get paid. Clocking out for the day doesn't affect it — come back, clock in again, and hit Finish Project when the job is actually done."}</p>
        </div>
        <div class="card-cta">
          ${job.status === "invoiced"
            ? `<button class="button button-quiet unsubmit-button" data-unsubmit-invoice type="button">Unsubmit invoice</button>`
            : `<button class="button button-talk hidden" id="finishReviewButton" type="button"><span aria-hidden="true">💬</span> Ask Anya to finish your invoice</button>
          <button class="button button-voice" id="voiceFinishButton" type="button" ${job.status === "in_progress" || job.status === "clocked_out" ? "" : "disabled"}><span aria-hidden="true">🎙</span> Close it by voice</button>
          <button class="button button-red" id="clockOutButton" type="button" ${job.status === "in_progress" || job.status === "clocked_out" ? "" : "disabled"}>Finish Project</button>`}
        </div>
      </section>`;

    bindJobEvents(job);
    updateLiveTimer();
  }

  let flushOpenJobAutosave = null;
  let scrollAutosaveTimer = null;
  window.addEventListener(
    "scroll",
    () => {
      if (typeof flushOpenJobAutosave !== "function") return;
      clearTimeout(scrollAutosaveTimer);
      scrollAutosaveTimer = setTimeout(() => flushOpenJobAutosave(), 250);
    },
    { passive: true }
  );
  jobView.addEventListener("focusout", () => {
    if (typeof flushOpenJobAutosave !== "function") return;
    setTimeout(() => {
      if (typeof flushOpenJobAutosave === "function") flushOpenJobAutosave();
    }, 0);
  });

  function bindJobEvents(job) {
    /**
     * Writes the customer and vehicle back onto the job. Every field on a work
     * order is correctable after the fact — a name heard wrong over a phone, a
     * plate that was never read, a number typed a digit short.
     */
    function persistDetails() {
      const panel = $("jobDetailsFields");
      if (!panel) return false;
      const read = (name) =>
        String(panel.querySelector(`[data-job-field="${name}"]`)?.value ?? "").trim();
      const next = {
        // The name is the one field the customer portal signs in on, so a blank
        // is treated as "not edited" rather than wiping the record's identity.
        customerName: read("customerName") || job.customerName || "",
        customerPhone: read("customerPhone"),
        customerEmail: read("customerEmail"),
        vehicleYear: read("vehicleYear"),
        vehicleMake: read("vehicleMake") || job.vehicleMake || "",
        vehicleModel: read("vehicleModel") || job.vehicleModel || "",
        vehiclePlate: read("vehiclePlate").toUpperCase()
      };
      const changed = Object.entries(next).some(([key, value]) => String(job[key] || "") !== value);
      if (!changed) return false;
      Object.assign(job, next);
      queueJobSync(job);
      return true;
    }

    function persistAgreedWork() {
      const input = $("agreedWorkInput");
      if (!input || input.disabled) return false;
      const next = input.value.trim();
      // Agreed work is what the invoice bills against; an empty box is a
      // mis-tap, not an instruction to erase the scope.
      if (!next || next === (job.agreedWork || "")) return false;
      job.agreedWork = next;
      queueJobSync(job);
      return true;
    }

    function persistSuggestions() {
      const input = $("suggestionsInput");
      if (!input || input.disabled) return false;
      const next = input.value.trim();
      if (next === (job.suggestions || "")) return false;
      job.suggestions = next;
      queueJobSync(job);
      return true;
    }

    function persistMaterials() {
      const rows = $("jobMaterialRows");
      if (!rows) return false;
      const next = [...rows.querySelectorAll(".material-row")]
        .map((row) => ({
          id: row.dataset.materialId || uid(),
          description: row.querySelector('[name="jobMaterialDescription"]')?.value.trim() || ""
        }))
        .filter((item) => item.description);
      const before = JSON.stringify((job.materials || []).map((item) => [item.id, item.description]));
      const after = JSON.stringify(next.map((item) => [item.id, item.description]));
      if (before === after) return false;
      job.materials = next;
      queueJobSync(job);
      return true;
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

    function persistLabor() {
      if (!$("laborRateInput")) return false;
      const before = JSON.stringify({
        rate: job.laborRateCents || 0,
        adj: job.laborAdjustmentCents || 0,
        diff: job.difficultyLevel || "Standard"
      });
      applyLaborFromForm(job);
      const after = JSON.stringify({
        rate: job.laborRateCents || 0,
        adj: job.laborAdjustmentCents || 0,
        diff: job.difficultyLevel || "Standard"
      });
      if (before === after) return false;
      queueJobSync(job);
      return true;
    }

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

    function folderSnapshot(targetJob) {
      return JSON.stringify(
        (targetJob.receipts || []).map((receipt) => [
          receipt.id,
          receipt.vendor || "",
          receipt.receiptParts || receipt.orderId || "",
          receipt.amountCents || 0,
          receipt.adjustCents || 0,
          receipt.adjustSign || 1
        ])
      );
    }

    function persistFolder() {
      if (!job.receipts.length) return false;
      if (!document.querySelector("[data-folder-vendor], [data-folder-parts], [data-folder-amount], [data-folder-adjust]")) {
        return false;
      }
      const before = folderSnapshot(job);
      readFolderReceiptInputs(job);
      const after = folderSnapshot(job);
      if (before === after) return false;
      job.receiptReview = !jobReadyForInvoice(job);
      job.receiptFolderSavedAt = new Date().toISOString();
      if (job.invoice) job.invoice = invoiceDraft(job);
      queueJobSync(job);
      return true;
    }

    function flushJobAutosave() {
      if (job.status === "invoiced") return false;
      // Every panel is asked, deliberately without `||`: short-circuiting meant
      // that editing the suggestions and the labor rate in one visit saved only
      // the suggestions, and the rate was silently thrown away on the next
      // render. Each persist* is its own cheap dirty-check.
      const results = [
        persistDetails(),
        persistAgreedWork(),
        persistSuggestions(),
        persistMaterials(),
        persistLabor(),
        persistFolder()
      ];
      const changed = results.some(Boolean);
      if (changed) notifyAutoSaved();
      return changed;
    }

    flushOpenJobAutosave = () => flushJobAutosave();

    $("backButton").addEventListener("click", () => {
      flushJobAutosave();
      showBoard();
    });
    document.querySelectorAll("[data-timer-action]").forEach((button) => {
      button.addEventListener("click", () => {
        flushJobAutosave();
        timerAction(job, button.dataset.timerAction);
      });
    });

    const clockOutButton = $("clockOutButton");
    if (clockOutButton) {
      clockOutButton.addEventListener("click", () => {
        if ($("laborRateInput")) applyLaborFromForm(job);
        if (job.receipts.length) readFolderReceiptInputs(job);
        persistDetails();
        persistAgreedWork();
        persistSuggestions();
        persistMaterials();
        const blocked = jobReadyForInvoice(job);
        if (blocked) {
          notify(blocked, true);
          return;
        }
        timerAction(job, "finish");
      });
    }

    const addReceiptButton = $("addReceiptButton");
    if (addReceiptButton) {
      addReceiptButton.addEventListener("click", () => {
        flushJobAutosave();
        openReceiptDialog(job.id);
      });
    }

    const jobShopAgentButton = $("jobShopAgentButton");
    if (jobShopAgentButton) {
      jobShopAgentButton.addEventListener("click", () => window.GMMAgent?.openChat());
      // Re-checked per render rather than cached on the element: the job view
      // is rebuilt by innerHTML, so this is a fresh button every time.
      void Promise.resolve(window.GMMAgent?.available() ?? false).then((ready) => {
        jobShopAgentButton.classList.toggle("hidden", !ready);
      });
    }

    const finishReviewButton = $("finishReviewButton");
    if (finishReviewButton) {
      finishReviewButton.addEventListener("click", () => window.GMMAgent?.reviewInvoice());
      // Same per-render availability gate as the other Anya buttons: a finish
      // check that could only answer "not switched on" is never shown.
      void Promise.resolve(window.GMMAgent?.available() ?? false).then((ready) => {
        finishReviewButton.classList.toggle("hidden", !ready);
      });
    }

    const voiceReceiptButton = $("voiceReceiptButton");
    if (voiceReceiptButton) {
      voiceReceiptButton.addEventListener("click", () => {
        // Unlock audio inside the tap itself — iOS ignores a later attempt.
        window.GMMVoice?.prime();
        flushJobAutosave();
        void voiceReceipts(job);
      });
    }

    const voiceFinishButton = $("voiceFinishButton");
    if (voiceFinishButton) {
      voiceFinishButton.addEventListener("click", () => {
        window.GMMVoice?.prime();
        if ($("laborRateInput")) applyLaborFromForm(job);
        if (job.receipts.length) readFolderReceiptInputs(job);
        persistDetails();
        persistAgreedWork();
        persistSuggestions();
        persistMaterials();
        void voiceFinishJob(job);
      });
    }

    document.querySelectorAll("[data-receipt-id]").forEach((button) => {
      button.addEventListener("click", () => viewReceipt(button.dataset.receiptId));
    });

    /**
     * One Edit button per card. Each editable card ships both views and the
     * toggle swaps which is showing, so the read-back a mechanic glances at
     * stays clean and the correction is one tap away rather than buried.
     */
    document.querySelectorAll("[data-edit-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        const card = document.getElementById(button.dataset.editToggle);
        if (!card) return;
        const editing = card.classList.toggle("is-editing");
        button.textContent = editing ? "Done" : "Edit";
        if (editing) {
          card.querySelector(".edit-form input, .edit-form textarea")?.focus();
          return;
        }
        // Closing the editor is a save, not a discard.
        flushJobAutosave();
        void renderJob();
      });
    });

    const editDetailsShortcut = $("editDetailsShortcut");
    if (editDetailsShortcut) {
      editDetailsShortcut.addEventListener("click", () => {
        const card = $("jobDetailsCard");
        const toggle = document.querySelector('[data-edit-toggle="jobDetailsCard"]');
        if (!card || !toggle) return;
        if (!card.classList.contains("is-editing")) toggle.click();
        card.scrollIntoView?.({ behavior: "smooth", block: "start" });
      });
    }

    const saveDetailsButton = $("saveDetailsButton");
    if (saveDetailsButton) {
      saveDetailsButton.addEventListener("click", () => {
        persistDetails();
        notifyAutoSaved();
        // Always re-render: a blur-triggered autosave may have already taken
        // the change, and the read view still has to catch up either way.
        void renderJob();
      });
    }

    const saveAgreedWorkButton = $("saveAgreedWorkButton");
    if (saveAgreedWorkButton) {
      saveAgreedWorkButton.addEventListener("click", () => {
        persistAgreedWork();
        notifyAutoSaved();
        void renderJob();
      });
    }

    const saveSuggestionsButton = $("saveSuggestionsButton");
    if (saveSuggestionsButton) {
      saveSuggestionsButton.addEventListener("click", () => {
        persistSuggestions();
        notifyAutoSaved();
      });
    }

    // The hand-written time sheet: date, clock in, clock out, Done — repeated
    // for every span he actually worked. Bound to the rows this render made;
    // the whole panel is rebuilt by renderJob, so nothing is double-bound.
    const timeSheet = $("timeSheet");
    if (timeSheet) {
      const rowOf = (element) => element.closest("[data-entry-id], [data-draft-id]");

      /**
       * A Done rebuilds the whole card, and anything typed into a DIFFERENT
       * saved row — a start he was halfway through correcting — would be gone
       * with it. Nothing here is saved; the typing is simply put back where he
       * left it, and it still takes that row's own Done to bill it.
       */
      const carrySavedRowEdits = () => {
        const typed = new Map();
        document.querySelectorAll("[data-entry-id]").forEach((row) => {
          typed.set(row.dataset.entryId, {
            date: row.querySelector("[data-session-date]")?.value || "",
            start: row.querySelector("[data-session-start]")?.value || "",
            end: row.querySelector("[data-session-end]")?.value || ""
          });
        });
        return () => {
          document.querySelectorAll("[data-entry-id]").forEach((row) => {
            const before = typed.get(row.dataset.entryId);
            if (!before) return;
            const write = (selector, value) => {
              const input = row.querySelector(selector);
              // A blank is "this row was not being edited", never an erase.
              if (input && value) input.value = value;
            };
            write("[data-session-date]", before.date);
            write("[data-session-start]", before.start);
            write("[data-session-end]", before.end);
          });
        };
      };

      const addRow = () => {
        readTimeSheetDrafts();
        const restore = carrySavedRowEdits();
        timeSheetDrafts.push(newTimeSheetDraft());
        renderJob().then(() => {
          restore();
          // Land the thumb straight on the new row's date picker.
          const rows = document.querySelectorAll("[data-draft-id]");
          rows[rows.length - 1]?.querySelector("[data-session-date]")?.focus();
        });
      };

      $("addWorkedTimeButton")?.addEventListener("click", addRow);

      timeSheet.querySelectorAll("[data-session-done]").forEach((button) => {
        button.addEventListener("click", () => {
          const row = rowOf(button);
          if (!row) return;
          const values = {
            entryId: row.dataset.entryId || "",
            date: row.querySelector("[data-session-date]")?.value || "",
            start: row.querySelector("[data-session-start]")?.value || "",
            end: row.querySelector("[data-session-end]")?.value || ""
          };
          // Whatever is typed in the OTHER unsaved rows is captured first, so
          // saving this one never wipes the row he filled in before it.
          readTimeSheetDrafts();
          const result = commitWorkSession(job, values);
          if (!result.ok) {
            notify(result.message, true);
            return;
          }
          if (row.dataset.draftId) {
            timeSheetDrafts = timeSheetDrafts.filter((draft) => draft.draftId !== row.dataset.draftId);
          }
          const restore = carrySavedRowEdits();
          renderJob().then(restore);
          notify(result.message);
        });
      });

      timeSheet.querySelectorAll("[data-session-remove]").forEach((button) => {
        button.addEventListener("click", () => {
          const row = rowOf(button);
          if (!row) return;
          readTimeSheetDrafts();
          if (row.dataset.draftId) {
            // Never saved, so nothing to confirm and nothing to un-bill.
            timeSheetDrafts = timeSheetDrafts.filter((draft) => draft.draftId !== row.dataset.draftId);
            const restoreRows = carrySavedRowEdits();
            renderJob().then(restoreRows);
            return;
          }
          if (!window.confirm("Remove this worked time from the invoice?")) return;
          const result = voidWorkSession(job, row.dataset.entryId || "");
          renderJob();
          notify(result.message, !result.ok);
        });
      });
    }

    function readManualEntry() {
      const hours = Number.parseInt($("manualHoursInput")?.value ?? "", 10);
      const minutes = Number.parseInt($("manualMinutesInput")?.value ?? "", 10);
      const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 0;
      const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
      return safeHours * 3600 + safeMinutes * 60;
    }

    function readManualSign() {
      const text = $("manualTimeSign")?.textContent || "";
      return text.includes("−") || text.includes("-") ? -1 : 1;
    }

    function applyManualSeconds(seconds, sign, message) {
      flushJobAutosave();
      job.manualWorkSeconds = Math.max(0, Math.round(seconds));
      job.manualWorkSign = sign < 0 ? -1 : 1;
      if (job.invoice) job.invoice = invoiceDraft(job);
      queueJobSync(job);
      renderJob();
      notify(message);
    }

    const manualTimeSign = $("manualTimeSign");
    if (manualTimeSign) {
      manualTimeSign.addEventListener("click", () => {
        manualTimeSign.textContent = manualTimeSign.textContent.includes("−") ? "+ Add" : "− Subtract";
      });
    }

    const setManualTimeButton = $("setManualTimeButton");
    if (setManualTimeButton) {
      setManualTimeButton.addEventListener("click", () => {
        const entered = readManualEntry();
        const sign = readManualSign();
        const summary = hoursMinutes(entered);
        applyManualSeconds(
          entered,
          sign,
          `Adjustment set to ${sign < 0 ? "−" : "+"}${summary.hours}h ${summary.minutes}m.`
        );
      });
    }

    const addManualTimeButton = $("addManualTimeButton");
    if (addManualTimeButton) {
      addManualTimeButton.addEventListener("click", () => {
        const entered = readManualEntry();
        if (!entered) {
          notify("Enter hours or minutes before adjusting time.", true);
          return;
        }
        const sign = readManualSign();
        const totalSigned = manualWorkSignedSeconds(job) + sign * entered;
        const nextSign = totalSigned < 0 ? -1 : 1;
        const nextMagnitude = Math.abs(totalSigned);
        const summary = hoursMinutes(nextMagnitude);
        applyManualSeconds(
          nextMagnitude,
          nextSign,
          `Adjustment now ${nextSign < 0 ? "−" : "+"}${summary.hours}h ${summary.minutes}m.`
        );
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
          if (persistMaterials()) notifyAutoSaved();
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
          if (persistMaterials()) notifyAutoSaved();
        });
        jobMaterialRows.appendChild(row);
        row.querySelector("input")?.focus();
      });
    }

    const saveMaterialsButton = $("saveMaterialsButton");
    if (saveMaterialsButton && jobMaterialRows) {
      saveMaterialsButton.addEventListener("click", () => {
        persistMaterials();
        notifyAutoSaved();
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
        notifyAutoSaved();
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
        notifyAutoSaved();
      });
    }

    const laborAdjustSign = $("laborAdjustSign");
    if (laborAdjustSign) {
      laborAdjustSign.addEventListener("click", () => {
        const next = (laborAdjustSign.textContent || "+").includes("−") || (laborAdjustSign.textContent || "").includes("-") ? "+" : "−";
        laborAdjustSign.textContent = next;
        liveLaborTotal();
        if (persistLabor()) notifyAutoSaved();
      });
    }
    ["laborRateInput", "laborAdjustInput"].forEach((id) => {
      const input = $(id);
      if (input) input.addEventListener("input", liveLaborTotal);
    });
    const difficultySelect = $("difficultySelect");
    if (difficultySelect) {
      difficultySelect.addEventListener("change", () => {
        if (persistLabor()) notifyAutoSaved();
      });
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
    }

    document.querySelectorAll("[data-folder-amount], [data-folder-adjust], [data-folder-vendor], [data-folder-parts]").forEach((input) => {
      input.addEventListener("input", () => {
        const id = input.dataset.folderAmount || input.dataset.folderAdjust || input.dataset.folderVendor || input.dataset.folderParts;
        if (input.dataset.folderAmount || input.dataset.folderAdjust) refreshFolderSubtotal(id);
      });
    });
    document.querySelectorAll("[data-folder-sign]").forEach((button) => {
      button.addEventListener("click", () => {
        const next = (button.textContent || "+").includes("−") || (button.textContent || "").includes("-") ? "+" : "−";
        button.textContent = next;
        refreshFolderSubtotal(button.dataset.folderSign);
        if (persistFolder()) notifyAutoSaved();
      });
    });

    const createInvoiceButton = $("createInvoiceButton");
    if (createInvoiceButton) {
      createInvoiceButton.addEventListener("click", async () => {
        flushJobAutosave();
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

    const copyCustomerLinkButton = $("copyCustomerLinkButton");
    if (copyCustomerLinkButton) {
      copyCustomerLinkButton.addEventListener("click", async () => {
        const link = copyCustomerLinkButton.dataset.link || customerPortalLink(job);
        if (!link) return;
        try {
          await navigator.clipboard.writeText(link);
          notify("Customer's invoice link copied.");
        } catch {
          // Clipboard blocked (older browser, or not on HTTPS): a prompt still
          // lets the link be copied by hand.
          window.prompt("Copy this link for the customer:", link);
        }
      });
    }

    // Both the filed-invoice card and the bottom of the work order carry one.
    document.querySelectorAll("[data-unsubmit-invoice]").forEach((button) => {
      button.addEventListener("click", () => {
        if (!window.confirm("Unsubmit this invoice? The job reopens clocked out, it leaves the customer's view, and every field unlocks. You file it again with Finish Project.")) return;
        reopenInvoice(job);
      });
    });
  }

  /**
   * Records that worked time was entered or corrected by hand. It is NOT posted
   * to /api/jobs/:id/events — that endpoint only accepts clock_in and clock_out
   * and would reject this — but it rides along in the job body, which the cloud
   * merges into the history as a union. The distinction is deliberate: a hand
   * entry is not a tap, and the audit trail should never claim it was.
   */
  function logTimeEdit(job, action, detail) {
    job.eventHistory = Array.isArray(job.eventHistory) ? job.eventHistory : [];
    job.eventHistory.push({ id: uid(), action, occurredAt: new Date().toISOString(), detail });
  }

  /** The first moment ever worked, which is what the invoice reads. */
  function syncStartedAt(job) {
    const first = workSessions(job)[0];
    if (first) job.startedAt = first.startedAt;
  }

  /**
   * Saves one hand-entered span of work — a date, a clock-in and a clock-out —
   * onto the job. Used by the Done button on each row and by Anya.
   *
   * Every refusal returns a sentence, never a silent no: this is money on a
   * customer's invoice, and a row that looked saved but was not is a day of
   * work billed at zero.
   */
  function commitWorkSession(job, { entryId = "", date, start, end }) {
    if (job.status === "invoiced") {
      return { ok: false, message: "That invoice is filed. Unsubmit it before changing the hours." };
    }
    const existing = entryId
      ? (job.timeEntries || []).find((entry) => entry.id === entryId && !entry.voided)
      : null;
    if (entryId && !existing) {
      return { ok: false, message: "That worked time is no longer on the job." };
    }
    const running = Boolean(existing && !existing.endedAt);

    if (!date) return { ok: false, message: "Pick the date you worked first." };
    if (!start) return { ok: false, message: "Set the clock-in time first." };
    if (!running && !end) return { ok: false, message: "Set the clock-out time first." };

    const startDate = fromDateAndTime(date, start);
    if (!startDate) return { ok: false, message: "That clock-in date and time isn't valid." };

    let endDate = null;
    let crossedMidnight = false;
    if (!running) {
      endDate = fromDateAndTime(date, end);
      if (!endDate) return { ok: false, message: "That clock-out time isn't valid." };
      if (endDate.getTime() <= startDate.getTime()) {
        // A shift that ends earlier in the day than it started is a shift that
        // ran past midnight, not a typo to reject — 10 PM to 1 AM is a night.
        endDate = new Date(endDate.getTime() + 24 * 60 * 60 * 1000);
        crossedMidnight = true;
      }
      if (endDate.getTime() - startDate.getTime() > 24 * 60 * 60 * 1000) {
        return { ok: false, message: "That span is longer than a day. Split it into separate times." };
      }
    }

    // A minute of slack: phone clocks drift, and a time set to "right now"
    // should not be refused for landing a few seconds ahead of Date.now().
    const ceiling = Date.now() + 60_000;
    if (startDate.getTime() > ceiling) {
      return { ok: false, message: "Worked time can't be in the future." };
    }
    if (endDate && endDate.getTime() > ceiling) {
      return { ok: false, message: "That clock-out time is in the future." };
    }

    const startIso = startDate.toISOString();
    const endIso = endDate ? endDate.toISOString() : null;

    // Two spans that overlap bill the same minutes twice.
    const clash = workSessions(job).find((entry) => {
      if (existing && entry.id === existing.id) return false;
      const otherStart = Date.parse(entry.startedAt);
      const otherEnd = entry.endedAt ? Date.parse(entry.endedAt) : Date.now();
      const thisEnd = endDate ? endDate.getTime() : Date.now();
      return startDate.getTime() < otherEnd && thisEnd > otherStart;
    });
    if (clash) {
      return {
        ok: false,
        message: `That overlaps the time already saved for ${spokenSpan(clash.startedAt, clash.endedAt)}.`
      };
    }

    // Done on a row he did not actually change is not a correction. Writing one
    // anyway fills the audit trail with edits that never happened, and pushes a
    // job sync for nothing.
    if (existing && existing.startedAt === startIso && (running || existing.endedAt === endIso)) {
      return { ok: true, message: "That one was already saved.", entryId: existing.id };
    }

    // The details panel autosaves on a debounce; flushing it first keeps a
    // half-typed rate or note from being written back over this save.
    if (typeof flushOpenJobAutosave === "function") flushOpenJobAutosave();
    let saved;
    if (existing) {
      existing.startedAt = startIso;
      if (!running) existing.endedAt = endIso;
      saved = existing;
      logTimeEdit(job, "time_edited", running
        ? `Clock-in moved to ${calendarDate(startIso)} · ${clockTime(startIso)}`
        : spokenSpan(startIso, existing.endedAt));
    } else {
      saved = { id: uid(), kind: "work", startedAt: startIso, endedAt: endIso, voided: false };
      job.timeEntries.push(saved);
      logTimeEdit(job, "time_added", spokenSpan(startIso, endIso));
    }

    // Hand-entered work on a job that was never clocked into leaves it off the
    // clock, not still a draft — that is what enables Finish Project.
    if (job.status === "draft") job.status = "clocked_out";
    syncStartedAt(job);
    if (job.invoice) job.invoice = invoiceDraft(job);
    queueJobSync(job);

    const span = hoursMinutes(
      endDate ? Math.floor((endDate.getTime() - startDate.getTime()) / 1000) : 0
    );
    const message = running
      ? `Clock-in moved to ${clockTime(startIso)}.`
      : `Saved ${clockTime(startIso)} – ${clockTime(endIso)}${crossedMidnight ? " (next day)" : ""} · ${span.hours}h ${String(span.minutes).padStart(2, "0")}m.`;
    return { ok: true, message, entryId: saved.id };
  }

  /**
   * Takes one worked time back off the invoice. The row is tombstoned rather
   * than deleted: the cloud merges timeEntries as a union of ids, so a deleted
   * row would be handed straight back by the next sync and billed again.
   */
  function voidWorkSession(job, entryId) {
    if (job.status === "invoiced") {
      return { ok: false, message: "That invoice is filed. Unsubmit it before changing the hours." };
    }
    const entry = (job.timeEntries || []).find((item) => item.id === entryId && !item.voided);
    if (!entry) return { ok: false, message: "That worked time is no longer on the job." };
    if (!entry.endedAt) {
      return { ok: false, message: "That one is still running. Clock out first." };
    }
    if (typeof flushOpenJobAutosave === "function") flushOpenJobAutosave();
    const span = spokenSpan(entry.startedAt, entry.endedAt);
    entry.voided = true;
    logTimeEdit(job, "time_removed", span);
    syncStartedAt(job);
    if (job.invoice) job.invoice = invoiceDraft(job);
    queueJobSync(job);
    return { ok: true, message: `Removed ${span} from the invoice.` };
  }

  function timerAction(job, action, { skipConfirm = false } = {}) {
    const now = new Date().toISOString();
    // Work spans only: a job carried over from the break era can still hold a
    // dangling break entry, and closing that one instead would leave the real
    // billable span running forever.
    const openEntry = job.timeEntries.find((entry) => entry.kind === "work" && !entry.endedAt);
    const onTheClock = job.status === "in_progress";

    if (action === "clock_in" && (job.status === "draft" || job.status === "clocked_out")) {
      job.status = "in_progress";
      // startedAt is the first time this job was ever worked, not the latest
      // clock in — the invoice and its editable "clocked in" field read it.
      if (!job.startedAt) job.startedAt = now;
      job.timeEntries.push({ id: uid(), kind: "work", startedAt: now, endedAt: null });
      // Persist this single event immediately, before anything else.
      logClockEvent(job, "clock_in", now);
      notify("Clocked in. Billable time is running.");
    } else if (action === "clock_out" && onTheClock) {
      if (openEntry) openEntry.endedAt = now;
      job.status = "clocked_out";
      logClockEvent(job, "clock_out", now);
      notify("Clocked out. Billable time is stopped — clock back in whenever.");
    } else if (action === "finish" && (onTheClock || job.status === "clocked_out")) {
      // Voice already read the job back and heard an explicit yes.
      if (!skipConfirm && !window.confirm("Finish this project, close the timer, and file the invoice for payment?")) return;
      // Finishing while still on the clock is also a clock out, and it is
      // recorded as its own durable event before the invoice is filed.
      if (onTheClock) {
        if (openEntry) openEntry.endedAt = now;
        logClockEvent(job, "clock_out", now);
      }
      job.status = "completed";
      job.endedAt = now;
      job.eventHistory = Array.isArray(job.eventHistory) ? job.eventHistory : [];
      job.eventHistory.push({ id: uid(), action: "finished", occurredAt: now });
      const invoice = upsertInvoice(job);
      renderJob();
      notify(`${invoice.invoiceNumber} filed — share it to get paid.`);
      return;
    } else {
      notify("That timer action is not available right now.", true);
      return;
    }

    queueJobSync(job);
    renderJob();
  }

  function updateLiveTimer() {
    const job = selectedJobId ? findJob(selectedJobId) : null;
    if (!job) return;
    const work = $("liveWorkTimer");
    const summary = $("billableSummary");
    if (work) work.textContent = duration(billableSeconds(job));
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
      scheduleJobDraftAutosave();
    });
    materialRows.appendChild(row);
  }

  /** Asides captured while talking the current sheet in, newest last. */
  let agentNotes = [];

  function loadJobDraft() {
    try {
      return JSON.parse(localStorage.getItem(NEW_JOB_DRAFT_STORAGE) || "null");
    } catch {
      return null;
    }
  }

  function clearJobDraft() {
    try {
      localStorage.removeItem(NEW_JOB_DRAFT_STORAGE);
    } catch {
      // Ignore storage errors clearing the draft.
    }
  }

  function saveJobDraft() {
    const data = new FormData(jobForm);
    const materials = [...materialRows.querySelectorAll(".material-row")]
      .map((row) => String(row.querySelector('[name="materialDescription"]')?.value || "").trim())
      .filter(Boolean);
    const draft = {
      customerName: String(data.get("customerName") || ""),
      customerPhone: String(data.get("customerPhone") || ""),
      customerEmail: String(data.get("customerEmail") || ""),
      vehicleYear: String(data.get("vehicleYear") || ""),
      vehicleMake: String(data.get("vehicleMake") || ""),
      vehicleModel: String(data.get("vehicleModel") || ""),
      vehiclePlate: String(data.get("vehiclePlate") || ""),
      agreedWork: String(data.get("agreedWork") || ""),
      laborRate: String(data.get("laborRate") || ""),
      materials,
      // Things he mentioned in passing that are not form fields. They ride on
      // the draft rather than in a variable so a stopped conversation, or a
      // phone that locked in his pocket, does not lose them.
      agentNotes
    };
    const isEmpty = Object.values(draft).every((value) =>
      Array.isArray(value) ? value.length === 0 : !value);
    if (isEmpty) {
      clearJobDraft();
      return;
    }
    try {
      localStorage.setItem(NEW_JOB_DRAFT_STORAGE, JSON.stringify(draft));
      setJobDraftState("draft");
      notifyAutoSaved();
    } catch {
      // Job list storage may be full; the explicit Create job save still works.
    }
  }

  let jobDraftAutosaveTimer = null;
  function scheduleJobDraftAutosave() {
    setJobDraftState("typing");
    clearTimeout(jobDraftAutosaveTimer);
    jobDraftAutosaveTimer = setTimeout(saveJobDraft, 500);
  }

  /**
   * The one place the New Job sheet says out loud whether the work is safe.
   * A toast disappears; this stays put next to the Save button so the answer
   * is on screen at the moment the question gets asked.
   */
  function setJobDraftState(mode) {
    const pill = $("jobDraftState");
    if (!pill) return;
    const copy = {
      idle: "Auto-saving",
      typing: "Saving…",
      draft: "Draft saved",
      saved: "Saved"
    };
    pill.textContent = copy[mode] || copy.idle;
    pill.dataset.state = mode;
  }

  // Every field the ledger cannot do without. `required` stays on the markup
  // for assistive tech, but the form is `novalidate` so this list — not a
  // native bubble pinned to a field scrolled out of the sheet — is what the
  // mechanic actually reads when a tap on Save appears to do nothing.
  const REQUIRED_JOB_FIELDS = [
    ["customerName", "customer name"],
    ["vehicleMake", "vehicle make"],
    ["vehicleModel", "vehicle model"],
    ["agreedWork", "work description"],
    ["laborRate", "labor rate"]
  ];

  function showJobFormError(message) {
    const box = $("jobFormError");
    box.textContent = message;
    box.classList.remove("hidden");
  }

  function focusJobField(name) {
    const field = jobForm.querySelector(`[name="${name}"]`);
    if (!field) return;
    field.focus?.();
    field.scrollIntoView?.({ block: "center" });
  }

  function applyJobDraft(draft) {
    setField(jobForm, "customerName", draft.customerName || "");
    setField(jobForm, "customerPhone", draft.customerPhone || "");
    setField(jobForm, "customerEmail", draft.customerEmail || "");
    setField(jobForm, "vehicleYear", draft.vehicleYear || "");
    setField(jobForm, "vehicleMake", draft.vehicleMake || "");
    setField(jobForm, "vehicleModel", draft.vehicleModel || "");
    setField(jobForm, "vehiclePlate", draft.vehiclePlate || "");
    setField(jobForm, "agreedWork", draft.agreedWork || "");
    setField(jobForm, "laborRate", draft.laborRate || "");
    agentNotes = Array.isArray(draft.agentNotes) ? [...draft.agentNotes] : [];
    materialRows.innerHTML = "";
    const materials = Array.isArray(draft.materials) && draft.materials.length ? draft.materials : [""];
    materials.forEach((description) => addMaterialRow({ description }));
  }

  function openJobDialog() {
    jobForm.reset();
    agentNotes = [];
    const draft = loadJobDraft();
    if (draft) {
      applyJobDraft(draft);
      notify("Restored your unsaved job draft.");
    } else {
      materialRows.innerHTML = "";
      addMaterialRow();
    }
    $("jobFormError").classList.add("hidden");
    setJobDraftState(draft ? "draft" : "idle");
    renderCarPicker();
    jobDialog.showModal();
  }

  async function openNewJob() {
    if (await ensureCloudSync()) openJobDialog();
  }

  function closeJobDialog() {
    clearTimeout(jobDraftAutosaveTimer);
    saveJobDraft();
    jobDialog.close();
  }

  jobForm.addEventListener("input", scheduleJobDraftAutosave);
  jobForm.addEventListener("change", scheduleJobDraftAutosave);

  jobForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(jobForm);

    const missing = REQUIRED_JOB_FIELDS.filter(([name]) => !String(data.get(name) || "").trim());
    if (missing.length) {
      const names = missing.map(([, label]) => label);
      showJobFormError(
        names.length === 1
          ? `Add the ${names[0]} and the job will save.`
          : `Add the ${names.slice(0, -1).join(", ")} and ${names.at(-1)} and the job will save.`
      );
      focusJobField(missing[0][0]);
      // Nothing is lost while the missing field is filled in.
      saveJobDraft();
      return;
    }

    const laborRateCents = parseCents(data.get("laborRate"));
    if (!laborRateCents) {
      showJobFormError("Enter a labor rate greater than zero.");
      focusJobField("laborRate");
      saveJobDraft();
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
      // Kept on the record for calling and texting the customer. It is not
      // published anywhere: the portal groups by name + phone so two people
      // who share a name stay apart, but never sends the number to the page.
      customerPhone: String(data.get("customerPhone") || "").trim(),
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
    // Written to this phone before anything else can throw or navigate away.
    queueJobSync(job);
    clearTimeout(jobDraftAutosaveTimer);
    clearJobDraft();
    setJobDraftState("saved");
    jobDialog.close();
    notify(`${job.customerName} saved · ${job.id}`);
    openJob(job.id);
    void confirmJobSaved(job);
  });

  /**
   * Says where the new customer actually ended up. "Created" on its own is the
   * claim that caused the distrust: it was true of this phone's storage and
   * said nothing about the cloud, so a job that never uploaded still looked
   * filed right up until the phone forgot it.
   */
  async function confirmJobSaved(job) {
    try {
      await flushSyncQueue();
    } catch {
      // The queue state below is the honest answer either way.
    }
    if (pendingJobIds().includes(job.id)) {
      notify(`${job.customerName} is saved on this phone. It uploads by itself when service returns.`);
      return;
    }
    notify(`${job.customerName} saved to the cloud ledger · ${job.id}`);
  }

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
      notify("Hit Finish Project first so labor is closed, then the invoice files automatically.", true);
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
      <div class="box"><span class="eyebrow">Bill to</span><br><strong>${escapeHtml(job.customerName)}</strong><br>${escapeHtml(job.customerPhone || "Phone not provided")}<br>${escapeHtml(job.customerEmail || "Email not provided")}</div>
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
      `You can also open this invoice any time here: ${customerPortalLink(job) || PORTAL_URL}`,
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

  // ------------------------------------------------- scripted voice interviews
  // Receipts and the closeout are still fixed question lists: the order is the
  // audit trail, and a model free to improvise one would skip a photo and then
  // cheerfully confirm a receipt it never captured. Opening a job is the part
  // that became a conversation — see the shop agent further down.
  //
  // Either way every answer lands in the same input a thumb would use, so an
  // interrupted run leaves a normal half-filled form instead of a dead end.

  const voiceConfig = window.VoiceConfig || {};

  function setField(form, name, value) {
    const input = form.querySelector(`[name="${name}"]`);
    if (!input) return;
    input.value = value ?? "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Fills {token} placeholders in the shorter runtime prompts. */
  function fillPrompt(template, values) {
    return String(template || "").replace(/\{(\w+)\}/g, (_, key) =>
      values[key] === null || values[key] === undefined ? "" : String(values[key]));
  }

  /** "autozone spark plugs" -> { vendor: "AutoZone", parts: "spark plugs" } */
  function splitVendorAndParts(text) {
    const raw = String(text || "").trim().replace(/^(it'?s\s+|from\s+|this is\s+)+/i, "");
    if (!raw) return { vendor: "", parts: "" };

    const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const candidates = [
      ...(voiceConfig.vendors || []),
      ...knownVendorSpellings(findJob(receiptJobId))
    ];
    // Longest name first so "Advance Auto Parts" wins over a bare "Advance".
    for (const vendor of candidates.sort((a, b) => b.length - a.length)) {
      const key = normalize(vendor);
      if (!key) continue;
      const flattened = normalize(raw);
      if (!flattened.startsWith(key)) continue;
      // Walk the raw string to find where the vendor name actually ends.
      let seen = "";
      let index = 0;
      while (index < raw.length && normalize(seen) !== key) {
        seen += raw[index];
        index += 1;
      }
      const rest = raw
        .slice(index)
        .replace(/^\s*(and|for|,|-)\s*/i, "")
        .trim();
      return { vendor: canonicalizeVendor(vendor), parts: rest };
    }

    // No known vendor matched — treat the first word as the shop name and let
    // the read-back catch it if that guess was wrong.
    const parts = raw.split(/\s+/);
    if (parts.length === 1) return { vendor: canonicalizeVendor(raw), parts: "" };
    return {
      vendor: canonicalizeVendor(parts[0]),
      parts: parts.slice(1).join(" ").replace(/^(and|for)\s+/i, "").trim()
    };
  }

  function voiceUnavailable() {
    if (window.GMMVoice?.supported()) return false;
    notify("This browser can't do voice. Fill the job in by hand.", true);
    return true;
  }

  // ------------------------------------------------------------- shop agent
  // The agent never touches app state directly. It writes through the same
  // inputs and the same submit path a thumb uses, so a conversation that stops
  // halfway leaves a normal half-filled sheet, and every validation, autosave
  // and sync rule that already exists still runs exactly once.

  /**
   * Every distinct customer-and-vehicle pair already on the ledger, newest
   * first. Feeds both the tap-a-car picker and the agent's matching, so "the
   * Suburban" resolves to a real record instead of a fresh interview.
   */
  function knownVehicles() {
    const seen = new Set();
    const cars = [];
    const newestFirst = [...state.jobs].sort((a, b) =>
      String(b.createdAt).localeCompare(String(a.createdAt)));
    for (const job of newestFirst) {
      const car = {
        customerName: job.customerName || "",
        customerPhone: job.customerPhone || "",
        customerEmail: job.customerEmail || "",
        vehicleYear: job.vehicleYear || "",
        vehicleMake: job.vehicleMake || "",
        vehicleModel: job.vehicleModel || "",
        vehiclePlate: job.vehiclePlate || ""
      };
      if (!car.customerName && !car.vehicleMake) continue;
      const key = [car.customerName, car.vehicleYear, car.vehicleMake, car.vehicleModel]
        .join("|").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cars.push(car);
      if (cars.length >= 40) break;
    }
    return cars;
  }

  function renderCarPicker() {
    const picker = $("carPicker");
    const chips = $("carChips");
    if (!picker || !chips) return;
    const cars = knownVehicles();
    picker.classList.toggle("hidden", !cars.length);
    chips.innerHTML = cars.map((car, index) => `
      <button class="car-chip" type="button" data-car-index="${index}">
        <strong>${escapeHtml([car.vehicleYear, car.vehicleMake, car.vehicleModel].filter(Boolean).join(" ") || "Vehicle not recorded")}</strong>
        <span>${escapeHtml(car.customerName || "Owner not recorded")}${car.vehiclePlate ? ` · ${escapeHtml(car.vehiclePlate)}` : ""}</span>
      </button>`).join("");
    // Bound once per render, on the container: re-binding per chip on an
    // innerHTML swap is how a tap ends up firing twice.
    chips.onclick = (event) => {
      const chip = event.target.closest("[data-car-index]");
      if (!chip) return;
      const car = cars[Number(chip.dataset.carIndex)];
      if (!car) return;
      Object.entries(car).forEach(([name, value]) => {
        if (value) setField(jobForm, name, value);
      });
      notify(`${car.customerName || "Vehicle"} filled in. Add the work and the rate.`);
    };
  }

  /** What the sheet already holds, so the agent does not re-ask for it. */
  function filledFields() {
    const filled = {};
    jobForm.querySelectorAll("[name]").forEach((input) => {
      const name = input.getAttribute("name");
      const text = String(input.value || "").trim();
      if (name && text && !(name in filled)) filled[name] = text;
    });
    return filled;
  }

  /**
   * The job Anya is standing in front of, or null when none is open.
   *
   * NOT named `openJob` — that is already the router that opens a work order,
   * and a second function declaration of the same name in this scope silently
   * replaces it. Everything still boots; job cards just stop opening.
   */
  function agentJob() {
    const job = findJob(selectedJobId);
    if (!job) return null;
    return $("jobView").classList.contains("hidden") ? null : job;
  }

  /**
   * Runs one of Anya's job-changing tools and reports what actually happened.
   *
   * Every branch returns a sentence she can say out loud, and `ok: false` on
   * anything refused — she reports the result, so a refusal that came back
   * looking like a success is her telling him the clock is running when it is
   * not, and that is money off a customer's invoice.
   */
  function runAction(name, input = {}) {
    const job = agentJob();
    if (!job) {
      return { ok: false, message: "No job is open on his screen, so nothing could be changed." };
    }
    if (job.status === "invoiced") {
      return { ok: false, message: "That job's invoice is already filed and locked. He has to unsubmit it first." };
    }

    if (name === "clock_in") {
      if (job.status === "in_progress") return { ok: false, message: "He is already on the clock." };
      timerAction(job, "clock_in");
      void renderJob();
      return { ok: true, message: "Clocked in. Billable time is running." };
    }

    if (name === "clock_out") {
      if (job.status !== "in_progress") return { ok: false, message: "He is not on the clock right now." };
      timerAction(job, "clock_out");
      void renderJob();
      return { ok: true, message: "Clocked out. Billable time is stopped." };
    }

    if (name === "log_worked_time") {
      // Same commit path as the Done button on the time sheet, refusals and
      // all — she reports what actually happened, never a save that was not.
      const result = commitWorkSession(job, {
        date: String(input.date || ""),
        start: String(input.start || ""),
        end: String(input.end || "")
      });
      if (result.ok) void renderJob();
      return result.ok
        ? { ok: true, message: result.message }
        : { ok: false, message: result.message };
    }

    if (name === "add_note") {
      const note = String(input.note || "").trim();
      if (!note) return { ok: false, message: "There was no note to add." };
      // Appended, never replaced: these print on the invoice and an earlier
      // observation is not superseded by a later one.
      job.suggestions = [job.suggestions, note].map((part) => String(part || "").trim())
        .filter(Boolean).join("\n");
      queueJobSync(job);
      void renderJob();
      return { ok: true, message: "Added to the notes that print on the invoice." };
    }

    if (name === "set_agreed_work") {
      const work = String(input.work || "").trim();
      // Agreed work is what the invoice bills against; a blank is a mistake,
      // never an instruction to erase the scope.
      if (!work) return { ok: false, message: "No work description came through, so nothing was changed." };
      job.agreedWork = work;
      queueJobSync(job);
      void renderJob();
      return { ok: true, message: "Agreed work updated." };
    }

    return { ok: false, message: "That isn't something this app can do." };
  }

  window.GMMAgentBridge = {
    notify,
    knownVehicles,
    filledFields,
    runAction,
    /** Something he mentioned that is not a field. Kept until the job exists. */
    stashNote: (text) => {
      const note = String(text || "").trim();
      if (!note || agentNotes.includes(note)) return;
      agentNotes.push(note);
      scheduleJobDraftAutosave();
    },
    setField: (name, value) => setField(jobForm, name, value),
    setMaterials: (list) => {
      materialRows.innerHTML = "";
      list.forEach((description) => addMaterialRow({ description }));
      if (!list.length) addMaterialRow();
      scheduleJobDraftAutosave();
    },
    /**
     * Submits through the real form. Returns false when validation refused it,
     * so Anya says what is wrong instead of claiming a job she never made.
     * Notes gathered while talking, and a clock-in she was asked for, are
     * applied to the job the submit just created.
     */
    submitJob: ({ clockIn = false } = {}) => {
      const before = state.jobs.length;
      jobForm.requestSubmit();
      if (state.jobs.length <= before) return false;
      const job = state.jobs[state.jobs.length - 1];
      const note = agentNotes.join("\n").trim();
      if (note) {
        job.suggestions = [job.suggestions, note].map((part) => String(part || "").trim())
          .filter(Boolean).join("\n");
        queueJobSync(job);
      }
      if (clockIn && job.status === "draft") timerAction(job, "clock_in");
      agentNotes = [];
      return true;
    },
    /** What Anya is told about the job before she answers anything. */
    jobContext: () => {
      const job = agentJob();
      if (job) {
        return {
          // Her date arithmetic ("yesterday", "Tuesday") has to run off the
          // phone's calendar day, not the Worker's UTC one.
          today: toDateInputValue(new Date().toISOString()),
          customerName: job.customerName || "",
          vehicleYear: job.vehicleYear || "",
          vehicleMake: job.vehicleMake || "",
          vehicleModel: job.vehicleModel || "",
          status: job.status || "",
          agreedWork: job.agreedWork || "",
          suggestions: job.suggestions || ""
        };
      }
      // No job open, but the sheet may be half-filled — enough for her to know
      // which vehicle the question is about, without any of the tools working.
      const filled = filledFields();
      if (!filled.vehicleMake && !filled.customerName) return null;
      return {
        customerName: filled.customerName || "",
        vehicleYear: filled.vehicleYear || "",
        vehicleMake: filled.vehicleMake || "",
        vehicleModel: filled.vehicleModel || "",
        status: "",
        agreedWork: filled.agreedWork || "",
        suggestions: ""
      };
    },
    /**
     * The deterministic finish check for the job on screen — every missing box,
     * computed here so Anya reports facts, not a guess. Null when no job is open.
     */
    invoiceReview: () => {
      const job = agentJob();
      return job ? buildInvoiceReview(job) : null;
    }
  };

  /** Waits for File All Receipts to drain, so the invoice sees the parts total. */
  function waitForReceiptsFiled() {
    return new Promise((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (!draftReceipts.length || Date.now() - started > 15000) {
          clearInterval(poll);
          resolve();
        }
      }, 150);
    });
  }

  /**
   * The receipt loop, shared by the standalone Receipts-by-voice button and the
   * closeout — the job is finished once, so the questions must be worded and
   * ordered the same either way. The loop is procedural; only its wording is
   * configured.
   */
  async function runReceiptInterview(job, { speak, ask, confirm, capturePhoto }) {
      const copy = voiceConfig.receipts || {};
      openReceiptDialog(job.id);
      // The receipt sheet is modal and was opened after the panel, so without
      // this the panel sits under it and none of its buttons can be tapped.
      window.GMMVoice.raise();
      const anyReceipts = await ask({
        name: "hasReceipts",
        label: "the receipt answer",
        prompt: copy.ask,
        parse: window.GMMVoice.parse.yesNo
      });
      if (anyReceipts !== true) {
        await speak(copy.none);
        closeReceiptDialog();
        return 0;
      }

      let filed = 0;
      while (true) {
        await speak(copy.add);
        await capturePhoto(copy.photoButton, async (files) => {
          await ingestReceiptFiles(files, { autoStage: false });
          if (!pendingCapture) throw new Error("That photo did not save. Try another.");
        });

        let vendor = "";
        let parts = "";
        for (let attempt = 0; attempt < 3 && !vendor; attempt += 1) {
          const heard = await ask({
            name: "receiptFor",
            label: "the receipt details",
            prompt: attempt === 0 ? copy.what : copy.whatRetry
          });
          const split = splitVendorAndParts(heard);
          vendor = split.vendor;
          parts = split.parts;
        }
        if (!parts) {
          parts = await ask({
            name: "receiptParts",
            label: "the parts",
            // A receipt is usually a list read off the paper, with pauses.
            patience: "long",
            prompt: fillPrompt(copy.parts, { vendor }),
            parse: window.GMMVoice.parse.sentence
          });
        }

        const amountCents = await ask({
          name: "amount",
          label: "the receipt amount",
          prompt: () => fillPrompt(copy.amount, { vendor, parts }),
          parse: (heard) => window.GMMVoice.parse.money(heard, "amount")
        });

        setField(receiptForm, "vendor", vendor);
        setField(receiptForm, "receiptParts", parts);
        setField(receiptForm, "amount", (amountCents / 100).toFixed(2));

        const correct = await confirm(
          fillPrompt(copy.confirm, { vendor, parts, amount: money(amountCents) })
        );
        if (!correct) {
          await speak(copy.redo);
          continue;
        }

        receiptForm.requestSubmit();
        filed += 1;

        const more = await ask({
          name: "more",
          label: "the next answer",
          prompt: copy.more,
          parse: window.GMMVoice.parse.yesNo
        });
        if (more !== true) break;
      }

      if (filed) {
        await speak(fillPrompt(copy.filing, { count: filed, s: filed === 1 ? "" : "s" }));
        $("fileAllReceiptsButton").click();
        await waitForReceiptsFiled();
      }
      closeReceiptDialog();
      return filed;
  }

  async function voiceReceipts(job) {
    if (voiceUnavailable()) return;
    await window.GMMVoice.run((helpers) => runReceiptInterview(job, helpers));
    await renderJob();
  }

  async function voiceFinishJob(job) {
    if (voiceUnavailable()) return;
    const copy = voiceConfig.closeout || {};

    await window.GMMVoice.run(async (helpers) => {
      const { speak, ask, confirm } = helpers;
      // Receipts first — they roll into the parts total the invoice reads back.
      await runReceiptInterview(job, helpers);

      const recommendations = await ask({
        name: "suggestions",
        label: "the recommendations",
        optional: true,
        // Open-ended, and the answer prints on the invoice — worth waiting out
        // a thinking pause rather than filing half a sentence.
        patience: "long",
        prompt: copy.recommendations,
        parse: window.GMMVoice.parse.sentence
      });
      if (recommendations) {
        const input = $("suggestionsInput");
        if (input) {
          input.value = recommendations;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        job.suggestions = recommendations;
        job.updatedAt = new Date().toISOString();
        queueJobSync(job);
      }

      const blocked = jobReadyForInvoice(job);
      if (blocked) {
        await speak(blocked);
        return false;
      }

      const draft = invoiceDraft(job);
      const okay = await confirm(fillPrompt(copy.invoice, {
        subject: vehicleName(job) || job.id,
        labor: money(draft.laborCents),
        parts: money(draft.materialsCents),
        total: money(draft.totalCents)
      }));
      if (!okay) {
        await speak(copy.declined);
        return false;
      }

      timerAction(job, "finish", { skipConfirm: true });
      await speak(copy.filed);
      return true;
    });
    await renderJob();
  }

  $("homeButton").addEventListener("click", showBoard);
  $("newJobButton").addEventListener("click", openNewJob);

  // The job list stays the default. Grouping by customer is a second way to
  // read the same ledger, never a step between his thumb and a clock-in.
  for (const [id, mode] of [["boardModeJobs", "jobs"], ["boardModeCustomers", "customer"]]) {
    const button = $(id);
    if (!button) continue;
    button.addEventListener("click", () => {
      if (state.boardMode === mode) return;
      state.boardMode = mode;
      renderBoard();
    });
  }

  /**
   * Every agent call goes through here rather than touching `window.GMMAgent`
   * directly. The agent is a separate script, and a phone running a stale
   * service-worker shell can open this page without it — reaching for it
   * unguarded took the whole app down at boot rather than losing one button.
   * Clocking in has to keep working when the talking does not.
   */
  const agent = () => window.GMMAgent || null;

  $("talkItInButton").addEventListener("click", async () => {
    // Unlock audio inside the tap itself — iOS ignores a later attempt.
    window.GMMVoice?.prime();
    await agent()?.talkItIn();
    renderCarPicker();
  });

  $("shopAgentButton").addEventListener("click", () => agent()?.openChat());

  /**
   * Both agent entry points stay hidden until the Worker says the key is set.
   * A button that always answers "not configured" teaches people to stop
   * tapping it, and they do not start again once it works.
   */
  void Promise.resolve(agent()?.available() ?? false).then((ready) => {
    $("shopAgentButton").classList.toggle("hidden", !ready);
    $("talkRow").classList.toggle("hidden", !ready);
  });
  /**
   * The button Thomas asked for: one tap, anywhere in the app, that writes
   * everything down and says plainly whether it made it off the phone. It is
   * deliberately not the same as "Sync now" — that pulls the cloud's copy down
   * first, which is the wrong move when the thing you are worried about is the
   * work sitting on this phone.
   */
  $("saveAllButton").addEventListener("click", async () => {
    const button = $("saveAllButton");
    button.disabled = true;
    try {
      // Anything half-typed in the open New Job sheet goes down first.
      if (jobDialog.open) {
        clearTimeout(jobDraftAutosaveTimer);
        saveJobDraft();
      }
      saveState();
      await flushSyncQueue();
      const waiting =
        pendingJobIds().length + pendingReceipts().length +
        pendingDeletes().length + pendingClockEvents().length;
      notify(waiting
        ? `Saved on this phone. ${waiting} change${waiting === 1 ? "" : "s"} still uploading.`
        : `Everything saved · ${state.jobs.length} job${state.jobs.length === 1 ? "" : "s"} in the cloud ledger.`);
    } catch (error) {
      notify(
        error instanceof Error
          ? `Saved on this phone, but the cloud did not answer: ${error.message}`
          : "Saved on this phone; the cloud did not answer.",
        true
      );
    } finally {
      button.disabled = false;
    }
  });

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
  window.addEventListener("offline", () => setSyncStatus("pending"));

  setInterval(updateLiveTimer, 1000);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }

  async function initialize() {
    saveState();
    try {
      await syncFromCloud();
    } catch (error) {
      setSyncStatus("error");
      notify(error instanceof Error ? error.message : "Cloud sync could not connect.", true);
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
