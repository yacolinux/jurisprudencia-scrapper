import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ArchiveStore, archiveRelativePath, parseCourtDate } from "../src/archive-store.mjs";
import { BatchCollector, validateBatchInput } from "../src/collector.mjs";
import { LocalArchiveSearch, detectDocumentLookup, resolveLocalPdf } from "../src/local-search.mjs";
import { archiveMissingRemote } from "../src/remote-archive.mjs";
import { normalizeExportPayload } from "../src/export.mjs";

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

test("la consulta local no limita la cantidad de documentos a tres", async () => {
  const root = await mkdtemp(join(tmpdir(), "archivo-jurisprudencia-local-many-"));
  try {
    const documents = Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      materia: "Amparo",
      fecha: "25-08-2026",
      caratula: `Criterio IOSCOR ${index + 1}`,
      path: `2026/08-agosto/semana-35/25-08-2026/amparo/fallo-${index + 1}.pdf`
    }));
    await writeFile(join(root, "manifest.json"), JSON.stringify({ version: 1, documents }));
    for (const document of documents) {
      const markdownPath = join(root, document.path.replace(/\.pdf$/i, ".md"));
      await mkdir(join(markdownPath, ".."), { recursive: true });
      await writeFile(markdownPath, `# ${document.caratula}\n\nEl fallo explica el criterio de cobertura de IOSCOR.`);
    }
    const search = new LocalArchiveSearch(root, { maxContextBytes: 100 * 1024 });
    const result = await search.search({ question: "criterios de amparo contra IOSCOR", filters: { materia: "Amparo" } });
    assert.equal(result.documents.length, 5);
    assert.equal(result.search.total, 5);
    assert.ok(result.contextBytes <= result.contextLimitBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detecta una búsqueda de documentos y respeta año, mes y categoría", async () => {
  const root = await mkdtemp(join(tmpdir(), "archivo-jurisprudencia-lookup-test-"));
  try {
    const documents = [
      { id: 1, materia: "Civil y Comercial", fecha: "24-05-2024", caratula: "Fallo sobre daños", path: "2024/05-mayo/semana-21/24-05-2024/civil-y-comercial/fallo-1.pdf" },
      { id: 2, materia: "Civil y Comercial", fecha: "24-05-2024", caratula: "Fallo sobre contratos", path: "2024/05-mayo/semana-21/24-05-2024/civil-y-comercial/fallo-2.pdf" },
      { id: 3, materia: "Civil y Comercial", fecha: "24-06-2024", caratula: "Fernandez fuera del mes", path: "2024/06-junio/semana-26/24-06-2024/civil-y-comercial/fallo-3.pdf" }
    ];
    await writeFile(join(root, "manifest.json"), JSON.stringify({ version: 1, documents }));
    for (const document of documents) {
      const markdownPath = join(root, document.path.replace(/\.pdf$/i, ".md"));
      await mkdir(dirname(markdownPath), { recursive: true });
      await writeFile(markdownPath, document.id === 1 ? "Comparece el señor Fernández en estas actuaciones." : "El apellido informado es Garcia.");
    }
    assert.deepEqual(detectDocumentLookup("Quiero saber en qué documentos aparece el apellido \"Fernandez\""), { term: "fernandez", displayTerm: "Fernandez" });
    const search = new LocalArchiveSearch(root);
    const result = await search.search({ question: "Quiero saber en qué documentos aparece el apellido \"Fernandez\"", filters: { year: 2024, month: 5, categorias: ["Civil y Comercial"] } });
    assert.equal(result.matchStrategy, "document-lookup");
    assert.equal(result.periodCandidates, 2);
    assert.deepEqual(result.search.results.map((item) => item.id), [1]);
    assert.equal(result.documents[0].lookupMatch.content, true);
    assert.match(result.documents[0].content, /Fernández/);
    assert.equal(result.contextOmitted.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("la búsqueda documental materializa un PDF faltante y conserva el original", async () => {
  const root = await mkdtemp(join(tmpdir(), "archivo-jurisprudencia-lookup-pdf-test-"));
  try {
    const document = {
      id: 2,
      materia: "Laboral",
      fecha: "22-05-2024",
      caratula: "Fallo sin Markdown",
      path: "2024/05-mayo/semana-21/22-05-2024/laboral/fallo.pdf"
    };
    await writeFile(join(root, "manifest.json"), JSON.stringify({ version: 1, documents: [document] }));
    const pdfPath = join(root, document.path);
    await mkdir(dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, "%PDF-original");
    const search = new LocalArchiveSearch(root, { extractText: async () => "El apellido Fernández aparece en el fallo." });
    const result = await search.search({ question: "¿En qué documentos aparece el apellido Fernandez?", filters: { year: 2024, month: 5, materia: "Laboral" } });
    assert.equal(result.createdMarkdown, 1);
    assert.equal(result.search.total, 1);
    assert.equal(result.documents[0].markdownCreated, true);
    assert.match(result.documents[0].content, /Fernández/);
    assert.equal(await readFile(pdfPath, "utf8"), "%PDF-original");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("la consulta local respeta el presupuesto aproximado de 100 KiB", async () => {
  const root = await mkdtemp(join(tmpdir(), "archivo-jurisprudencia-local-budget-"));
  try {
    const documents = Array.from({ length: 3 }, (_, index) => ({
      id: index + 1,
      materia: "Amparo",
      fecha: "25-08-2026",
      caratula: `Fallo extenso ${index + 1}`,
      path: `2026/08-agosto/semana-35/25-08-2026/amparo/extenso-${index + 1}.pdf`
    }));
    await writeFile(join(root, "manifest.json"), JSON.stringify({ version: 1, documents }));
    for (const document of documents) {
      const markdownPath = join(root, document.path.replace(/\.pdf$/i, ".md"));
      await mkdir(join(markdownPath, ".."), { recursive: true });
      await writeFile(markdownPath, "criterios ".repeat(7_000));
    }
    const search = new LocalArchiveSearch(root, { maxContextBytes: 100 * 1024 });
    const result = await search.search({ question: "criterios", filters: { materia: "Amparo" } });
    assert.equal(result.contextCandidates.length, 3);
    assert.equal(result.contextOmitted.length, 1);
    assert.ok(result.documents.length >= 2);
    assert.ok(result.contextBytes <= 100 * 1024);
    assert.ok(result.documents.some((document) => document.contextTruncated));
    const retry = await search.search({ question: "criterios", filters: { materia: "Amparo" }, allDocuments: true });
    assert.equal(retry.contextCandidates.length, 3);
    assert.equal(retry.contextOmitted.length, 0);
    assert.equal(retry.documents.length, 3);
    assert.equal(retry.contextLimitBytes, null);
    assert.ok(retry.contextBytes > 100 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("crea el Markdown derivado antes de incluir un PDF local en la consulta", async () => {
  const root = await mkdtemp(join(tmpdir(), "archivo-jurisprudencia-local-markdown-"));
  try {
    const document = {
      id: 999,
      materia: "Amparo",
      fecha: "25-08-2026",
      caratula: "Fallo sin Markdown",
      path: "2026/08-agosto/semana-35/25-08-2026/amparo/sin-markdown.pdf"
    };
    await writeFile(join(root, "manifest.json"), JSON.stringify({ version: 1, documents: [document] }));
    const pdfPath = join(root, document.path);
    await mkdir(join(pdfPath, ".."), { recursive: true });
    await writeFile(pdfPath, "%PDF-original");
    const search = new LocalArchiveSearch(root, { extractText: async () => "Texto derivado del fallo y su criterio." });
    const result = await search.search({ question: "criterio", filters: { materia: "Amparo" } });
    const markdownPath = join(root, document.path.replace(/\.pdf$/i, ".md"));
    assert.equal(result.createdMarkdown, 1);
    assert.equal(result.documents[0].markdownCreated, true);
    assert.match(await readFile(markdownPath, "utf8"), /Texto derivado/);
    assert.equal((await readFile(pdfPath, "utf8")), "%PDF-original");
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

test("la exportación conserva consulta, modelo, respuesta y enlaces permitidos", () => {
  const result = normalizeExportPayload({
    question: "criterios de amparo",
    model: "opencode/big-pickle",
    answer: "Respuesta de prueba",
    references: [{
      title: "Fallo local",
      links: [
        { label: "PDF", url: "http://localhost:3001/api/local/file?path=fallo.pdf" },
        { label: "No permitido", url: "javascript:alert(1)" }
      ]
    }]
  });
  assert.equal(result.question, "criterios de amparo");
  assert.equal(result.model, "opencode/big-pickle");
  assert.equal(result.answer, "Respuesta de prueba");
  assert.deepEqual(result.references[0].links, [{ label: "PDF", url: "http://localhost:3001/api/local/file?path=fallo.pdf" }]);
});
