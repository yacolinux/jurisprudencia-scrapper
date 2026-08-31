import { MATERIAS, parseCourtDate } from "./archive-store.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function asMatterList(value) {
  const requested = Array.isArray(value) ? value.filter(Boolean).map(String) : [];
  if (!requested.length || requested.some((matter) => matter.toLocaleLowerCase("es") === "todas")) return [...MATERIAS];
  return [...new Set(requested)];
}

function normalizeRetry(value = {}) {
  const mode = ["automatic", "delayed", "manual"].includes(value.mode) ? value.mode : (process.env.BATCH_RETRY_MODE || "manual");
  const attempts = Math.min(Math.max(Number(value.attempts ?? process.env.BATCH_RETRY_ATTEMPTS ?? 2), 0), 5);
  const delayMs = Math.min(Math.max(Number(value.delayMs ?? process.env.BATCH_RETRY_DELAY_MS ?? 120_000), 0), 3_600_000);
  return { mode, attempts: mode === "manual" ? 0 : attempts, delayMs };
}

export function validateBatchInput(input = {}) {
  const year = Number(input.year ?? input.anio);
  const rawMonth = input.month !== undefined ? input.month : input.mes;
  const month = rawMonth === null || rawMonth === "all" || rawMonth === "todo" || rawMonth === 0 || rawMonth === "0" ? null : Number(rawMonth);
  const currentYear = new Date().getUTCFullYear();
  if (!Number.isInteger(year) || year < 1900 || year > currentYear + 1) throw Object.assign(new Error("El año debe estar entre 1900 y el próximo año"), { code: "INVALID_YEAR" });
  if (month !== null && (!Number.isInteger(month) || month < 1 || month > 12)) throw Object.assign(new Error("El mes debe estar entre 1 y 12, o Todo el año"), { code: "INVALID_MONTH" });
  return {
    year,
    month,
    materias: asMatterList(input.materias ?? input.materia),
    retry: normalizeRetry(input.retry),
    onlyIds: Array.isArray(input.onlyIds) ? [...new Set(input.onlyIds.map(String))] : []
  };
}

export class BatchCollector {
  constructor({ client, store, pageSize = 100, maxPages = 500, delayMs = 350, searchDelayMs = 4_000 } = {}) {
    this.client = client;
    this.store = store;
    this.pageSize = pageSize;
    this.maxPages = maxPages;
    this.delayMs = Math.max(0, Number(delayMs) || 0);
    this.searchDelayMs = Math.max(0, Number(searchDelayMs) || 0);
  }

  async run(input, options = {}) {
    const normalized = validateBatchInput(input);
    return this.#runMonth(normalized, options);
  }

  async #runMonth(input, { onProgress = () => {}, signal } = {}) {
    const { year, month, materias, retry, onlyIds } = validateBatchInput(input);
    const stats = { year, month, materias, retry, onlyIds, searchStrategy: month === null ? "annual-pagination-local-month" : "annual-pagination-local-filter", monthsCompleted: month === null ? 12 : undefined, searches: 0, pages: 0, candidates: 0, filtered: 0, downloaded: 0, cached: 0, withoutPdf: 0, errors: 0, retries: 0, searchDelayMs: this.searchDelayMs };
    const documents = [];
    const seen = new Set();
    const failures = [];
    const emit = async (value) => onProgress({ ...stats, ...value });
    const retryOperation = async (operation, context) => {
      let attempt = 0;
      while (true) {
        try {
          return await operation();
        } catch (error) {
          if (error.code === "CHALLENGE_REQUIRED" || retry.mode === "manual" || attempt >= retry.attempts) throw error;
          attempt += 1;
          stats.retries += 1;
          await emit({ phase: "retry", ...context, attempt, retryMax: retry.attempts });
          if (retry.delayMs) await sleep(retry.delayMs);
        }
      }
    };

