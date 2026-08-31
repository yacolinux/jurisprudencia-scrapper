const MAX_QUESTION = 10_000;
const MAX_MODEL = 300;
const MAX_ANSWER = 400_000;
const MAX_REFERENCE_TEXT = 6_000;
const MAX_REFERENCES = 200;

function text(value, max) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}

function safeLink(value) {
  const link = text(value, 4_000);
  return /^(?:https?:\/\/|\/api\/local\/(?:file|markdown|metadata)\?path=)/i.test(link) ? link : null;
}

function normalizeReference(reference = {}) {
  const links = [];
  for (const link of Array.isArray(reference.links) ? reference.links : []) {
    const url = safeLink(link?.url);
    if (!url || links.some((item) => item.url === url)) continue;
    links.push({ label: text(link.label || "Abrir referencia", 120), url });
  }
  return {
    title: text(reference.title || "Resultado sin título", MAX_REFERENCE_TEXT),
    fallo: text(reference.fallo, MAX_REFERENCE_TEXT),
    expediente: text(reference.expediente, 1_000),
    materia: text(reference.materia, 500),
    fecha: text(reference.fecha, 200),
    path: text(reference.path, 4_000),
    links
  };
}

export function normalizeExportPayload(input = {}) {
  return {
    question: text(input.question, MAX_QUESTION),
    model: text(input.model || "Modelo predeterminado", MAX_MODEL),
    answer: text(input.answer || "No se generó una respuesta.", MAX_ANSWER),
    generatedAt: text(input.generatedAt || new Date().toISOString(), 100),
    references: (Array.isArray(input.references) ? input.references : []).slice(0, MAX_REFERENCES).map(normalizeReference)
  };
}

function answerLines(value) {
  return String(value || "").replace(/\r\n?/g, "\n").split("\n");
}

function markdownRuns(value, TextRun) {
  const runs = [];
  const pattern = /(\*\*|__)(.+?)\1/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(String(value))) !== null) {
    if (match.index > last) runs.push(new TextRun(String(value).slice(last, match.index)));
    runs.push(new TextRun({ text: match[2], bold: true }));
    last = match.index + match[0].length;
  }
  if (last < String(value).length) runs.push(new TextRun(String(value).slice(last)));
  return runs.length ? runs : [new TextRun("")];
}

function addMarkdownParagraphs(children, value, api) {
  const { Paragraph, TextRun, HeadingLevel } = api;
  for (const rawLine of answerLines(value)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      children.push(new Paragraph({ spacing: { after: 100 } }));
      continue;
    }
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      const level = heading[0].startsWith("###") ? HeadingLevel.HEADING_3 : heading[0].startsWith("##") ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1;
      children.push(new Paragraph({ heading: level, children: markdownRuns(heading[1], TextRun) }));
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    children.push(new Paragraph({
      children: markdownRuns(bullet ? bullet[1] : line, TextRun),
      ...(bullet ? { bullet: { level: 0 } } : {}),
      spacing: { after: 100, line: 276 }
    }));
  }
}

export async function createDocxExport(input) {
  const payload = normalizeExportPayload(input);
  const api = await import("docx");
  const { Document, ExternalHyperlink, HeadingLevel, Packer, Paragraph, TextRun } = api;
  const children = [
    new Paragraph({ children: [new TextRun({ text: "Resultados de consulta", bold: true, size: 32, color: "365F7D" })], spacing: { after: 180 } }),
    new Paragraph({ children: [new TextRun({ text: "Jurisprudencia asistida · STJ Corrientes", italics: true, color: "71808E" })], spacing: { after: 260 } }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, text: "Consulta" }),
    new Paragraph({ children: [new TextRun(payload.question || "Sin consulta registrada.")], spacing: { after: 160, line: 276 } }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, text: "Modelo IA utilizado" }),
    new Paragraph({ children: [new TextRun(payload.model)], spacing: { after: 160 } }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, text: "Respuesta" })
  ];
  addMarkdownParagraphs(children, payload.answer, { Paragraph, TextRun, HeadingLevel });
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, text: "Referencias de la búsqueda" }));
  if (!payload.references.length) {
    children.push(new Paragraph({ children: [new TextRun("No hubo referencias documentales.")] }));
  } else {
    payload.references.forEach((reference, index) => {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, text: `${index + 1}. ${reference.title}` }));
      const facts = [
        ["Fallo", reference.fallo],
        ["Expediente", reference.expediente],
        ["Materia", reference.materia],
        ["Fecha", reference.fecha],
        ["Archivo local", reference.path]
      ].filter(([, value]) => value);
      for (const [label, value] of facts) children.push(new Paragraph({ children: [new TextRun({ text: `${label}: `, bold: true }), new TextRun(value)], spacing: { after: 70 } }));
      for (const link of reference.links) {
        children.push(new Paragraph({ children: [new ExternalHyperlink({ children: [new TextRun({ text: `${link.label}: ${link.url}`, style: "Hyperlink" })], link: link.url })], spacing: { after: 70 } }));
      }
    });
  }
  const document = new Document({
    creator: "Consulta inteligente · STJ Corrientes",
    title: "Resultados de consulta",
    description: "Consulta, respuesta IA y referencias documentales.",
    sections: [{ properties: { page: { margin: { top: 1_080, right: 1_080, bottom: 1_080, left: 1_080 } } }, children }]
  });
  return Buffer.from(await Packer.toBuffer(document));
}

