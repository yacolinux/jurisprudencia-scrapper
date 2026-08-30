import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class JobManager {
  constructor({ dataDir, collector, enqueue = (task) => task() } = {}) {
    this.dataDir = dataDir;
    this.jobsDir = join(dataDir, ".state", "jobs");
    this.collector = collector;
    this.enqueue = enqueue;
    this.jobs = new Map();
    this.controllers = new Map();
  }

  async init() {
    await mkdir(this.jobsDir, { recursive: true });
    for (const file of await readdir(this.jobsDir).catch(() => [])) {
      if (!file.endsWith(".json")) continue;
      try {
        const job = JSON.parse(await readFile(join(this.jobsDir, file), "utf8"));
        if (["queued", "running"].includes(job.status)) job.status = "interrupted";
        this.jobs.set(job.id, job);
        if (job.status === "interrupted") await this.#persist(job);
      } catch {
        // Un job corrupto no impide que el archivo local siga disponible.
      }
    }
    return this;
  }

  async #persist(job) {
    await writeFile(join(this.jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2));
  }

  async start(input) {
    const active = [...this.jobs.values()].find((job) => ["queued", "running"].includes(job.status));
    if (active) throw Object.assign(new Error("Ya hay una ejecución en curso"), { code: "JOB_ALREADY_RUNNING", jobId: active.id });
    const job = {
      id: randomUUID(), status: "queued", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      input, progress: { phase: "queued" }, result: null, error: null, events: []
    };
    this.jobs.set(job.id, job);
    await this.#persist(job);
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    void this.enqueue(() => this.#run(job, controller.signal));
    return this.public(job);
  }

  async #run(job, signal) {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    await this.#persist(job);
    try {
      job.result = await this.collector.run(job.input, {
        signal,
        onProgress: async (progress) => {
          job.progress = progress;
          if (progress.item) job.events = [...job.events.slice(-59), { at: new Date().toISOString(), phase: progress.phase, item: progress.item, error: progress.error }];
          await this.#persist(job);
        }
      });
      job.status = "completed";
    } catch (error) {
      job.status = error.code === "JOB_CANCELLED" ? "cancelled" : error.code === "CHALLENGE_REQUIRED" ? "needs_attention" : "failed";
      job.error = { message: error.message, code: error.code || "JOB_ERROR" };
      if (error.progress) job.progress = error.progress;
      if (error.partial) job.result = error.partial;
    } finally {
      job.finishedAt = new Date().toISOString();
      this.controllers.delete(job.id);
      await this.#persist(job);
    }
  }

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (this.controllers.has(id)) this.controllers.get(id).abort();
    return this.public(job);
  }

  async retry(id, retry = {}) {
    const previous = this.jobs.get(id);
    if (!previous) return null;
    const failures = previous.result?.failures || previous.progress?.failures || [];
    const onlyIds = failures.flatMap((failure) => [failure.id, failure.pdfUrl]).filter(Boolean);
    if (!onlyIds.length && !["needs_attention", "failed", "interrupted"].includes(previous.status)) throw Object.assign(new Error("La ejecución no tiene fallos pendientes para reintentar"), { code: "NO_RETRY_ITEMS" });
    return this.start({ ...previous.input, ...(onlyIds.length ? { onlyIds } : { onlyIds: [] }), retry: { ...previous.input.retry, ...retry } });
  }

  public(job) {
    return { ...job, result: job.result ? { ...job.result, documents: job.result.documents?.slice(-100) } : null };
  }

  async get(id) {
    return this.public(this.jobs.get(id) || null);
  }

  async list() {
    return [...this.jobs.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 30).map((job) => this.public(job));
  }
}
