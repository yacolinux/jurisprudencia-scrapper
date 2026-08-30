import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, extname, join, resolve, sep } from "node:path";
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

function resolveLocalMarkdown(root, relativePath) {
  const archiveRoot = resolve(root);
  const markdownPath = String(relativePath || "").replace(/\.pdf$/i, ".md");
  const file = resolve(archiveRoot, markdownPath);
  if (!file.startsWith(archiveRoot + sep) || extname(file).toLocaleLowerCase() !== ".md") {
    throw Object.assign(new Error("Archivo Markdown local no permitido"), { code: "LOCAL_FILE_NOT_ALLOWED" });
  }
  return file;
}

export class LocalArchiveSearch {
  constructor(root, { writeRoot = process.env.DATA_WRITE_DIR || root, pdfScanLimit = Number(process.env.LOCAL_PDF_SCAN_LIMIT || 80), maxPdfChars = Number(process.env.MAX_PDF_CHARS || 18_000), pdfTimeoutMs = Number(process.env.LOCAL_PDF_TIMEOUT_MS || 12_000) } = {}) {
    this.root = resolve(root);
    this.writeRoot = resolve(writeRoot);
    this.manifestPath = join(this.root, "manifest.json");
    this.pdfScanLimit = Math.max(0, pdfScanLimit);
    this.maxPdfChars = maxPdfChars;
    this.pdfTimeoutMs = pdfTimeoutMs;
  }

  async ensureMarkdown(document) {
    if (!document.path) return { content: "", created: false, path: null };
    const markdownPath = document.path.replace(/\.pdf$/i, ".md");
    try {
      return { content: await readFile(resolveLocalMarkdown(this.root, document.path), "utf8"), created: false, path: markdownPath };
    } catch (error) {
      if (error.code !== "ENOENT") return { content: "", created: false, path: markdownPath };
    }
    let extracted = "";
    try {
      const file = resolveLocalPdf(this.root, document.path);
      if (await fileExists(file)) extracted = await extractPdfText(file, this.maxPdfChars, this.pdfTimeoutMs);
    } catch {
      extracted = "";
    }
    if (!extracted) return { content: "", created: false, path: markdownPath };
    const target = resolveLocalMarkdown(this.writeRoot, document.path);
    const markdown = "# " + (document.caratula || document.fallo || "Fallo") + "\n\n" + extracted.trim() + "\n";
    let created = false;
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, markdown, { flag: "wx" });
      created = true;
    } catch (error) {
      if (error.code !== "EEXIST") return { content: "", created: false, path: markdownPath };
    }
    try {
      return { content: await readFile(target, "utf8"), created, path: markdownPath };
    } catch {
      return { content: "", created: false, path: markdownPath };
    }
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

  async readSidecarMetadata(document) {
    if (!document.path) return document;
    const metadataPath = document.path.replace(/\.pdf$/i, ".pdf.json");
    try {
      const metadata = JSON.parse(await readFile(resolve(this.root, metadataPath), "utf8"));
      return { ...document, ...metadata, path: document.path, metadataPath };
    } catch {
      return { ...document, metadataPath };
    }
  }

  async search({ question = "", searchText = "", filters = {}, limit = 10 } = {}) {
    const manifest = await this.readManifest();
    const terms = termsFrom(searchText || question);
    const requestedMatter = termsFrom(filters.materia || filters.materias?.[0] || "");
    const requestedYear = Number(filters.anio || filters.year || 0);
    const requestedMonth = Number(filters.mes || filters.month || 0);
    const indexedCandidates = await Promise.all(manifest.documents.map((document) => this.readSidecarMetadata(document)));
    const periodCandidates = indexedCandidates.filter((document) => {
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
    let createdMarkdown = 0;
    for (const { document } of selected) {
      const markdown = await this.ensureMarkdown(document);
      if (markdown.created) createdMarkdown += 1;
      const content = markdown.content;
      let pdfAvailable = false;
      if (document.path) {
        try { pdfAvailable = await fileExists(resolveLocalPdf(this.root, document.path)); } catch {}
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
        metadataPath: document.metadataPath || null,
        metadata: document,
        markdownPath: markdown.path,
        markdownCreated: markdown.created,
        content,
        pdf: { chars: content.length, truncated: content.length >= this.maxPdfChars },
        local: true
      });
    }
    const visibleDocuments = documents.slice(0, Math.min(Number(limit) || 10, 50));
    const results = visibleDocuments.map(({ content, pdf, ...result }) => ({ ...result, local: true, hasMarkdown: Boolean(content), pdfAvailable: Boolean(result.pdfUrl) }));
    return {
      search: { source: "local-archive", total: results.length, page: 1, totalPages: 1, results },
      documents: visibleDocuments,
      indexed: manifest.documents.length,
      periodCandidates: periodCandidates.length,
      scannedPdfs: selected.length,
      createdMarkdown,
      updatedAt: manifest.updatedAt,
      matchStrategy: metadataMatched ? "metadata" : "pdf-scan"
    };
  }
}
