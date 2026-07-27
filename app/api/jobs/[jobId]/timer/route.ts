import { apiError, getDatabase } from "../../../../../db/store";
import { getJob } from "../../../../../db/jobs";

type RouteContext = { params: Promise<{ jobId: string }> };
type TimerAction = "clock_in" | "break_start" | "break_end" | "clock_out";

function eventTime(value: unknown, jobCreatedAt: string) {
  if (typeof value !== "string") return new Date().toISOString();
  const parsed = Date.parse(value);
  const earliest = Date.parse(jobCreatedAt) - 5 * 60 * 1000;
  const latest = Date.now() + 5 * 60 * 1000;
  if (!Number.isFinite(parsed) || parsed < earliest || parsed > latest) {
    return new Date().toISOString();
  }
  return new Date(parsed).toISOString();
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { jobId } = await context.params;
    const payload = (await request.json()) as {
      action?: TimerAction;
      mutationId?: string;
      occurredAt?: string;
    };
    const action = payload.action;
    const job = await getJob(jobId);
    if (!job) {
      return Response.json({ error: "Job not found." }, { status: 404 });
    }

    const mutationId =
      typeof payload.mutationId === "string" && payload.mutationId.length >= 8
        ? payload.mutationId.slice(0, 128)
        : crypto.randomUUID();
    const db = await getDatabase();
    const existingMutation = await db
      .prepare(
        "SELECT id FROM job_events WHERE job_id = ? AND mutation_id = ? LIMIT 1",
      )
      .bind(jobId, mutationId)
      .first();
    if (existingMutation) {
      return Response.json({ job: await getJob(jobId), replayed: true });
    }

    const allowed: Record<TimerAction, string[]> = {
      clock_in: ["draft"],
      break_start: ["in_progress"],
      break_end: ["on_break"],
      clock_out: ["in_progress"],
    };
    if (!action || !allowed[action]?.includes(job.status)) {
      return Response.json(
        { error: "That timer action is not available for this job." },
        { status: 409 },
      );
    }

    const now = eventTime(payload.occurredAt, job.createdAt);
    const entryId = crypto.randomUUID();
    const eventStatement = action
      ? db
          .prepare(
            "INSERT INTO job_events (id, job_id, action, occurred_at, mutation_id) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(crypto.randomUUID(), jobId, action, now, mutationId)
      : null;

    if (action === "clock_in") {
      await db.batch([
        db
          .prepare(
            "UPDATE jobs SET status = 'in_progress', started_at = ?, updated_at = ? WHERE id = ?",
          )
          .bind(now, now, jobId),
        db
          .prepare(
            "INSERT INTO time_entries (id, job_id, kind, started_at) VALUES (?, ?, 'work', ?)",
          )
          .bind(entryId, jobId, now),
        eventStatement!,
      ]);
    }

    if (action === "break_start") {
      await db.batch([
        db
          .prepare(
            "UPDATE time_entries SET ended_at = ? WHERE job_id = ? AND kind = 'work' AND ended_at IS NULL",
          )
          .bind(now, jobId),
        db
          .prepare(
            "INSERT INTO time_entries (id, job_id, kind, started_at) VALUES (?, ?, 'break', ?)",
          )
          .bind(entryId, jobId, now),
        db
          .prepare(
            "UPDATE jobs SET status = 'on_break', updated_at = ? WHERE id = ?",
          )
          .bind(now, jobId),
        eventStatement!,
      ]);
    }

    if (action === "break_end") {
      await db.batch([
        db
          .prepare(
            "UPDATE time_entries SET ended_at = ? WHERE job_id = ? AND kind = 'break' AND ended_at IS NULL",
          )
          .bind(now, jobId),
        db
          .prepare(
            "INSERT INTO time_entries (id, job_id, kind, started_at) VALUES (?, ?, 'work', ?)",
          )
          .bind(entryId, jobId, now),
        db
          .prepare(
            "UPDATE jobs SET status = 'in_progress', updated_at = ? WHERE id = ?",
          )
          .bind(now, jobId),
        eventStatement!,
      ]);
    }

    if (action === "clock_out") {
      await db.batch([
        db
          .prepare(
            "UPDATE time_entries SET ended_at = ? WHERE job_id = ? AND kind = 'work' AND ended_at IS NULL",
          )
          .bind(now, jobId),
        db
          .prepare(
            "UPDATE jobs SET status = 'completed', ended_at = ?, updated_at = ? WHERE id = ?",
          )
          .bind(now, now, jobId),
        eventStatement!,
      ]);
    }

    return Response.json({ job: await getJob(jobId) });
  } catch (error) {
    return apiError(error, "Could not update the timer.");
  }
}
