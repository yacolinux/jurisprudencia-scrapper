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

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function truncateUtf8(value, maxBytes) {
  const text = String(value ?? "");
  if (maxBytes <= 0) return "";
  if (byteLength(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(text.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

function contextDocument(result, markdown = result.content) {
  return {
    metadata: result.metadata || {
      id: result.id,
      title: result.title,
      source: result.source,
      localPath: result.localPath,
      markdownPath: result.markdownPath,
      materia: result.materia,
      fecha: result.fecha,
      expediente: result.expediente
    },
    markdown
  };
}

function reviewDocument(result, reason = null) {
  return {
    id: result.id,
    title: result.title,
    fallo: result.fallo,
    expediente: result.expediente,
    materia: result.materia,
    fecha: result.fecha,
    source: result.source,
    pdfUrl: result.pdfUrl,
    localPath: result.localPath,
    markdownPath: result.markdownPath,
    metadataPath: result.metadataPath,
    ...(reason ? { reason } : {})
  };
}

function contextBytes(documents) {
  return byteLength(JSON.stringify({ search: { total: documents.length }, documents }));
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

export function resolveLocalMarkdown(root, relativePath) {
  const archiveRoot = resolve(root);
  const markdownPath = String(relativePath || "").replace(/\.pdf$/i, ".md");
  const file = resolve(archiveRoot, markdownPath);
  if (!file.startsWith(archiveRoot + sep) || extname(file).toLocaleLowerCase() !== ".md") {
    throw Object.assign(new Error("Archivo Markdown local no permitido"), { code: "LOCAL_FILE_NOT_ALLOWED" });
  }
  return file;
}

export function resolveLocalMetadata(root, relativePath) {
  const archiveRoot = resolve(root);
  const metadataPath = String(relativePath || "");
  const file = resolve(archiveRoot, metadataPath);
  if (!file.startsWith(archiveRoot + sep) || !metadataPath.toLocaleLowerCase().endsWith(".pdf.json")) {
    throw Object.assign(new Error("Archivo JSON local no permitido"), { code: "LOCAL_FILE_NOT_ALLOWED" });
  }
  return file;
}

export class LocalArchiveSearch {
  constructor(root, { writeRoot = process.env.DATA_WRITE_DIR || root, maxPdfChars = Number(process.env.MAX_PDF_CHARS || 100_000), pdfTimeoutMs = Number(process.env.LOCAL_PDF_TIMEOUT_MS || 12_000), maxContextBytes = Number(process.env.LOCAL_CONTEXT_MAX_BYTES || 100 * 1024), extractText = extractPdfText } = {}) {
    this.root = resolve(root);
    this.writeRoot = resolve(writeRoot);
    this.manifestPath = join(this.root, "manifest.json");
    this.maxPdfChars = Math.max(1, Number(maxPdfChars) || 100_000);
    this.pdfTimeoutMs = pdfTimeoutMs;
    this.maxContextBytes = Math.max(1, Number(maxContextBytes) || 100 * 1024);
    this.extractText = extractText;
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
      if (await fileExists(file)) extracted = await this.extractText(file, this.maxPdfChars, this.pdfTimeoutMs);
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
    let manifest;
    try {
      manifest = JSON.parse(await readFile(this.manifestPath, "utf8"));
      if (!Array.isArray(manifest.documents)) throw Object.assign(new Error("manifest sin documentos"), { code: "LOCAL_INDEX_INVALID" });
    } catch (error) {
      if (error.code === "ENOENT") manifest = { version: 1, updatedAt: null, documents: [] };
      if (error.code === "LOCAL_INDEX_INVALID") throw error;
      if (error.code !== "ENOENT" && error.code !== "LOCAL_INDEX_INVALID") throw Object.assign(new Error("No se pudo leer el índice local: " + error.message), { code: "LOCAL_INDEX_INVALID" });
    }
    let extra = { version: 1, updatedAt: null, documents: [] };
    try {
      extra = JSON.parse(await readFile(join(this.root, ".query-archive.json"), "utf8"));
      if (!Array.isArray(extra.documents)) extra.documents = [];
    } catch (error) {
      if (error.code !== "ENOENT") throw Object.assign(new Error("No se pudo leer el índice de capturas remotas: " + error.message), { code: "LOCAL_INDEX_INVALID" });
    }
    const documents = [...manifest.documents];
    for (const document of extra.documents) {
      const existing = documents.findIndex((item) => (document.id && String(item.id) === String(document.id)) || (document.source && item.source === document.source) || item.path === document.path);
      if (existing >= 0) documents[existing] = { ...documents[existing], ...document };
      else documents.push(document);
    }
    return { ...manifest, documents, updatedAt: extra.updatedAt || manifest.updatedAt };
  }

  async findByIdentity({ id, source } = {}) {
    const manifest = await this.readManifest();
    for (const document of manifest.documents) {
      if (!((id && String(document.id) === String(id)) || (source && document.source === source))) continue;
      if (!document.path) continue;
      try {
        if (await fileExists(resolveLocalPdf(this.root, document.path))) return this.readSidecarMetadata(document);
      } catch {}
    }
    return null;
  }

  async materialize(document) {
    const enriched = await this.readSidecarMetadata(document);
    const markdown = await this.ensureMarkdown(enriched);
    let pdfAvailable = false;
    if (enriched.path) {
      try { pdfAvailable = await fileExists(resolveLocalPdf(this.root, enriched.path)); } catch {}
    }
    const result = {
      id: enriched.id ? Number(enriched.id) : null,
      title: enriched.caratula || enriched.fallo || ("Fallo " + (enriched.id || "")).trim(),
      fallo: enriched.fallo,
      expediente: enriched.expediente,
      materia: enriched.materia,
      fecha: enriched.fecha,
      source: enriched.source || ("local:" + (enriched.path || "")),
      pdfUrl: pdfAvailable && enriched.path ? "/api/local/file?path=" + encodeURIComponent(enriched.path) : null,
      localPath: enriched.path || null,
      metadataPath: enriched.metadataPath || null,
      metadata: enriched,
      markdownPath: markdown.path,
      markdownCreated: markdown.created,
      content: markdown.content,
      pdf: { chars: markdown.content.length, truncated: markdown.content.length >= this.maxPdfChars },
      local: true
    };
    return { result, createdMarkdown: markdown.created ? 1 : 0 };
  }

  async readSidecarMetadata(document) {
    if (!document.path) return document;
    const metadataPath = document.path.replace(/\.pdf$/i, ".pdf.json");
    try {
      const metadata = JSON.parse(await readFile(resolveLocalMetadata(this.root, metadataPath), "utf8"));
      return { ...document, ...metadata, path: document.path, metadataPath };
    } catch {
      return { ...document, metadataPath };
    }
  }

  async search({ question = "", searchText = "", filters = {}, allDocuments = false } = {}) {
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
    // La consulta local no tiene un límite fijo de cantidad. Se materializa y
    // agrega cada candidato hasta alcanzar el presupuesto del contexto.
    const selected = metadataMatched
      ? matchingCandidates
      : periodCandidates.map((document, index) => ({ document, score: 0, index }));
    const documents = [];
    const contextDocuments = [];
    const candidateDocuments = [];
    const omittedDocuments = [];
    let createdMarkdown = 0;
    let omittedByContext = 0;
    for (const { document } of selected) {
      const materialized = await this.materialize(document);
      createdMarkdown += materialized.createdMarkdown;
      let { result } = materialized;
      const content = result.content;
      if (!metadataMatched && terms.length && !terms.some((term) => normalize(content).includes(term))) continue;
      candidateDocuments.push(reviewDocument(result));
      const entry = contextDocument(result);
      const contextLimitBytes = allDocuments ? Number.MAX_SAFE_INTEGER : this.maxContextBytes;
      const nextBytes = contextBytes([...contextDocuments, entry]);
      if (nextBytes > contextLimitBytes) {
        const remaining = contextLimitBytes - contextBytes([...contextDocuments, contextDocument(result, "")]);
        if (remaining > 0 && content) {
          const truncated = truncateUtf8(content, remaining);
          const truncatedEntry = contextDocument(result, truncated);
          if (contextBytes([...contextDocuments, truncatedEntry]) <= contextLimitBytes) {
            result = { ...result, content: truncated, contextTruncated: true, pdf: { ...result.pdf, chars: truncated.length, truncated: true } };
            documents.push(result);
            contextDocuments.push(truncatedEntry);
            continue;
          }
        }
        omittedByContext += 1;
        omittedDocuments.push(reviewDocument(result, "exceso del presupuesto de contexto"));
        continue;
      }
      documents.push(result);
      contextDocuments.push(entry);
    }
    const sentIds = new Set(documents.map((document) => String(document.id || document.localPath || document.source)));
    const results = candidateDocuments.map((candidate) => ({
      ...candidate,
      local: true,
      hasMarkdown: Boolean(documents.find((document) => String(document.id || document.localPath || document.source) === String(candidate.id || candidate.localPath || candidate.source))?.content),
      pdfAvailable: Boolean(candidate.localPath),
      contextIncluded: sentIds.has(String(candidate.id || candidate.localPath || candidate.source)),
      contextOmitted: omittedDocuments.some((document) => String(document.id || document.localPath || document.source) === String(candidate.id || candidate.localPath || candidate.source))
    }));
    return {
      search: { source: "local-archive", total: results.length, page: 1, totalPages: 1, results },
      documents,
      indexed: manifest.documents.length,
      periodCandidates: periodCandidates.length,
      scannedPdfs: selected.length,
      createdMarkdown,
      contextBytes: contextBytes(contextDocuments),
      contextLimitBytes: allDocuments ? null : this.maxContextBytes,
      contextAllDocuments: allDocuments,
      contextCandidates: candidateDocuments,
      contextSent: documents.map((document) => reviewDocument(document)),
      contextOmitted: omittedDocuments,
      omittedByContext,
      updatedAt: manifest.updatedAt,
      matchStrategy: metadataMatched ? "metadata" : "pdf-scan"
    };
  }
}
