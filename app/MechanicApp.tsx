"use client";

import {
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { JobRecord, MaterialRecord } from "../db/jobs";

type JobStatus = JobRecord["status"];
type TimerAction = "clock_in" | "break_start" | "break_end" | "clock_out";
type MaterialDraft = {
  id: string;
  description: string;
  quantity: string;
  unitCost: string;
};

type NewJobDraft = {
  customerName: string;
  customerEmail: string;
  vehicleYear: string;
  vehicleMake: string;
  vehicleModel: string;
  vehiclePlate: string;
  laborRate: string;
  agreedWork: string;
  materials: MaterialDraft[];
};

const initialDraft = (): NewJobDraft => ({
  customerName: "",
  customerEmail: "",
  vehicleYear: "",
  vehicleMake: "",
  vehicleModel: "",
  vehiclePlate: "",
  laborRate: "",
  agreedWork: "",
  materials: [
    {
      id: crypto.randomUUID(),
      description: "",
      quantity: "1",
      unitCost: "",
    },
  ],
});

const statusCopy: Record<JobStatus, string> = {
  draft: "Ready",
  in_progress: "On the clock",
  on_break: "On break",
  completed: "Clocked out",
  invoiced: "Invoice ready",
};

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || "The request could not be completed.");
  }
  return payload;
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function duration(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remaining = safe % 60;
  return [hours, minutes, remaining]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function shortDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function clockTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function calendarDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function liveSeconds(job: JobRecord, kind: "work" | "break", now: number) {
  return job.timeEntries
    .filter((entry) => entry.kind === kind)
    .reduce((total, entry) => {
      const start = Date.parse(entry.startedAt);
      const end = entry.endedAt ? Date.parse(entry.endedAt) : now;
      return total + Math.max(0, Math.floor((end - start) / 1000));
    }, 0);
}

function vehicleName(job: JobRecord) {
  return [job.vehicleYear, job.vehicleMake, job.vehicleModel]
    .filter(Boolean)
    .join(" ");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function invoiceHtml(
  job: JobRecord,
  receiptImages: { filename: string; dataUrl: string }[],
) {
  if (!job.invoice) return "";
  const laborHours = job.workSeconds / 3600;
  const materialRows = job.materials
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(item.description)}</td>
          <td>${item.quantity}</td>
          <td>${money(item.unitCostCents)}</td>
          <td>${money(item.quantity * item.unitCostCents)}</td>
        </tr>`,
    )
    .join("");
  const receiptPages = receiptImages
    .map(
      (receipt, index) => `
        <section class="receipt-page">
          <p class="eyebrow">Receipt ${index + 1} of ${receiptImages.length}</p>
          <h2>${escapeHtml(receipt.filename)}</h2>
          <img src="${receipt.dataUrl}" alt="Receipt ${index + 1}">
        </section>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(job.invoice.invoiceNumber)} — Gold Mobile Mechanic</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 40px; color: #171717; font: 14px/1.5 Arial, sans-serif; }
    main, .receipt-page { max-width: 820px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; border-bottom: 4px solid #b48624; padding-bottom: 24px; }
    h1 { margin: 0; font-size: 30px; letter-spacing: -.04em; }
    h2 { margin: 8px 0 20px; }
    .gold { color: #9d7219; }
    .eyebrow { text-transform: uppercase; letter-spacing: .16em; font-weight: 700; color: #7a5a18; }
    .meta { text-align: right; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 30px 0; }
    .box { border: 1px solid #ddd; border-radius: 10px; padding: 16px; }
    table { width: 100%; border-collapse: collapse; margin: 24px 0; }
    th, td { border-bottom: 1px solid #ddd; padding: 12px 8px; text-align: left; }
    th:last-child, td:last-child { text-align: right; }
    .totals { margin-left: auto; width: 320px; }
    .totals div { display: flex; justify-content: space-between; padding: 8px 0; }
    .total { border-top: 2px solid #171717; font-size: 20px; font-weight: 800; }
    .notes { margin-top: 36px; white-space: pre-wrap; }
    .receipt-page { break-before: page; padding-top: 24px; }
    .receipt-page img { max-width: 100%; max-height: 930px; object-fit: contain; border: 1px solid #ddd; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <p class="eyebrow">Gold Mobile Mechanic</p>
        <h1>Service <span class="gold">Invoice</span></h1>
      </div>
      <div class="meta">
        <strong>${escapeHtml(job.invoice.invoiceNumber)}</strong><br>
        ${calendarDate(job.invoice.createdAt)}<br>
        Job ${escapeHtml(job.id)}
      </div>
    </header>
    <div class="grid">
      <div class="box">
        <span class="eyebrow">Bill to</span><br>
        <strong>${escapeHtml(job.customerName)}</strong><br>
        ${escapeHtml(job.customerEmail || "Email not provided")}
      </div>
      <div class="box">
        <span class="eyebrow">Vehicle</span><br>
        <strong>${escapeHtml(vehicleName(job))}</strong><br>
        ${escapeHtml(job.vehiclePlate || "No plate recorded")}
      </div>
    </div>
    <div class="box">
      <span class="eyebrow">Agreed work</span>
      <p>${escapeHtml(job.agreedWork)}</p>
    </div>
    <table>
      <thead><tr><th>Service / material</th><th>Qty / hours</th><th>Rate</th><th>Amount</th></tr></thead>
      <tbody>
        <tr>
          <td>Mobile mechanic labor</td>
          <td>${laborHours.toFixed(2)} hrs</td>
          <td>${money(job.laborRateCents)}/hr</td>
          <td>${money(job.invoice.laborCents)}</td>
        </tr>
        ${materialRows}
      </tbody>
    </table>
    <div class="totals">
      <div><span>Labor</span><strong>${money(job.invoice.laborCents)}</strong></div>
      <div><span>Materials</span><strong>${money(job.invoice.materialsCents)}</strong></div>
      <div class="total"><span>Total</span><span>${money(job.invoice.totalCents)}</span></div>
    </div>
    <div class="notes box">
      <span class="eyebrow">Mechanic's suggestions</span>
      <p>${escapeHtml(job.suggestions || "No additional suggestions.")}</p>
    </div>
    <p>${job.receipts.length} receipt${job.receipts.length === 1 ? "" : "s"} filed with this invoice.</p>
  </main>
  ${receiptPages}
</body>
</html>`;
}

export function MechanicApp() {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewJob, setShowNewJob] = useState(false);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const selected = jobs.find((job) => job.id === selectedId) ?? null;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    requestJson<{ jobs: JobRecord[] }>("/api/jobs")
      .then((payload) => {
        if (!cancelled) setJobs(payload.jobs);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error ? loadError.message : "Could not load jobs.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function replaceJob(job: JobRecord) {
    setJobs((current) => {
      const exists = current.some((item) => item.id === job.id);
      if (!exists) return [job, ...current];
      return current.map((item) => (item.id === job.id ? job : item));
    });
  }

  async function runTimer(action: TimerAction) {
    if (!selected) return;
    const actionLabel = {
      clock_in: "clocking in",
      break_start: "starting break",
      break_end: "ending break",
      clock_out: "clocking out",
    }[action];
    setBusy(action);
    setError(null);
    try {
      const payload = await requestJson<{ job: JobRecord }>(
        `/api/jobs/${encodeURIComponent(selected.id)}/timer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      replaceJob(payload.job);
      setNotice(
        action === "clock_out"
          ? "Job clocked out. Review the receipts to unlock the invoice."
          : `Done ${actionLabel}.`,
      );
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Timer update failed.");
    } finally {
      setBusy(null);
    }
  }

  async function patchJob(changes: Record<string, unknown>, success?: string) {
    if (!selected) return null;
    setBusy("save");
    setError(null);
    try {
      const payload = await requestJson<{ job: JobRecord }>(
        `/api/jobs/${encodeURIComponent(selected.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(changes),
        },
      );
      replaceJob(payload.job);
      if (success) setNotice(success);
      return payload.job;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save changes.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function createInvoice(recipientEmail?: string) {
    if (!selected) return null;
    setBusy("invoice");
    setError(null);
    try {
      const payload = await requestJson<{ job: JobRecord }>(
        `/api/jobs/${encodeURIComponent(selected.id)}/invoice`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ recipientEmail }),
        },
      );
      replaceJob(payload.job);
      setInvoiceOpen(true);
      setNotice("Invoice filed and ready to review.");
      return payload.job;
    } catch (invoiceError) {
      setError(invoiceError instanceof Error ? invoiceError.message : "Could not create invoice.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  const stats = useMemo(() => {
    const active = jobs.filter((job) =>
      ["in_progress", "on_break"].includes(job.status),
    ).length;
    const ready = jobs.filter((job) =>
      ["completed", "invoiced"].includes(job.status),
    ).length;
    const invoiced = jobs.reduce(
      (sum, job) => sum + (job.invoice?.totalCents ?? 0),
      0,
    );
    return { active, ready, invoiced };
  }, [jobs]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <button
          className="brand"
          type="button"
          onClick={() => setSelectedId(null)}
          aria-label="Open job board"
        >
          <span className="brand-mark">
            <span>G</span>
          </span>
          <span>
            <strong>Gold</strong>
            <small>Mobile Mechanic</small>
          </span>
        </button>
        <div className="topbar-meta">
          <span className="signal-dot" />
          <span>Private work log</span>
        </div>
      </header>

      {notice ? (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message">
            Close
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
            Close
          </button>
        </div>
      ) : null}

      {selected ? (
        <JobWorkspace
          key={selected.id}
          job={selected}
          now={now}
          busy={busy}
          onBack={() => setSelectedId(null)}
          onTimer={runTimer}
          onPatch={patchJob}
          onJobChange={replaceJob}
          onCreateInvoice={createInvoice}
          onOpenInvoice={() => setInvoiceOpen(true)}
          onError={setError}
          onNotice={setNotice}
          setBusy={setBusy}
        />
      ) : (
        <JobBoard
          jobs={jobs}
          loading={loading}
          stats={stats}
          now={now}
          onSelect={setSelectedId}
          onNew={() => setShowNewJob(true)}
        />
      )}

      {showNewJob ? (
        <NewJobPanel
          onClose={() => setShowNewJob(false)}
          onCreated={(job) => {
            replaceJob(job);
            setShowNewJob(false);
            setSelectedId(job.id);
            setNotice(`${job.id} created. Clock in when you arrive.`);
          }}
          onError={setError}
        />
      ) : null}

      {selected?.invoice && invoiceOpen ? (
        <InvoicePanel
          job={selected}
          onClose={() => setInvoiceOpen(false)}
          onCreateInvoice={createInvoice}
          onNotice={setNotice}
          onError={setError}
        />
      ) : null}
    </main>
  );
}

function JobBoard({
  jobs,
  loading,
  stats,
  now,
  onSelect,
  onNew,
}: {
  jobs: JobRecord[];
  loading: boolean;
  stats: { active: number; ready: number; invoiced: number };
  now: number;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <section className="page">
      <div className="board-heading">
        <div>
          <p className="eyebrow">Field operations</p>
          <h1>Job board</h1>
          <p>Every vehicle, minute, receipt, and invoice in one place.</p>
        </div>
        <button className="button button-gold" type="button" onClick={onNew}>
          <span className="button-plus">+</span>
          New job
        </button>
      </div>

      <div className="stat-grid">
        <article className="stat-card stat-primary">
          <span>Active now</span>
          <strong>{String(stats.active).padStart(2, "0")}</strong>
          <small>{stats.active ? "Clock is running" : "No live timers"}</small>
        </article>
        <article className="stat-card">
          <span>Ready to invoice</span>
          <strong>{String(stats.ready).padStart(2, "0")}</strong>
          <small>Completed jobs</small>
        </article>
        <article className="stat-card">
          <span>Invoices created</span>
          <strong>{money(stats.invoiced)}</strong>
          <small>Recorded total</small>
        </article>
      </div>

      <div className="section-heading">
        <div>
          <p className="eyebrow">Recent work</p>
          <h2>Jobs</h2>
        </div>
        <span className="count-pill">{jobs.length}</span>
      </div>

      {loading ? (
        <div className="job-list" aria-label="Loading jobs">
          {[0, 1, 2].map((item) => (
            <div className="job-card job-card-loading" key={item} />
          ))}
        </div>
      ) : jobs.length ? (
        <div className="job-list">
          {jobs.map((job) => {
            const seconds = liveSeconds(job, "work", now);
            return (
              <button
                className="job-card"
                type="button"
                key={job.id}
                onClick={() => onSelect(job.id)}
              >
                <div className="job-card-stripe" />
                <div className="job-card-main">
                  <div className="job-card-top">
                    <span className={`status status-${job.status}`}>
                      {statusCopy[job.status]}
                    </span>
                    <span className="job-id">{job.id}</span>
                  </div>
                  <h3>{vehicleName(job)}</h3>
                  <p>
                    {job.customerName}
                    {job.vehiclePlate ? ` · ${job.vehiclePlate}` : ""}
                  </p>
                  <div className="job-card-bottom">
                    <span>
                      <small>Work time</small>
                      <strong>{duration(seconds)}</strong>
                    </span>
                    <span>
                      <small>Receipts</small>
                      <strong>{job.receipts.length}</strong>
                    </span>
                    <span className="job-card-total">
                      <small>{job.invoice ? "Invoice" : "Opened"}</small>
                      <strong>
                        {job.invoice
                          ? money(job.invoice.totalCents)
                          : calendarDate(job.createdAt)}
                      </strong>
                    </span>
                    <span className="chevron">›</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="empty-state">
          <div className="empty-clock">
            <span>JOB TIMER</span>
            <strong>00:00:00</strong>
            <i />
          </div>
          <p className="eyebrow">The bay is clear</p>
          <h2>Create your first mechanic job.</h2>
          <p>
            Add the customer and vehicle now. The clock, receipt folder, notes,
            and invoice will stay attached to that job.
          </p>
          <button className="button button-gold" type="button" onClick={onNew}>
            Start a job
          </button>
        </div>
      )}
    </section>
  );
}

function NewJobPanel({
  onClose,
  onCreated,
  onError,
}: {
  onClose: () => void;
  onCreated: (job: JobRecord) => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [submitting, setSubmitting] = useState(false);

  function update<K extends keyof NewJobDraft>(
    key: K,
    value: NewJobDraft[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function updateMaterial(id: string, changes: Partial<MaterialDraft>) {
    update(
      "materials",
      draft.materials.map((material) =>
        material.id === id ? { ...material, ...changes } : material,
      ),
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const payload = await requestJson<{ job: JobRecord }>("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...draft,
          laborRate: Number(draft.laborRate),
          materials: draft.materials.map((material) => ({
            description: material.description,
            quantity: Number(material.quantity),
            unitCost: Number(material.unitCost),
          })),
        }),
      });
      onCreated(payload.job);
    } catch (createError) {
      onError(createError instanceof Error ? createError.message : "Could not create job.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="sheet new-job-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-job-title"
      >
        <div className="sheet-header">
          <div>
            <p className="eyebrow">New work order</p>
            <h2 id="new-job-title">Create mechanic job</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="form-section">
            <p className="form-section-number">01</p>
            <div>
              <h3>Customer</h3>
              <div className="form-grid">
                <label>
                  <span>Customer name</span>
                  <input
                    required
                    value={draft.customerName}
                    onChange={(event) => update("customerName", event.target.value)}
                    placeholder="Full name"
                    autoComplete="name"
                  />
                </label>
                <label>
                  <span>Email for invoice</span>
                  <input
                    type="email"
                    value={draft.customerEmail}
                    onChange={(event) => update("customerEmail", event.target.value)}
                    placeholder="Can add later"
                    autoComplete="email"
                  />
                </label>
              </div>
            </div>
          </div>

          <div className="form-section">
            <p className="form-section-number">02</p>
            <div>
              <h3>Vehicle</h3>
              <div className="form-grid vehicle-grid">
                <label>
                  <span>Year</span>
                  <input
                    inputMode="numeric"
                    value={draft.vehicleYear}
                    onChange={(event) => update("vehicleYear", event.target.value)}
                    placeholder="2018"
                  />
                </label>
                <label>
                  <span>Make</span>
                  <input
                    required
                    value={draft.vehicleMake}
                    onChange={(event) => update("vehicleMake", event.target.value)}
                    placeholder="Ford"
                  />
                </label>
                <label>
                  <span>Model</span>
                  <input
                    required
                    value={draft.vehicleModel}
                    onChange={(event) => update("vehicleModel", event.target.value)}
                    placeholder="F-150"
                  />
                </label>
                <label>
                  <span>Plate</span>
                  <input
                    value={draft.vehiclePlate}
                    onChange={(event) => update("vehiclePlate", event.target.value)}
                    placeholder="Optional"
                  />
                </label>
              </div>
            </div>
          </div>

          <div className="form-section">
            <p className="form-section-number">03</p>
            <div>
              <h3>Agreed job</h3>
              <div className="form-grid">
                <label>
                  <span>Hourly labor rate</span>
                  <div className="money-input">
                    <b>$</b>
                    <input
                      required
                      min="0.01"
                      step="0.01"
                      inputMode="decimal"
                      value={draft.laborRate}
                      onChange={(event) => update("laborRate", event.target.value)}
                      placeholder="Your rate"
                    />
                  </div>
                </label>
                <label className="wide-label">
                  <span>Work agreed upon</span>
                  <textarea
                    required
                    value={draft.agreedWork}
                    onChange={(event) => update("agreedWork", event.target.value)}
                    placeholder="Describe exactly what the customer approved."
                  />
                </label>
              </div>
            </div>
          </div>

          <div className="form-section">
            <p className="form-section-number">04</p>
            <div>
              <div className="form-title-row">
                <h3>Agreed materials</h3>
                <button
                  className="text-button"
                  type="button"
                  onClick={() =>
                    update("materials", [
                      ...draft.materials,
                      {
                        id: crypto.randomUUID(),
                        description: "",
                        quantity: "1",
                        unitCost: "",
                      },
                    ])
                  }
                >
                  + Add material
                </button>
              </div>
              <div className="material-drafts">
                {draft.materials.map((material, index) => (
                  <div className="material-draft" key={material.id}>
                    <label className="material-description">
                      <span>Material {index + 1}</span>
                      <input
                        value={material.description}
                        onChange={(event) =>
                          updateMaterial(material.id, {
                            description: event.target.value,
                          })
                        }
                        placeholder="Part or supply"
                      />
                    </label>
                    <label>
                      <span>Qty</span>
                      <input
                        min="1"
                        inputMode="numeric"
                        value={material.quantity}
                        onChange={(event) =>
                          updateMaterial(material.id, {
                            quantity: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Unit cost</span>
                      <input
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        value={material.unitCost}
                        onChange={(event) =>
                          updateMaterial(material.id, {
                            unitCost: event.target.value,
                          })
                        }
                        placeholder="$0.00"
                      />
                    </label>
                    {draft.materials.length > 1 ? (
                      <button
                        className="remove-button"
                        type="button"
                        onClick={() =>
                          update(
                            "materials",
                            draft.materials.filter((item) => item.id !== material.id),
                          )
                        }
                        aria-label={`Remove material ${index + 1}`}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="sheet-actions">
            <button className="button button-quiet" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="button button-gold" type="submit" disabled={submitting}>
              {submitting ? "Creating…" : "Create job"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function JobWorkspace({
  job,
  now,
  busy,
  onBack,
  onTimer,
  onPatch,
  onJobChange,
  onCreateInvoice,
  onOpenInvoice,
  onError,
  onNotice,
  setBusy,
}: {
  job: JobRecord;
  now: number;
  busy: string | null;
  onBack: () => void;
  onTimer: (action: TimerAction) => Promise<void>;
  onPatch: (
    changes: Record<string, unknown>,
    success?: string,
  ) => Promise<JobRecord | null>;
  onJobChange: (job: JobRecord) => void;
  onCreateInvoice: (email?: string) => Promise<JobRecord | null>;
  onOpenInvoice: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  setBusy: (value: string | null) => void;
}) {
  const [suggestions, setSuggestions] = useState(job.suggestions);
  const workSeconds = liveSeconds(job, "work", now);
  const breakSeconds = liveSeconds(job, "break", now);
  const completed = ["completed", "invoiced"].includes(job.status);

  return (
    <section className="page job-page">
      <button className="back-button" type="button" onClick={onBack}>
        <span>‹</span> All jobs
      </button>

      <div className="job-hero">
        <div className="job-hero-copy">
          <div className="job-kicker">
            <span className={`status status-${job.status}`}>
              {statusCopy[job.status]}
            </span>
            <span>{job.id}</span>
          </div>
          <h1>{vehicleName(job)}</h1>
          <p>
            {job.customerName}
            {job.vehiclePlate ? ` · Plate ${job.vehiclePlate}` : ""}
          </p>
        </div>
        <div className={`timer-panel timer-${job.status}`}>
          <span className="timer-label">
            {job.status === "on_break" ? "Break running" : "Work time"}
          </span>
          <strong>{duration(workSeconds)}</strong>
          <div className="timer-meta">
            <span>
              Clock in <b>{clockTime(job.startedAt)}</b>
            </span>
            <span>
              Breaks <b>{shortDuration(breakSeconds)}</b>
            </span>
          </div>
          <div className="timer-actions">
            {job.status === "draft" ? (
              <button
                className="button button-clock"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void onTimer("clock_in")}
              >
                <span className="clock-pulse" />
                {busy === "clock_in" ? "Starting…" : "Clock in"}
              </button>
            ) : null}
            {job.status === "in_progress" ? (
              <button
                className="button button-break"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void onTimer("break_start")}
              >
                {busy === "break_start" ? "Starting…" : "Start break"}
              </button>
            ) : null}
            {job.status === "on_break" ? (
              <button
                className="button button-clock"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void onTimer("break_end")}
              >
                {busy === "break_end" ? "Ending…" : "End break"}
              </button>
            ) : null}
            {completed ? (
              <span className="clocked-out-stamp">
                Clocked out {clockTime(job.endedAt)}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="workspace-grid">
        <div className="workspace-main">
          <section className="content-card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">Scope</p>
                <h2>Agreed work</h2>
              </div>
              <span className="card-index">01</span>
            </div>
            <p className="scope-copy">{job.agreedWork}</p>
            <MaterialTable materials={job.materials} />
          </section>

          <ReceiptFolder
            job={job}
            onJobChange={onJobChange}
            onError={onError}
            onNotice={onNotice}
            setBusy={setBusy}
            busy={busy}
          />

          <section className="content-card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">Professional opinion</p>
                <h2>Mechanic&apos;s suggestions</h2>
              </div>
              <span className="card-index">03</span>
            </div>
            <p className="helper-copy">
              Record anything the customer should repair, watch, or service next.
              This prints directly on the invoice.
            </p>
            <textarea
              className="suggestions-field"
              value={suggestions}
              onChange={(event) => setSuggestions(event.target.value)}
              placeholder="Example: Front brake pads are nearing replacement. Recommend service within 1,000 miles."
            />
            <div className="inline-actions">
              <span className="autosave-copy">
                {suggestions === job.suggestions ? "Saved" : "Unsaved changes"}
              </span>
              <button
                className="button button-dark"
                type="button"
                disabled={busy === "save" || suggestions === job.suggestions}
                onClick={() =>
                  void onPatch(
                    { suggestions },
                    "Mechanic's suggestions saved.",
                  )
                }
              >
                {busy === "save" ? "Saving…" : "Save suggestions"}
              </button>
            </div>
          </section>

          <section className="content-card invoice-ready-card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">Final step</p>
                <h2>Create invoice</h2>
              </div>
              <span className="card-index">04</span>
            </div>
            {!completed ? (
              <div className="locked-row">
                <span className="lock-mark">LOCKED</span>
                <p>Clock out at the bottom of the job to unlock invoicing.</p>
              </div>
            ) : (
              <>
                <label className="review-check">
                  <input
                    type="checkbox"
                    checked={job.receiptsReviewed}
                    onChange={(event) =>
                      void onPatch(
                        { receiptsReviewed: event.target.checked },
                        event.target.checked
                          ? "Receipt folder marked reviewed."
                          : "Receipt review reopened.",
                      )
                    }
                  />
                  <span>
                    <strong>Receipt folder reviewed</strong>
                    <small>
                      I checked every receipt and the agreed material amounts.
                    </small>
                  </span>
                </label>
                <div className="invoice-calculation">
                  <span>
                    <small>Labor</small>
                    <strong>
                      {shortDuration(workSeconds)} × {money(job.laborRateCents)}/hr
                    </strong>
                  </span>
                  <span>
                    <small>Materials</small>
                    <strong>
                      {money(
                        job.materials.reduce(
                          (sum, item) =>
                            sum + item.quantity * item.unitCostCents,
                          0,
                        ),
                      )}
                    </strong>
                  </span>
                </div>
                <button
                  className="button button-gold button-full"
                  type="button"
                  disabled={!job.receiptsReviewed || busy === "invoice"}
                  onClick={() =>
                    job.invoice
                      ? onOpenInvoice()
                      : void onCreateInvoice(job.customerEmail)
                  }
                >
                  {busy === "invoice"
                    ? "Creating…"
                    : job.invoice
                      ? `Review ${job.invoice.invoiceNumber}`
                      : "Create invoice"}
                </button>
              </>
            )}
          </section>
        </div>

        <aside className="workspace-side">
          <section className="side-card">
            <p className="eyebrow">Job details</p>
            <dl>
              <div>
                <dt>Job ID</dt>
                <dd>{job.id}</dd>
              </div>
              <div>
                <dt>Customer</dt>
                <dd>{job.customerName}</dd>
              </div>
              <div>
                <dt>Vehicle</dt>
                <dd>{vehicleName(job)}</dd>
              </div>
              <div>
                <dt>Labor rate</dt>
                <dd>{money(job.laborRateCents)}/hr</dd>
              </div>
              <div>
                <dt>Opened</dt>
                <dd>{calendarDate(job.createdAt)}</dd>
              </div>
            </dl>
          </section>
          <section className="side-card timeline-card">
            <p className="eyebrow">Time log</p>
            {job.timeEntries.length ? (
              <ol className="timeline">
                {job.timeEntries.map((entry) => (
                  <li key={entry.id}>
                    <i className={`timeline-dot timeline-${entry.kind}`} />
                    <div>
                      <strong>{entry.kind === "work" ? "Work" : "Break"}</strong>
                      <span>
                        {clockTime(entry.startedAt)} → {clockTime(entry.endedAt)}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="side-empty">The first clock-in starts the time log.</p>
            )}
          </section>
        </aside>
      </div>

      <section className="clock-out-zone">
        <div>
          <p className="eyebrow">End of job</p>
          <h2>{completed ? "This job is clocked out." : "Finished with the vehicle?"}</h2>
          <p>
            {completed
              ? `Recorded ${shortDuration(workSeconds)} of billable work.`
              : job.status === "on_break"
                ? "End the break before clocking out."
                : "Clocking out freezes the work time and unlocks receipt review."}
          </p>
        </div>
        {!completed ? (
          <button
            className="button button-clock-out"
            type="button"
            disabled={job.status !== "in_progress" || Boolean(busy)}
            onClick={() => void onTimer("clock_out")}
          >
            {busy === "clock_out" ? "Clocking out…" : "Clock out · Finish job"}
          </button>
        ) : (
          <span className="completed-seal">Job complete</span>
        )}
      </section>
    </section>
  );
}

function MaterialTable({ materials }: { materials: MaterialRecord[] }) {
  if (!materials.length) {
    return <p className="muted-note">No materials were added to the agreement.</p>;
  }
  return (
    <div className="material-table">
      <div className="material-table-head">
        <span>Material</span>
        <span>Qty</span>
        <span>Agreed</span>
      </div>
      {materials.map((material) => (
        <div className="material-table-row" key={material.id}>
          <strong>{material.description}</strong>
          <span>{material.quantity}</span>
          <span>{money(material.quantity * material.unitCostCents)}</span>
        </div>
      ))}
    </div>
  );
}

function ReceiptFolder({
  job,
  busy,
  onJobChange,
  onError,
  onNotice,
  setBusy,
}: {
  job: JobRecord;
  busy: string | null;
  onJobChange: (job: JobRecord) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  setBusy: (value: string | null) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) {
      inputRef.current?.click();
      return;
    }
    setBusy("receipt");
    try {
      const form = new FormData();
      form.set("receipt", file);
      form.set("vendor", vendor);
      form.set("amount", amount);
      const payload = await requestJson<{ job: JobRecord }>(
        `/api/jobs/${encodeURIComponent(job.id)}/receipts`,
        { method: "POST", body: form },
      );
      onJobChange(payload.job);
      setFile(null);
      setVendor("");
      setAmount("");
      if (inputRef.current) inputRef.current.value = "";
      onNotice("Receipt saved inside this job's receipt folder.");
    } catch (uploadError) {
      onError(uploadError instanceof Error ? uploadError.message : "Receipt upload failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="content-card receipt-card">
      <div className="card-heading">
        <div>
          <p className="eyebrow">Job receipt folder</p>
          <h2>Receipts</h2>
        </div>
        <span className="card-index">02</span>
      </div>
      <form className="receipt-capture" onSubmit={upload}>
        <input
          ref={inputRef}
          className="file-input"
          type="file"
          name="receipt"
          accept="image/*"
          capture="environment"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <button
          className="camera-button"
          type="button"
          onClick={() => inputRef.current?.click()}
        >
          <span className="camera-lens" />
          <span>
            <strong>{file ? file.name : "Take receipt photo"}</strong>
            <small>Camera or photo library · up to 10 MB</small>
          </span>
        </button>
        <div className="receipt-fields">
          <label>
            <span>Vendor</span>
            <input
              value={vendor}
              onChange={(event) => setVendor(event.target.value)}
              placeholder="Parts store"
            />
          </label>
          <label>
            <span>Receipt total</span>
            <div className="money-input">
              <b>$</b>
              <input
                min="0"
                step="0.01"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
              />
            </div>
          </label>
          <button
            className="button button-dark"
            type="submit"
            disabled={!file || busy === "receipt"}
          >
            {busy === "receipt" ? "Filing…" : "File receipt"}
          </button>
        </div>
      </form>

      {job.receipts.length ? (
        <div className="receipt-grid">
          {job.receipts.map((receipt) => (
            <a
              className="receipt-item"
              href={receipt.url}
              target="_blank"
              rel="noreferrer"
              key={receipt.id}
            >
              {/* Native image output is intentional here: authenticated receipt
                  routes are not compatible with the public image optimizer. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={receipt.url} alt={`Receipt from ${receipt.vendor || "vendor"}`} />
              <span>
                <strong>{receipt.vendor || "Receipt"}</strong>
                <small>
                  {receipt.amountCents ? money(receipt.amountCents) : "Amount not entered"} ·{" "}
                  {calendarDate(receipt.createdAt)}
                </small>
              </span>
            </a>
          ))}
        </div>
      ) : (
        <div className="receipt-empty">
          <span>0</span>
          <p>No receipts filed yet. Every photo you take here stays with {job.id}.</p>
        </div>
      )}
    </section>
  );
}

function InvoicePanel({
  job,
  onClose,
  onCreateInvoice,
  onNotice,
  onError,
}: {
  job: JobRecord;
  onClose: () => void;
  onCreateInvoice: (email?: string) => Promise<JobRecord | null>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [email, setEmail] = useState(job.customerEmail);
  const [sharing, setSharing] = useState(false);
  const invoice = job.invoice!;

  async function currentInvoiceJob() {
    if (email.trim() !== job.customerEmail) {
      const updated = await onCreateInvoice(email.trim());
      return updated ?? job;
    }
    return job;
  }

  async function receiptData(invoiceJob: JobRecord) {
    return Promise.all(
      invoiceJob.receipts.map(async (receipt) => {
        const response = await fetch(receipt.url);
        if (!response.ok) throw new Error(`Could not attach ${receipt.filename}.`);
        return {
          filename: receipt.filename,
          dataUrl: await blobToDataUrl(await response.blob()),
        };
      }),
    );
  }

  async function download() {
    setSharing(true);
    try {
      const invoiceJob = await currentInvoiceJob();
      const html = invoiceHtml(invoiceJob, await receiptData(invoiceJob));
      const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${invoiceJob.invoice!.invoiceNumber}.html`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      onNotice("Invoice package downloaded with receipt images included.");
    } catch (downloadError) {
      onError(downloadError instanceof Error ? downloadError.message : "Download failed.");
    } finally {
      setSharing(false);
    }
  }

  async function share() {
    setSharing(true);
    try {
      const invoiceJob = await currentInvoiceJob();
      const html = invoiceHtml(invoiceJob, await receiptData(invoiceJob));
      const file = new File([html], `${invoiceJob.invoice!.invoiceNumber}.html`, {
        type: "text/html",
      });
      const shareData = {
        title: `${invoiceJob.invoice!.invoiceNumber} — Gold Mobile Mechanic`,
        text: `Invoice for ${vehicleName(invoiceJob)}. Send to ${email.trim() || "the customer"}.`,
        files: [file],
      };
      if (!navigator.share || !navigator.canShare?.(shareData)) {
        await download();
        return;
      }
      if (email.trim() && navigator.clipboard) {
        await navigator.clipboard.writeText(email.trim()).catch(() => undefined);
      }
      await navigator.share(shareData);
      onNotice(
        email.trim()
          ? `Invoice shared. ${email.trim()} was copied for the recipient field.`
          : "Invoice shared through your phone.",
      );
    } catch (shareError) {
      if (shareError instanceof Error && shareError.name === "AbortError") return;
      onError(shareError instanceof Error ? shareError.message : "Could not share invoice.");
    } finally {
      setSharing(false);
    }
  }

  async function openEmail() {
    const invoiceJob = await currentInvoiceJob();
    const recipient = email.trim();
    if (!recipient) {
      onError("Enter the customer's email first.");
      return;
    }
    const materialSummary = invoiceJob.materials
      .map(
        (item) =>
          `${item.description} (${item.quantity}) — ${money(item.quantity * item.unitCostCents)}`,
      )
      .join("\n");
    const body = [
      `Hi ${invoiceJob.customerName},`,
      "",
      `Here is your Gold Mobile Mechanic invoice for ${vehicleName(invoiceJob)}.`,
      "",
      `Invoice: ${invoiceJob.invoice!.invoiceNumber}`,
      `Labor: ${money(invoiceJob.invoice!.laborCents)}`,
      `Materials: ${money(invoiceJob.invoice!.materialsCents)}`,
      `Total: ${money(invoiceJob.invoice!.totalCents)}`,
      "",
      "Work completed:",
      invoiceJob.agreedWork,
      "",
      materialSummary ? `Materials:\n${materialSummary}\n` : "",
      "Mechanic's suggestions:",
      invoiceJob.suggestions || "No additional suggestions.",
      "",
      `${invoiceJob.receipts.length} receipt${invoiceJob.receipts.length === 1 ? "" : "s"} filed with the invoice package.`,
      "",
      "Thank you,",
      "Gold Mobile Mechanic",
    ]
      .filter((line) => line !== "")
      .join("\n");
    window.location.href = `mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent(
      `${invoiceJob.invoice!.invoiceNumber} — Gold Mobile Mechanic`,
    )}&body=${encodeURIComponent(body)}`;
    onNotice("Prepared email opened. Attach the downloaded invoice package before sending.");
  }

  return (
    <div className="modal-backdrop invoice-backdrop">
      <section
        className="sheet invoice-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invoice-title"
      >
        <div className="sheet-header no-print">
          <div>
            <p className="eyebrow">Filed invoice</p>
            <h2 id="invoice-title">{invoice.invoiceNumber}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <article className="invoice-paper">
          <header className="invoice-header">
            <div>
              <p className="eyebrow">Gold Mobile Mechanic</p>
              <h2>
                Service <span>Invoice</span>
              </h2>
            </div>
            <div>
              <strong>{invoice.invoiceNumber}</strong>
              <span>{calendarDate(invoice.createdAt)}</span>
              <span>{job.id}</span>
            </div>
          </header>
          <div className="invoice-parties">
            <div>
              <small>Bill to</small>
              <strong>{job.customerName}</strong>
              <span>{email || "Email not provided"}</span>
            </div>
            <div>
              <small>Vehicle</small>
              <strong>{vehicleName(job)}</strong>
              <span>{job.vehiclePlate || "No plate recorded"}</span>
            </div>
          </div>
          <div className="invoice-scope">
            <small>Agreed work</small>
            <p>{job.agreedWork}</p>
          </div>
          <div className="invoice-lines">
            <div className="invoice-line invoice-line-head">
              <span>Service / material</span>
              <span>Qty / hours</span>
              <span>Amount</span>
            </div>
            <div className="invoice-line">
              <span>
                <strong>Mobile mechanic labor</strong>
                <small>{money(job.laborRateCents)}/hour</small>
              </span>
              <span>{(job.workSeconds / 3600).toFixed(2)}</span>
              <strong>{money(invoice.laborCents)}</strong>
            </div>
            {job.materials.map((item) => (
              <div className="invoice-line" key={item.id}>
                <span>
                  <strong>{item.description}</strong>
                  <small>{money(item.unitCostCents)} each</small>
                </span>
                <span>{item.quantity}</span>
                <strong>{money(item.quantity * item.unitCostCents)}</strong>
              </div>
            ))}
          </div>
          <div className="invoice-totals">
            <span>
              <small>Labor</small>
              <strong>{money(invoice.laborCents)}</strong>
            </span>
            <span>
              <small>Materials</small>
              <strong>{money(invoice.materialsCents)}</strong>
            </span>
            <span className="invoice-grand-total">
              <small>Total due</small>
              <strong>{money(invoice.totalCents)}</strong>
            </span>
          </div>
          <div className="invoice-notes">
            <small>Mechanic&apos;s suggestions</small>
            <p>{job.suggestions || "No additional suggestions."}</p>
          </div>
          {job.receipts.length ? (
            <div className="invoice-receipts">
              <small>Filed receipts</small>
              <div>
                {job.receipts.map((receipt) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={receipt.id} src={receipt.url} alt={receipt.filename} />
                ))}
              </div>
            </div>
          ) : null}
        </article>

        <div className="invoice-send no-print">
          <div>
            <p className="eyebrow">Where are we sending this?</p>
            <label>
              <span>Customer email</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="customer@email.com"
              />
            </label>
            <p className="send-help">
              Share sends the full invoice file with receipt images. Email opens
              your mail app with the recipient and invoice summary prepared.
            </p>
          </div>
          <div className="send-actions">
            <button
              className="button button-quiet"
              type="button"
              disabled={sharing}
              onClick={() => void download()}
            >
              Download
            </button>
            <button
              className="button button-dark"
              type="button"
              disabled={sharing}
              onClick={() => void openEmail()}
            >
              Open email
            </button>
            <button
              className="button button-gold"
              type="button"
              disabled={sharing}
              onClick={() => void share()}
            >
              {sharing ? "Preparing…" : "Share full invoice"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
