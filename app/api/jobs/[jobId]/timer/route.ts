import { apiError, getDatabase } from "../../../../../db/store";
import { getJob } from "../../../../../db/jobs";

type RouteContext = { params: Promise<{ jobId: string }> };
type TimerAction = "clock_in" | "break_start" | "break_end" | "clock_out";

export async function POST(request: Request, context: RouteContext) {
  try {
    const { jobId } = await context.params;
    const payload = (await request.json()) as { action?: TimerAction };
    const action = payload.action;
    const job = await getJob(jobId);
    if (!job) {
      return Response.json({ error: "Job not found." }, { status: 404 });
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

    const db = await getDatabase();
    const now = new Date().toISOString();
    const entryId = crypto.randomUUID();

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
      ]);
    }

    return Response.json({ job: await getJob(jobId) });
  } catch (error) {
    return apiError(error, "Could not update the timer.");
  }
}
