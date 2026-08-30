import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalMcpClient } from "./mcp-client.mjs";
import { synthesize } from "./ai.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 100_000;
const mcp = new LocalMcpClient({ timeoutMs: Number(process.env.MCP_TIMEOUT_MS || 120_000) });
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
      return json(response, 200, { ok: true, service: "mvp-jurisprudencia-web", mcpStarted: mcp.started, accessMode: process.env.JURIS_ACCESS_MODE || "auto", ai: process.env.OPENCODE_ENABLED === "1" ? "opencode" : "local-fallback" });
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
    if (request.method === "GET") return serveStatic(request, response, url.pathname);
    return json(response, 405, { error: "Método no permitido" });
  } catch (error) {
    const status = ["INVALID_QUERY", "INVALID_JSON", "BODY_TOO_LARGE"].includes(error.code) ? 400 : error.code === "CHALLENGE_REQUIRED" ? 503 : 502;
    return json(response, status, errorPayload(error));
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`MVP web escuchando en http://0.0.0.0:${PORT}`));

async function shutdown() {
  server.close();
  await mcp.close();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