    try {
    for (let matterIndex = 0; matterIndex < materias.length; matterIndex += 1) {
      const materia = materias[matterIndex];
      await emit({ phase: "search", materia, materiaIndex: matterIndex + 1, materiaTotal: materias.length, page: 0 });
      for (let page = 1; page <= this.maxPages; page += 1) {
        if (signal?.aborted) throw Object.assign(new Error("La ejecución fue cancelada"), { code: "JOB_CANCELLED" });
        if (stats.searches > 0 && this.searchDelayMs) await sleep(this.searchDelayMs);
        const search = await this.client.search({ anio: year, materias: [materia], page, perPage: this.pageSize });
        stats.searches += 1;
        stats.pages += 1;
        const results = Array.isArray(search.results) ? search.results : [];
        let newCandidatesOnPage = 0;
        await emit({ phase: "search", materia, page, pageTotal: search.totalPages, foundOnPage: results.length });
        for (const result of results) {
          const key = result.id ? `id:${result.id}` : result.pdfUrl ? `pdf:${result.pdfUrl}` : `${result.fallo}|${result.fecha}|${result.caratula}`;
          if (seen.has(key)) continue;
          seen.add(key);
          newCandidatesOnPage += 1;
          stats.candidates += 1;
          if (onlyIds.length && !onlyIds.includes(String(result.id)) && !onlyIds.includes(String(result.pdfUrl || ""))) continue;
          const date = parseCourtDate(result.fecha);
          if (!date || date.year !== year || (month !== null && date.month !== month)) continue;
          stats.filtered += 1;
          let detail = null;
          let pdfUrl = result.pdfUrl || null;
          try {
            if (!pdfUrl && result.id) {
              detail = await retryOperation(() => this.client.detail(result.id), { materia, item: result });
              pdfUrl = detail?.pdfUrl || null;
            }
            if (!pdfUrl) {
              stats.withoutPdf += 1;
              await emit({ phase: "skip", materia, item: result, reason: "without-pdf" });
              continue;
            }
            const existing = this.store.find({ id: result.id, source: pdfUrl });
            if (existing) {
              stats.cached += 1;
              documents.push(existing);
              await emit({ phase: "cached", materia, item: existing });
              continue;
            }
            await emit({ phase: "download", materia, item: result });
            const pdfBytes = await retryOperation(() => this.client.downloadPdf(pdfUrl), { materia, item: result });
            const saved = await this.store.save({
              pdfBytes,
              metadata: {
                id: result.id ? Number(result.id) : detail?.id || null,
                fallo: result.fallo || detail?.heading || null,
                expediente: result.expediente || null,
                caratula: result.caratula || detail?.title || null,
                materia: result.materia || materia,
                fecha: result.fecha,
                source: pdfUrl,
                detailSource: detail?.source || null
              }
            });
            if (saved.status === "cached") stats.cached += 1;
            else stats.downloaded += 1;
            documents.push(saved.document);
            await emit({ phase: saved.status, materia, item: saved.document });
            if (this.delayMs) await sleep(this.delayMs);
          } catch (error) {
            if (error.code === "CHALLENGE_REQUIRED") {
              stats.errors += 1;
              failures.push({ id: result.id || null, pdfUrl, fecha: result.fecha || null, caratula: result.caratula || null, error: error.message, code: error.code });
              await emit({ phase: "needs-attention", materia, item: result, error: error.message });
              error.progress = { ...stats, phase: "needs-attention", failures };
              error.partial = { ...stats, documents, failures };
              throw error;
            }
            stats.errors += 1;
            failures.push({ id: result.id || null, pdfUrl, fecha: result.fecha || null, caratula: result.caratula || null, error: error.message, code: error.code || "DOCUMENT_ERROR" });
            await emit({ phase: "error", materia, item: result, error: error.message });
          }
        }
        const hasKnownLastPage = Number.isInteger(search.totalPages) && page >= search.totalPages;
        const shortPageWithoutTotal = !Number.isInteger(search.totalPages) && results.length < this.pageSize;
        const repeatedPage = results.length > 0 && newCandidatesOnPage === 0;
        if (!results.length || hasKnownLastPage || shortPageWithoutTotal || repeatedPage) break;
      }
    }
    } catch (error) {
      if (error.code === "CHALLENGE_REQUIRED" && !error.partial) {
        error.progress = { ...stats, phase: "needs-attention", failures };
        error.partial = { ...stats, documents, failures };
      }
      throw error;
    }
    await emit({ phase: "completed", failures });
    return { ...stats, documents, failures };
  }
}
