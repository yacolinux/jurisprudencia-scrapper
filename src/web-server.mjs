import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalMcpClient } from "./mcp-client.mjs";
import { JurisprudenciaClient } from "./jurisprudencia-client.mjs";
import { ArchiveStore } from "./archive-store.mjs";
import { BatchCollector, validateBatchInput } from "./collector.mjs";
import { JobManager } from "./job-manager.mjs";
import { synthesize } from "./ai.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PUBLIC = resolve(process.env.PUBLIC_DIR || join(ROOT, "public"));
const PORT = Number(process.env.PORT || 3000);
const APP_MODE = process.env.APP_MODE || "archive";
const IS_ARCHIVE = APP_MODE === "archive";
const MAX_BODY = 100_000;
const mcp = new LocalMcpClient({ timeoutMs: Number(process.env.MCP_TIMEOUT_MS || 120_000) });
const DATA_DIR = resolve(process.env.DATA_DIR || join(ROOT, "data"));
let queryQueue = Promise.resolve();

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

function errorPayload(error) {
  return {
    error: error.message || "Error inesperado",
    code: error.code || "WEB_ERROR",
    ...(error.browserState ? { browserState: error.browserState } : {})
  };
}

async function body(request) {
  let value = "";
  for await (const chunk of request) {
    value += chunk;
    if (value.length > MAX_BODY) throw Object.assign(new Error("El cuerpo de la consulta es demasiado grande"), { code: "BODY_TOO_LARGE" });
  }
  try { return JSON.parse(value || "{}"); } catch { throw Object.assign(new Error("El cuerpo debe ser JSON válido"), { code: "INVALID_JSON" }); }
}