function wrapText(value, font, size, maxWidth) {
  const words = String(value || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function addPdfLink(page, pdf, x, y, width, height, url) {
  const context = pdf.context;
  const annotation = context.obj({ Type: "Annot", Subtype: "Link", Rect: [x, y - 2, x + width, y + height], Border: [0, 0, 0], A: { Type: "Action", S: "URI", URI: apiString(context, url) } });
  const annots = page.node.lookup(apiName("Annots"));
  if (annots) annots.push(annotation);
  else page.node.set(apiName("Annots"), context.obj([annotation]));
}

let pdfApi;
function apiName(value) { return pdfApi.PDFName.of(value); }
function apiString(context, value) { return pdfApi.PDFString.of(value); }

export async function createPdfExport(input) {
  const payload = normalizeExportPayload(input);
  pdfApi = await import("pdf-lib");
  const { PDFDocument, PageSizes, StandardFonts, rgb } = pdfApi;
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const width = PageSizes.A4[0];
  const height = PageSizes.A4[1];
  const margin = 48;
  const maxWidth = width - margin * 2;
  let page;
  let y;
  const lineHeight = (size) => size * 1.38;
  const ensurePage = (needed = 16) => {
    if (!page || y < margin + needed) {
      page = pdf.addPage(PageSizes.A4);
      y = height - margin;
    }
  };
  const drawBlock = (value, options = {}) => {
    const size = options.size || 10.5;
    const font = options.bold ? bold : regular;
    const color = options.color || rgb(0.14, 0.19, 0.24);
    for (const raw of String(value || "").split("\n")) {
      const lines = wrapText(raw, font, size, maxWidth);
      for (const line of lines) {
        ensurePage(lineHeight(size));
        page.drawText(line, { x: margin, y, size, font, color });
        y -= lineHeight(size);
      }
    }
    y -= options.after ?? 5;
  };
  const drawHeading = (value, size = 14) => drawBlock(value, { size, bold: true, color: rgb(0.21, 0.37, 0.49), after: 7 });
  const drawLink = (label, url) => {
    const value = `${label}: ${url}`;
    for (const line of wrapText(value, regular, 9, maxWidth)) {
      ensurePage(lineHeight(9));
      page.drawText(line, { x: margin, y, size: 9, font: regular, color: rgb(0.09, 0.48, 0.63) });
      addPdfLink(page, pdf, margin, y, regular.widthOfTextAtSize(line, 9), 9, url);
      y -= lineHeight(9);
    }
    y -= 2;
  };

  drawBlock("Resultados de consulta", { size: 20, bold: true, color: rgb(0.21, 0.37, 0.49), after: 2 });
  drawBlock("Jurisprudencia asistida · STJ Corrientes", { size: 10, color: rgb(0.44, 0.50, 0.55), after: 16 });
  drawHeading("Consulta");
  drawBlock(payload.question || "Sin consulta registrada.");
  drawHeading("Modelo IA utilizado");
  drawBlock(payload.model);
  drawHeading("Respuesta");
  for (const rawLine of answerLines(payload.answer)) {
    const line = rawLine.trim();
    if (!line) { y -= 5; continue; }
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) drawHeading(heading[1], heading[0].startsWith("###") ? 11 : 13);
    else drawBlock(line.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/^\s*[-*]\s+/, "- "), { after: 3 });
  }
  drawHeading("Referencias de la búsqueda");
  if (!payload.references.length) drawBlock("No hubo referencias documentales.");
  for (const [index, reference] of payload.references.entries()) {
    drawHeading(`${index + 1}. ${reference.title}`, 11.5);
    for (const [label, value] of [["Fallo", reference.fallo], ["Expediente", reference.expediente], ["Materia", reference.materia], ["Fecha", reference.fecha], ["Archivo local", reference.path]].filter(([, value]) => value)) drawBlock(`${label}: ${value}`, { size: 9.5, after: 2 });
    for (const link of reference.links) drawLink(link.label, link.url);
    y -= 5;
  }
  return Buffer.from(await pdf.save());
}

export function exportFilename(format) {
  return `resultados-consulta.${format}`;
}
