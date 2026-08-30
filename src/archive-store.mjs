import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

export const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"
];

export const MATERIAS = [
  "Amparo", "Civil y Comercial", "Conflicto de Poderes", "Electoral",
  "Habeas Data", "Laboral", "Menores", "Penal", "Proc. Administrativo",
  "Superintendencia"
];

const EMPTY_MANIFEST = { version: 1, updatedAt: null, documents: [] };

export function slugify(value, fallback = "sin-dato") {
  const slug = String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return slug || fallback;
}

export function parseCourtDate(value) {
  const raw = String(value ?? "").trim();
  let match = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (!match) match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!match) return null;
  const [, first, second, third] = match;
  const isIso = first.length === 4;
  const year = Number(isIso ? first : third);
  const month = Number(second);
  const day = Number(isIso ? third : first);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return { year, month, day, dateKey: `${String(day).padStart(2, "0")}-${String(month).padStart(2, "0")}-${year}` };
}

export function isoWeekNumber(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const firstDay = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  return Math.ceil((((thursday - firstDay) / 86_400_000) + 1) / 7);
}

export function archiveRelativePath({ date, materia, id, fallo, caratula }) {
  const week = String(isoWeekNumber(date.year, date.month, date.day)).padStart(2, "0");
  const matter = slugify(materia, "sin-materia");
  const number = String(id || fallo || "fallo").replace(/[^0-9]/g, "").slice(-8).padStart(6, "0");
  const title = slugify(caratula || fallo || "fallo");
  const filename = `${number}-${date.dateKey}-${title}.pdf`;
  return join(String(date.year), `${String(date.month).padStart(2, "0")}-${MONTHS[date.month - 1]}`, `semana-${week}`, date.dateKey, matter, filename);
}

async function exists(file) {
  try { await access(file, constants.F_OK); return true; } catch { return false; }
}

export class ArchiveStore {
  constructor(root = process.env.DATA_DIR || join(process.cwd(), "data")) {
    this.root = resolve(root);
    this.manifestPath = join(this.root, "manifest.json");
    this.manifest = null;
  }

  async init() {
    await mkdir(this.root, { recursive: true });
    try {
      this.manifest = JSON.parse(await readFile(this.manifestPath, "utf8"));
      if (!Array.isArray(this.manifest.documents)) throw new Error("manifest inválido");
    } catch {
      this.manifest = { ...EMPTY_MANIFEST, documents: [] };
      await this.#persistManifest();
    }
    return this;
  }

  async #persistManifest() {
    this.manifest.updatedAt = new Date().toISOString();
    const temporary = `${this.manifestPath}.tmp`;
    await writeFile(temporary, JSON.stringify(this.manifest, null, 2));
    await rename(temporary, this.manifestPath);
  }

  #requireInit() {
    if (!this.manifest) throw new Error("ArchiveStore no inicializado");
  }

  find({ id, source }) {
    this.#requireInit();
    return this.manifest.documents.find((document) => (id && String(document.id) === String(id)) || (source && document.source === source)) || null;
  }

  async save({ metadata, pdfBytes }) {
    this.#requireInit();
    const existing = this.find({ id: metadata.id, source: metadata.source });
    if (existing && await exists(join(this.root, existing.path))) return { status: "cached", document: existing };
    const date = parseCourtDate(metadata.fecha);
    if (!date) throw new Error(`No se pudo interpretar la fecha del fallo: ${metadata.fecha || "vacía"}`);
    const path = archiveRelativePath({ date, materia: metadata.materia, id: metadata.id, fallo: metadata.fallo, caratula: metadata.caratula });
    const absolute = resolve(this.root, path);
    if (!absolute.startsWith(`${this.root}${sep}`)) throw new Error("Ruta de archivo fuera del archivo local");
    await mkdir(dirname(absolute), { recursive: true });
    const temporary = `${absolute}.part`;
    await writeFile(temporary, pdfBytes);
    await rename(temporary, absolute);
    const document = {
      ...metadata,
      path,
      bytes: pdfBytes.length,
      savedAt: new Date().toISOString()
    };
    const index = this.manifest.documents.findIndex((item) => (metadata.id && String(item.id) === String(metadata.id)) || (metadata.source && item.source === metadata.source));
    if (index >= 0) this.manifest.documents[index] = document;
    else this.manifest.documents.push(document);
    await writeFile(`${absolute}.json`, JSON.stringify(document, null, 2));
    await this.#persistManifest();
    return { status: "downloaded", document };
  }

  async summary() {
    this.#requireInit();
    const documents = this.manifest.documents;
    const byYear = {};
    const byMonth = {};
    const byMatter = {};
    for (const document of documents) {
      const date = parseCourtDate(document.fecha);
      if (date) {
        byYear[date.year] = (byYear[date.year] || 0) + 1;
        const key = `${date.year}-${String(date.month).padStart(2, "0")}`;
        byMonth[key] = (byMonth[key] || 0) + 1;
      }
      const matter = document.materia || "Sin materia";
      byMatter[matter] = (byMatter[matter] || 0) + 1;
    }
    return { root: this.root, total: documents.length, updatedAt: this.manifest.updatedAt, byYear, byMonth, byMatter };
  }

  async list({ year, month, limit = 100 } = {}) {
    this.#requireInit();
    return this.manifest.documents.filter((document) => {
      const date = parseCourtDate(document.fecha);
      return (!year || date?.year === Number(year)) && (!month || date?.month === Number(month));
    }).slice(-Math.min(Number(limit) || 100, 500)).reverse();
  }

  resolveRelative(relativePath) {
    this.#requireInit();
    const target = resolve(this.root, relativePath);
    if (!target.startsWith(`${this.root}${sep}`) || extname(target).toLocaleLowerCase() !== ".pdf") throw new Error("Archivo no permitido");
    return target;
  }
}

export { basename };
