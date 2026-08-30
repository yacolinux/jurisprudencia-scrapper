import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { archiveRelativePath, parseCourtDate } from "./archive-store.mjs";

async function exists(file) {
  try { await access(file, constants.F_OK); return true; } catch { return false; }
}

function safePath(root, relativePath) {
  const base = resolve(root);
  const target = resolve(base, relativePath);
  if (!target.startsWith(`${base}${sep}`)) throw new Error("Ruta de archivo fuera del archivo local");
  return target;
}

async function appendQueryIndex(writeRoot, document) {
  const indexPath = join(resolve(writeRoot), ".query-archive.json");
  let index = { version: 1, updatedAt: null, documents: [] };
  try {
    index = JSON.parse(await readFile(indexPath, "utf8"));
    if (!Array.isArray(index.documents)) index.documents = [];
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`No se pudo leer el índice adicional: ${error.message}`);
  }
  const identity = (item) => (document.id && String(item.id) === String(document.id)) || (document.source && item.source === document.source) || item.path === document.path;
  const position = index.documents.findIndex(identity);
  if (position >= 0) index.documents[position] = { ...index.documents[position], ...document };
  else index.documents.push(document);
  index.updatedAt = new Date().toISOString();
  await mkdir(dirname(indexPath), { recursive: true });
  const temporary = `${indexPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(index, null, 2));
  await rename(temporary, indexPath);
}

/**
 * Archives a remote PDF only when its identity was not found locally.
 * It never replaces an existing PDF, sidecar JSON, or manifest.json.
 */
export async function archiveMissingRemote({ root, writeRoot = root, metadata, pdfBytes }) {
  const date = parseCourtDate(metadata.fecha);
  if (!date) return { status: "skipped", reason: "missing-date" };
  if (!Buffer.isBuffer(pdfBytes) || pdfBytes.length === 0) return { status: "skipped", reason: "empty-pdf" };
  const relativePath = archiveRelativePath({
    date,
    materia: metadata.materia,
    id: metadata.id,
    fallo: metadata.fallo,
    caratula: metadata.caratula
  });
  const sourceFile = safePath(root, relativePath);
  const targetFile = safePath(writeRoot, relativePath);
  if (await exists(sourceFile) || await exists(targetFile)) return { status: "cached", document: { ...metadata, path: relativePath } };

  await mkdir(dirname(targetFile), { recursive: true });
  try {
    await writeFile(targetFile, pdfBytes, { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") return { status: "cached", document: { ...metadata, path: relativePath } };
    throw error;
  }

  const document = {
    ...metadata,
    path: relativePath,
    bytes: pdfBytes.length,
    savedAt: new Date().toISOString()
  };
  try {
    await writeFile(`${targetFile}.json`, JSON.stringify(document, null, 2), { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await appendQueryIndex(writeRoot, document);
  return { status: "downloaded", document };
}
