import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { extname, join, resolve, sep } from "node:path";
import { parseCourtDate } from "./archive-store.mjs";

const STOPWORDS = new Set("qué que sobre para del las los una uno con desde entre necesito quiero buscá busca buscar analizar explicá explicar informe reporte consulta jurisprudencia fallo fallos relevante podrían caso instituto poder judicial corrientes".split(" "));

function normalize(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es");
}

function termsFrom(value) {
  return normalize(value).split(/[^a-z0-9]+/).filter((term) => term.length > 2 && !STOPWORDS.has(term));
}

function documentText(document) {
  return normalize([
    document.caratula,
    document.fallo,
    document.expediente,
    document.materia,
    document.fecha,
    document.source,
    document.path
  ].join(" "));
}

function scoreDocument(document, terms) {
  if (!terms.length) return 1;
  const title = normalize([document.caratula, document.fallo].join(" "));
  const matter = normalize(document.materia);
  const haystack = documentText(document);
  return terms.reduce((score, term) => {
    if (!haystack.includes(term)) return score;
    if (title.includes(term)) return score + 8;
    if (matter.includes(term)) return score + 5;
    return score + 2;
  }, 0);
}

async function fileExists(file) {
  try {
    await access(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function extractPdfText(file, maxChars, timeoutMs) {
  return new Promise((resolveText) => {
    const child = spawn("pdftotext", ["-layout", file, "-"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveText(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(output.slice(0, maxChars));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (output.length < maxChars) output += chunk.slice(0, maxChars - output.length);
    });
    child.on("error", () => finish(""));
    child.on("close", (code) => finish(code === 0 ? output.trim() : ""));
  });
}

export function resolveLocalPdf(root, relativePath) {
  const archiveRoot = resolve(root);
  const file = resolve(archiveRoot, String(relativePath || ""));
  if (!file.startsWith(archiveRoot + sep) || extname(file).toLocaleLowerCase() !== ".pdf") {
    throw Object.assign(new Error("Archivo local no permitido"), { code: "LOCAL_FILE_NOT_ALLOWED" });
  }
  return file;
}

export class LocalArchiveSearch {
  constructor(root, { pdfScanLimit = Number(process.env.LOCAL_PDF_SCAN_LIMIT || 80), maxPdfChars = Number(process.env.MAX_PDF_CHARS || 18_000), pdfTimeoutMs = Number(process.env.LOCAL_PDF_TIMEOUT_MS || 12_000) } = {}) {
    this.root = resolve(root);
    this.manifestPath = join(this.root, "manifest.json");
    this.pdfScanLimit = Math.max(0, pdfScanLimit);
    this.maxPdfChars = maxPdfChars;
    this.pdfTimeoutMs = pdfTimeoutMs;
  }

  async readManifest() {
    try {
      const manifest = JSON.parse(await readFile(this.manifestPath, "utf8"));
      if (!Array.isArray(manifest.documents)) throw Object.assign(new Error("manifest sin documentos"), { code: "LOCAL_INDEX_INVALID" });
      return manifest;
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, updatedAt: null, documents: [] };
      if (error.code === "LOCAL_INDEX_INVALID") throw error;
      throw Object.assign(new Error("No se pudo leer el índice local: " + error.message), { code: "LOCAL_INDEX_INVALID" });
    }
  }

  async search({ question = "", searchText = "", filters = {}, limit = 10 } = {}) {
    const manifest = await this.readManifest();
    const terms = termsFrom(searchText || question);
    const requestedMatter = termsFrom(filters.materia || filters.materias?.[0] || "");
    const requestedYear = Number(filters.anio || filters.year || 0);
    const requestedMonth = Number(filters.mes || filters.month || 0);
    const periodCandidates = manifest.documents.filter((document) => {
      const date = parseCourtDate(document.fecha);
      const matterMatch = !requestedMatter.length || requestedMatter.every((term) => normalize(document.materia).includes(term));
      return (!requestedYear || date?.year === requestedYear) && (!requestedMonth || date?.month === requestedMonth) && matterMatch;
    });
    const matchingCandidates = periodCandidates
      .map((document, index) => ({ document, score: scoreDocument(document, terms), index }))
      .filter(({ score }) => !terms.length || score > 0)
      .sort((left, right) => right.score - left.score || String(right.document.savedAt || "").localeCompare(String(left.document.savedAt || "")) || right.index - left.index);
    const metadataMatched = matchingCandidates.length > 0;
    const selected = (metadataMatched ? matchingCandidates : periodCandidates.map((document, index) => ({ document, score: 0, index })))
      .slice(0, metadataMatched ? Math.min(Number(limit) || 10, 50) : this.pdfScanLimit);
    const documents = [];
    for (const { document } of selected) {
      let content = "";
      let pdfAvailable = false;
      if (document.path) {
        try {
          const file = resolveLocalPdf(this.root, document.path);
          pdfAvailable = await fileExists(file);
          if (pdfAvailable) content = await extractPdfText(file, this.maxPdfChars, this.pdfTimeoutMs);
        } catch {
          content = "";
        }
      }
      if (!metadataMatched && terms.length && !terms.some((term) => normalize(content).includes(term))) continue;
      documents.push({
        id: document.id ? Number(document.id) : null,
        title: document.caratula || document.fallo || ("Fallo " + (document.id || "")).trim(),
        fallo: document.fallo,
        expediente: document.expediente,
        materia: document.materia,
        fecha: document.fecha,
        source: document.source || ("local:" + (document.path || "")),
        pdfUrl: pdfAvailable && document.path ? "/api/local/file?path=" + encodeURIComponent(document.path) : null,
        localPath: document.path || null,
        content,
        pdf: { chars: content.length, truncated: content.length >= this.maxPdfChars },
        local: true
      });
    }
    const results = documents.map(({ content, pdf, ...result }) => ({ ...result, local: true, hasPdfText: Boolean(content), pdfAvailable: Boolean(result.pdfUrl) }));
    return {
      search: { source: "local-archive", total: results.length, page: 1, totalPages: 1, results },
      documents,
      indexed: manifest.documents.length,
      periodCandidates: periodCandidates.length,
      scannedPdfs: selected.length,
      updatedAt: manifest.updatedAt,
      matchStrategy: metadataMatched ? "metadata" : "pdf-scan"
    };
  }
}