function clean(value, max = 3_000) {
  return String(value ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}

function searchText(question, supplied) {
  const explicit = clean(supplied, 240);
  if (explicit) return explicit;
  const stopwords = new Set("qué que sobre para del las los una uno con desde entre necesito quiero buscá busca buscar analizar explicá explicar informe reporte consulta jurisprudencia fallo fallos relevante podrían caso instituto poder judicial corrientes".split(" "));
  const terms = clean(question, 800).toLocaleLowerCase("es").split(/\s+/).filter((term) => term.length > 2 && !stopwords.has(term.replace(/[^\p{L}\p{N}]/gu, "")));
  return terms.slice(0, 12).join(" ") || clean(question, 240);
}

function normalizeResult(result, detail, pdf) {
  return {
    id: result.id ? Number(result.id) : detail?.id || null,
    title: detail?.title || result.caratula || result.fallo || "Fallo sin título",
    fallo: result.fallo,
    expediente: result.expediente,
    materia: result.materia,
    fecha: result.fecha,
    source: pdf?.source || detail?.source || result.pdfUrl || result.source,
    pdfUrl: pdf?.source || detail?.pdfUrl || result.pdfUrl || null,
    content: [detail?.text, pdf?.text].filter(Boolean).join("\n\n"),
    detail,
    pdf: pdf ? { chars: pdf.chars, truncated: pdf.truncated } : null
  };
}

async function runQuery(input) {
  const question = clean(input.question);
  if (question.length < 5) throw Object.assign(new Error("Escribí una consulta de al menos 5 caracteres"), { code: "INVALID_QUERY" });
  const mode = input.mode === "report" ? "report" : "single";
  const filters = input.filters && typeof input.filters === "object" ? input.filters : {};
  const search = await mcp.callTool("search_jurisprudencia", {
    ...filters,
    text: searchText(question, input.searchText || filters.text),
    page: 1,
    perPage: Math.min(Number(filters.perPage) || 10, 10)
  });
  const selected = (search.results || []).filter((result) => result.id || result.pdfUrl).slice(0, Number(process.env.MAX_DOCUMENTS || 3));
  const documents = [];
  for (const result of selected) {
    let detail = null;
    let pdf = null;
    try { if (result.id) detail = await mcp.callTool("get_jurisprudencia_detail", { id: result.id }); } catch (error) { detail = { error: error.message }; }
    if (result.pdfUrl || detail?.pdfUrl) {
      try { pdf = await mcp.callTool("get_jurisprudencia_pdf_text", { pdfUrl: result.pdfUrl || detail.pdfUrl, maxChars: Number(process.env.MAX_PDF_CHARS || 18_000) }); } catch (error) { pdf = { error: error.message }; }
    }
    documents.push(normalizeResult(result, detail, pdf));
  }
  const synthesis = await synthesize({ question, mode, search, documents });
  return {
    question,
    mode,
    search: { source: search.source, total: search.total, page: search.page, totalPages: search.totalPages, results: search.results || [] },
    documents,
    ...synthesis,
    generatedAt: new Date().toISOString(),
    accessMode: process.env.JURIS_ACCESS_MODE || "auto"
  };
}

function enqueue(task) {
  const next = queryQueue.then(task, task);
  queryQueue = next.catch(() => {});
  return next;
}

const archiveStore = IS_ARCHIVE ? await new ArchiveStore(DATA_DIR).init() : null;
const bulkClient = IS_ARCHIVE ? new JurisprudenciaClient() : null;
const collector = IS_ARCHIVE ? new BatchCollector({
  client: bulkClient,
  store: archiveStore,
  pageSize: Number(process.env.BATCH_PAGE_SIZE || 100),
  maxPages: Number(process.env.BATCH_MAX_PAGES || 500),
  delayMs: Number(process.env.BATCH_DELAY_MS || 350)
}) : null;
const jobs = IS_ARCHIVE ? await new JobManager({ dataDir: DATA_DIR, collector, enqueue }).init() : null;

async function serveArchiveFile(request, response, url) {
  const relativePath = url.searchParams.get("path");
  if (!relativePath) return json(response, 400, { error: "Falta el parámetro path" });
  try {
    const file = archiveStore.resolveRelative(relativePath);
    const data = await readFile(file);
    response.writeHead(200, { "content-type": "application/pdf", "content-disposition": `inline; filename="${file.split("/").pop()}"`, "cache-control": "public, max-age=3600" });
    response.end(data);
  } catch (error) {
    return json(response, 404, { error: error.message || "PDF no encontrado" });
  }
}

async function serveStatic(request, response, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const file = resolve(PUBLIC, `.${requested}`);
  if (!file.startsWith(`${PUBLIC}/`)) return json(response, 404, { error: "No encontrado" });
  try {
    const data = await readFile(file);
    response.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    response.end(data);
  } catch { json(response, 404, { error: "No encontrado" }); }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, { ok: true, service: `${APP_MODE}-jurisprudencia-web`, appMode: APP_MODE, mcpStarted: mcp.started, accessMode: process.env.JURIS_ACCESS_MODE || "auto", ...(IS_ARCHIVE ? { dataDir: DATA_DIR, archive: await archiveStore.summary() } : {}) });
    }
    if (request.method === "GET" && url.pathname === "/api/diagnose") {
      const diagnosis = await enqueue(() => mcp.callTool("diagnose_jurisprudencia_access"));
      return json(response, 200, diagnosis);
    }
    if (request.method === "POST" && url.pathname === "/api/query") {
      const input = await body(request);
      const result = await enqueue(() => runQuery(input));
      return json(response, 200, result);
    }
    if (IS_ARCHIVE && request.method === "GET" && url.pathname === "/api/archive/summary") return json(response, 200, await archiveStore.summary());
    if (IS_ARCHIVE && request.method === "GET" && url.pathname === "/api/archive/documents") {
      return json(response, 200, { documents: await archiveStore.list({ year: url.searchParams.get("year"), month: url.searchParams.get("month"), limit: url.searchParams.get("limit") }) });
    }
    if (IS_ARCHIVE && request.method === "GET" && url.pathname === "/api/archive/file") return serveArchiveFile(request, response, url);
    if (IS_ARCHIVE && request.method === "GET" && url.pathname === "/api/jobs") return json(response, 200, { jobs: await jobs.list() });
    if (IS_ARCHIVE && request.method === "POST" && url.pathname === "/api/jobs") {
      const input = await body(request);
      const normalized = validateBatchInput(input);
      return json(response, 202, { job: await jobs.start(normalized) });
    }
    const jobPath = url.pathname.match(/^\/api\/jobs\/([^/]+)(\/(?:cancel|retry))?$/);
    const jobId = jobPath?.[1] ? decodeURIComponent(jobPath[1]) : null;
    if (IS_ARCHIVE && jobId && !jobPath?.[2] && request.method === "GET") {
      const job = await jobs.get(jobId);
      return job ? json(response, 200, { job }) : json(response, 404, { error: "Ejecución no encontrada" });
    }
    if (IS_ARCHIVE && jobId && jobPath?.[2] === "/cancel" && request.method === "POST") {
      const job = await jobs.cancel(jobId);
      return job ? json(response, 202, { job }) : json(response, 404, { error: "Ejecución no encontrada" });
    }
    if (IS_ARCHIVE && jobId && jobPath?.[2] === "/retry" && request.method === "POST") {
      const input = await body(request);
      return json(response, 202, { job: await jobs.retry(jobId, input.retry || input) });
    }
    if (request.method === "GET") return serveStatic(request, response, url.pathname);
    return json(response, 405, { error: "Método no permitido" });
  } catch (error) {
    const status = error.code === "JOB_ALREADY_RUNNING" ? 409 : error.code === "NO_RETRY_ITEMS" ? 422 : ["INVALID_QUERY", "INVALID_JSON", "BODY_TOO_LARGE", "INVALID_YEAR", "INVALID_MONTH"].includes(error.code) ? 400 : error.code === "CHALLENGE_REQUIRED" ? 503 : 502;
    return json(response, status, errorPayload(error));
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`${APP_MODE} web escuchando en http://0.0.0.0:${PORT}`));

async function shutdown() {
  server.close();
  await mcp.close();
  await bulkClient?.close();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
