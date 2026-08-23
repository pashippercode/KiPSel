export type BackgroundJobMode = "single" | "parallel" | "chain";
export type BackgroundJobStatus = "running" | "completed" | "failed" | "cancelled";

export interface BackgroundJobSummary {
  id: string;
  mode: BackgroundJobMode;
  status: BackgroundJobStatus;
  startedAt: number;
  finishedAt?: number;
  output?: string;
  error?: string;
}

export interface BackgroundJobHandle {
  id: string;
  mode: BackgroundJobMode;
  controller: AbortController;
}

interface JobRecord extends BackgroundJobSummary {
  controller: AbortController;
}

const MAX_STORED_OUTPUT = 12 * 1024;

function capOutput(output: string | undefined): string | undefined {
  if (!output) return undefined;
  return output.length <= MAX_STORED_OUTPUT ? output : `${output.slice(0, MAX_STORED_OUTPUT)}\n[output truncated]`;
}

export class BackgroundJobRegistry {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly maxJobs: number;
  private sequence = 0;

  constructor(maxJobs = 32) {
    this.maxJobs = maxJobs;
  }

  start(mode: BackgroundJobMode): BackgroundJobHandle {
    const id = `subagent-${Date.now().toString(36)}-${(this.sequence++).toString(36)}`;
    const controller = new AbortController();
    this.jobs.set(id, { id, mode, status: "running", startedAt: Date.now(), controller });
    this.prune();
    return { id, mode, controller };
  }

  complete(id: string, output?: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return false;
    job.status = "completed";
    job.finishedAt = Date.now();
    job.output = capOutput(output);
    return true;
  }

  fail(id: string, error: string, cancelled = false): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return false;
    job.status = cancelled ? "cancelled" : "failed";
    job.finishedAt = Date.now();
    job.error = error;
    return true;
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return false;
    job.controller.abort();
    job.status = "cancelled";
    job.finishedAt = Date.now();
    job.error = "cancelled by user";
    this.prune();
    return true;
  }

  cancelAll(): string[] {
    const cancelled: string[] = [];
    for (const job of this.jobs.values()) {
      if (this.cancel(job.id)) cancelled.push(job.id);
    }
    return cancelled;
  }

  get(id: string): BackgroundJobSummary | undefined {
    const job = this.jobs.get(id);
    return job ? this.toSummary(job) : undefined;
  }

  list(): BackgroundJobSummary[] {
    return Array.from(this.jobs.values())
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((job) => this.toSummary(job));
  }

  private toSummary(job: JobRecord): BackgroundJobSummary {
    return {
      id: job.id,
      mode: job.mode,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      output: job.output,
      error: job.error,
    };
  }

  private prune(): void {
    while (this.jobs.size > this.maxJobs) {
      const removable = Array.from(this.jobs.values())
        .filter((job) => job.status !== "running")
        .sort((left, right) => (left.finishedAt ?? left.startedAt) - (right.finishedAt ?? right.startedAt))[0];
      if (!removable) return;
      this.jobs.delete(removable.id);
    }
  }
}
