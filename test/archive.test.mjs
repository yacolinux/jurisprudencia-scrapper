import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchiveStore, archiveRelativePath, parseCourtDate } from "../src/archive-store.mjs";
import { BatchCollector, validateBatchInput } from "../src/collector.mjs";
import { LocalArchiveSearch, resolveLocalPdf } from "../src/local-search.mjs";
import { archiveMissingRemote } from "../src/remote-archive.mjs";

test("interpreta fechas del portal y genera una ruta humana", () => {
  const date = parseCourtDate("25-08-2026");
  assert.deepEqual(date, { year: 2026, month: 8, day: 25, dateKey: "25-08-2026" });
  assert.match(archiveRelativePath({ date, materia: "Amparo", id: 123, caratula: "Acción / IOSCOR" }), /^2026\/08-agosto\/semana-35\/25-08-2026\/amparo\/000123-25-08-2026-accion-ioscor\.pdf$/);
});

test("el archivo persiste un PDF y detecta la caché", async () => {
  const root = await mkdtemp(join(tmpdir(), "archivo-jurisprudencia-test-"));
  try {
    const store = await new ArchiveStore(root).init();
    const metadata = { id: 123, materia: "Amparo", fecha: "25-08-2026", caratula: "Acción", source: "https://jurisprudencia.juscorrientes.gov.ar/ver-pdf/123" };
    const first = await store.save({ metadata, pdfBytes: Buffer.from("%PDF-test") });
    const second = await store.save({ metadata, pdfBytes: Buffer.from("%PDF-different") });
    assert.equal(first.status, "downloaded");
    assert.equal(second.status, "cached");
    assert.equal((await store.summary()).total, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("valida período y normaliza todas las materias", () => {
  const input = validateBatchInput({ year: 2026, month: 8, materias: [] });
  assert.equal(input.year, 2026);
  assert.equal(input.month, 8);
  assert.equal(input.materias.length, 10);
  assert.equal(validateBatchInput({ year: 2026, month: "all", materias: ["Amparo"] }).month, null);
  assert.throws(() => validateBatchInput({ year: 2026, month: 13 }), /mes/);
});

test("Todo el año usa la paginación anual compatible y procesa secuencialmente", async () => {
  const calls = [];
  const collector = new BatchCollector({
    client: { search: async (filters) => { calls.push(filters); return { results: [], totalPages: 1 }; } },
    store: { find: () => null, save: async () => ({ status: "downloaded", document: {} }) },
    delayMs: 0
  });
  const result = await collector.run({ year: 2026, month: "all", materias: ["Amparo"] });
  assert.equal(result.monthsCompleted, 12);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, undefined);
});

test("espera entre búsquedas remotas consecutivas", async () => {
  const calls = [];
  const collector = new BatchCollector({
    client: { search: async () => { calls.push(Date.now()); return { results: [], totalPages: 1 }; } },
    store: { find: () => null, save: async () => ({ status: "downloaded", document: {} }) },
    delayMs: 0,
    searchDelayMs: 25
  });
  await collector.run({ year: 2026, month: "all", materias: ["Amparo", "Penal"] });
  assert.equal(calls.length, 2);
  assert.ok(calls[1] - calls[0] >= 20);
});

test("termina una categoría cuando el portal no informa totalPages", async () => {
  let calls = 0;
  const collector = new BatchCollector({
    client: { search: async () => { calls += 1; return { results: [{ id: 1, fecha: "01-01-2018", materia: "Amparo" }], totalPages: null }; } },
    store: { find: () => ({ id: 1 }), save: async () => ({ status: "downloaded", document: {} }) },
    delayMs: 0,
    searchDelayMs: 0
  });
  await collector.run({ year: 2018, month: "all", materias: ["Amparo"] });
  assert.equal(calls, 1);
});

test("la búsqueda local lee el manifest sin crearlo ni modificarlo", async () => {
  const root = await mkdtemp(join(tmpdir(), "archivo-jurisprudencia-local-test-"));
  try {
    const manifest = {
      version: 1,
      updatedAt: "2026-08-30T00:00:00.000Z",
      documents: [
        { id: 123, materia: "Amparo", fecha: "25-08-2026", caratula: "Acción de cobertura de salud", path: "2026/08-agosto/semana-35/25-08-2026/amparo/fallo.pdf" },
        { id: 456, materia: "Penal", fecha: "20-08-2026", caratula: "Recurso de queja", path: "2026/08-agosto/semana-34/20-08-2026/penal/fallo.pdf" }
      ]
    };
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
    const search = new LocalArchiveSearch(root, { pdfScanLimit: 0 });
    const result = await search.search({ question: "cobertura de salud", limit: 5 });
    assert.equal(result.search.source, "local-archive");
    assert.equal(result.search.results[0].id, 123);
    assert.equal(result.indexed, 2);
    assert.throws(() => resolveLocalPdf(root, "../outside.pdf"), /no permitido/);
    assert.equal((await readFile(join(root, "manifest.json"), "utf8")).includes("Acción de cobertura"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("la ampliación remota archiva solo faltantes sin tocar el PDF existente", async () => {
  const root = await mkdtemp(join(tmpdir(), "archivo-jurisprudencia-remoto-test-"));
  try {
    const metadata = { id: 789, materia: "Amparo", fecha: "25-08-2026", caratula: "Archivo remoto", source: "https://jurisprudencia.juscorrientes.gov.ar/ver-pdf/789" };
    const first = await archiveMissingRemote({ root, metadata, pdfBytes: Buffer.from("%PDF-original") });
    const second = await archiveMissingRemote({ root, metadata, pdfBytes: Buffer.from("%PDF-reemplazo") });
    assert.equal(first.status, "downloaded");
    assert.equal(second.status, "cached");
    assert.equal((await readFile(join(root, first.document.path))).toString(), "%PDF-original");
    assert.equal((await readFile(join(root, ".query-archive.json"), "utf8")).includes("Archivo remoto"), true);
    const local = new LocalArchiveSearch(root, { pdfScanLimit: 0 });
    assert.equal((await local.findByIdentity({ id: 789 }))?.path, first.document.path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
