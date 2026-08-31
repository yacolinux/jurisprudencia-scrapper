import { spawn } from "node:child_process";

const DEFAULT_MODEL = process.env.OPENCODE_MODEL || "opencode/muse-spark-1.2-contributor-free";
const DEFAULT_CONTEXT_BYTES = Number(process.env.LOCAL_CONTEXT_MAX_BYTES || 100 * 1024);
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";

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

function contextEntry(document, markdown = document.content) {
  return {
    metadata: document.metadata || {
      id: document.id,
      title: document.title,
      source: document.source,
      localPath: document.localPath,
      markdownPath: document.markdownPath,
      materia: document.materia,
      fecha: document.fecha,
      expediente: document.expediente
    },
    markdown
  };
}

function serializedContext(search, documents) {
  return JSON.stringify({
    search: { source: search?.source, total: search?.total },
    documents
  });
}

function fitContext({ search, documents, maxBytes = DEFAULT_CONTEXT_BYTES }) {
  const selected = [];
  let omitted = 0;
  for (const document of documents) {
    const entry = contextEntry(document);
    if (byteLength(serializedContext(search, [...selected, entry])) <= maxBytes) {
      selected.push(entry);
      continue;
    }
    const remaining = maxBytes - byteLength(serializedContext(search, [...selected, contextEntry(document, "")]));
    if (remaining > 0 && document.content) {
      const markdown = truncateUtf8(document.content, remaining);
      const truncated = contextEntry(document, markdown);
      if (byteLength(serializedContext(search, [...selected, truncated])) <= maxBytes) {
        selected.push(truncated);
        continue;
      }
    }
    omitted += 1;
  }
  return { selected, bytes: byteLength(serializedContext(search, selected)), omitted };
}

function validModel(value) {
  const model = String(value || "").trim();
  return /^opencode\/[a-z0-9][a-z0-9._-]{1,180}$/i.test(model) ? model : null;
}

function parseOpenCodeEvents(stdout) {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const texts = [];
  let completed = false;
  let eventError = null;
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const candidates = [event.text, event.part?.text, event.message?.content, event.data?.text];
      const text = candidates.find((value) => typeof value === "string" && value.trim());
      if (text) texts.push(text);
      if (event.type === "step_finish" && event.part?.reason === "stop") completed = true;
      if (event.type === "error") eventError = event.error?.message || event.message || "OpenCode informó un error";
    } catch {
      // El formato estándar puede mezclar texto legible y eventos no JSON.
    }
  }
  return { text: texts.join("").trim() || stdout.trim(), completed, eventError };
}

function classifyOpenCodeError(error) {
  const raw = [error?.message, error?.stderr, error?.stdout].filter(Boolean).join(" ");
  const normalized = raw.toLocaleLowerCase("es");
  if (error?.code === "OPENCODE_TIMEOUT") {
    return {
      code: "OPENCODE_TIMEOUT",
      title: "La IA excedió el tiempo máximo",
      message: `OpenCode no respondió dentro de ${error.timeoutMs || 30_000} ms.`,
      action: "Elegí otro modelo free, reducí el material o aumentá OPENCODE_TIMEOUT_MS y volvé a intentar."
    };
  }
  if (error?.code === "OPENCODE_CONTEXT_LIMIT" || /context|contexto|token|too large|too many|maximum.*(input|token)|413|payload/.test(normalized)) {
    return {
      code: "OPENCODE_CONTEXT_LIMIT",
      title: "La IA rechazó el exceso de contexto",
      message: "El material enviado supera el contexto que OpenCode puede procesar con este modelo.",
      action: "Probá con otro modelo o reducí la consulta; el reintento con todos los documentos puede volver a superar este límite."
    };
  }
  if (error?.code === "ENOENT") {
    return {
      code: "OPENCODE_NOT_FOUND",
      title: "OpenCode no está instalado o no está disponible",
      message: error.message,
      action: "Revisá la instalación y configuración de OpenCode y volvé a verificar."
    };
  }
  return {
    code: error?.code || "OPENCODE_ERROR",
    title: "La IA no pudo completar la consulta",
    message: error?.message || "OpenCode devolvió un error inesperado.",
    action: "Volvé a intentar o elegí otro modelo free."
  };
}

function runOpenCode({ model, prompt, timeoutMs = Number(process.env.OPENCODE_TIMEOUT_MS || 90_000) }) {
  return new Promise((resolve, reject) => {
    const args = ["run", "--pure", "--format", "json"];
    if (model) args.push("--model", model);
    args.push(prompt);
    const child = spawn(OPENCODE_BIN, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      const partial = parseOpenCodeEvents(stdout).text;
      child.kill("SIGTERM");
      const error = new Error("OpenCode excedió el tiempo máximo");
      error.code = "OPENCODE_TIMEOUT";
      error.timeoutMs = timeoutMs;
      error.partialText = partial;
      finish(reject, error);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      if (code !== 0) {
        const error = new Error(stderr.trim() || `OpenCode terminó con código ${code}`);
        error.code = "OPENCODE_EXIT";
        error.exitCode = code;
        error.stderr = stderr.trim();
        error.partialText = parseOpenCodeEvents(stdout).text;
        return finish(reject, error);
      }
      const parsed = parseOpenCodeEvents(stdout);
      if (parsed.eventError) {
        const error = new Error(parsed.eventError);
        error.code = "OPENCODE_EVENT_ERROR";
        error.partialText = parsed.text;
        return finish(reject, error);
      }
      if (!parsed.text) return finish(reject, Object.assign(new Error("OpenCode no devolvió texto"), { code: "OPENCODE_EMPTY" }));
      if (!parsed.completed) return finish(reject, Object.assign(new Error("OpenCode devolvió una respuesta parcial sin cierre final"), { code: "OPENCODE_INCOMPLETE", partialText: parsed.text }));
      finish(resolve, parsed);
    });
  });
}

export async function listOpenCodeModels({ refresh = true } = {}) {
  return new Promise((resolve) => {
    const args = ["models"];
    if (refresh) args.push("--refresh");
    const child = spawn(OPENCODE_BIN, args, { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ models: validModel(DEFAULT_MODEL) ? [DEFAULT_MODEL] : [], defaultModel: DEFAULT_MODEL || null, refreshed: false, error: "Timeout actualizando modelos" });
    }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ models: validModel(DEFAULT_MODEL) ? [DEFAULT_MODEL] : [], defaultModel: DEFAULT_MODEL || null, refreshed: false, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const models = [...new Set(stdout.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").split(/\r?\n/).map((line) => line.trim()).filter((line) => validModel(line) && (/\/big-pickle$/i.test(line) || /-free$/i.test(line))))];
      const fallback = validModel(DEFAULT_MODEL) && !models.includes(DEFAULT_MODEL) ? [DEFAULT_MODEL, ...models] : models;
      resolve({ models: fallback, defaultModel: DEFAULT_MODEL || fallback[0] || null, refreshed: code === 0, ...(code === 0 ? {} : { error: stderr.trim() || `OpenCode terminó con código ${code}` }) });
    });
  });
}

export async function probeOpenCode(model = DEFAULT_MODEL) {
  const selectedModel = validModel(model) || validModel(DEFAULT_MODEL);
  const timeoutMs = 30_000;
  try {
    const result = await runOpenCode({ model: selectedModel, prompt: "Respondé exactamente con OK y nada más.", timeoutMs });
    return { ok: true, model: selectedModel, response: result.text.slice(0, 80), timeoutMs };
  } catch (error) {
    return {
      ok: false,
      model: selectedModel,
      error: error.message,
      errorCode: error.code || null,
      timeoutMs: error.timeoutMs || timeoutMs,
      action: error.code === "OPENCODE_TIMEOUT"
        ? "Elegí otro modelo free o aumentá OPENCODE_TIMEOUT_MS y volvé a verificar."
        : "Revisá el modelo seleccionado, la configuración de OpenCode y volvé a verificar."
    };
  }
}

function localAnswer({ question, mode, documents, search }) {
  const visible = documents.filter((document) => document.content?.trim());
  const lines = [
    mode === "report" ? "## Reporte preliminar" : "## Respuesta preliminar",
    "",
    `Consulta: ${question}`,
    "",
    visible.length
      ? `Se recuperaron ${visible.length} documento(s) con contenido suficiente para una lectura inicial.`
      : `La búsqueda devolvió ${search?.results?.length || 0} resultado(s), pero no se pudo recuperar texto documental en esta ejecución.`,
    "",
    "Esta salida es un resumen técnico del material recuperado y no constituye asesoramiento jurídico. Verificá siempre el fallo original antes de tomar una decisión.",
    "OpenCode no está disponible: no fue posible generar el análisis jurídico solicitado."
  ];
  if (visible.length) {
    lines.push("", "### Documentos considerados");
    for (const document of visible) {
      lines.push(`- ${document.title || document.fallo || `Fallo ${document.id}`} (${document.source || "fuente oficial"})`);
    }
  }
  return { answer: lines.join("\n"), provider: "local-fallback", model: null };
}

export async function synthesize({ question, mode, search, documents, model, contextLimitBytes = DEFAULT_CONTEXT_BYTES }) {
  const fallback = () => localAnswer({ question, mode, documents, search });
  if (process.env.OPENCODE_ENABLED !== "1") {
    const error = classifyOpenCodeError(Object.assign(new Error("OpenCode está deshabilitado"), { code: "OPENCODE_DISABLED" }));
    return { ...fallback(), aiError: error, warning: error.message, contextBytes: 0, contextLimitBytes, contextDocuments: 0, contextOmitted: documents.length };
  }

  const fitted = fitContext({ search, documents, maxBytes: contextLimitBytes == null ? Number.MAX_SAFE_INTEGER : contextLimitBytes });
  const context = serializedContext(search, fitted.selected);
  const prompt = `Sos un asistente de análisis jurídico para un prototipo. Respondé en español rioplatense, con lenguaje claro, preciso y prudente. La pregunta del usuario define la tarea: cumplila de forma completa y no la reemplaces por una mera lista de documentos ni por un resumen técnico del proceso. Usá solamente el contexto JSON entregado. No inventes hechos, normas ni precedentes; distinguí expresamente entre lo que surge del texto y cualquier inferencia. No des asesoramiento jurídico definitivo y recordá que debe verificarse el fallo original.\n\nAnalizá TODOS los documentos incluidos en el contexto que tengan Markdown. Para cada criterio jurídico relevante que surja de los fallos, indicá: (1) el criterio o regla identificada, (2) qué documento(s) lo sostienen, (3) los hechos y fundamentos del documento que permiten entenderlo, y (4) cómo se aplica o cuál es su alcance en ese caso. Compará coincidencias y diferencias entre los fallos y señalá si un criterio no aparece o si el material no alcanza para afirmarlo. Si la pregunta pide extraer criterios y explicarlos en contexto, esa extracción y explicación es obligatoria. Incluí al final fuentes con el nombre y enlace oficial disponible de cada documento utilizado.\n\nEl contexto ya contiene los metadatos JSON y el texto Markdown necesario. No abras, leas ni solicites archivos del sistema, no uses herramientas, no generes referencias del tipo <<archivo.md>> y no describas pasos intermedios. Emití una única respuesta final completa; no termines después de un plan o una introducción.\n\nOrden obligatorio de lectura: primero analizá los objetos metadata, que representan los archivos JSON y ya fueron filtrados por año, mes y materia/categoría. Después leé exclusivamente el campo markdown de los documentos seleccionados. Si metadata indica un PDF sin su versión Markdown, la preparación previa debe crear un .md derivado sin modificar el PDF ni el JSON; recién después se puede leer ese Markdown. No leas ni uses el contenido binario del PDF directamente y no inventes el contenido de un Markdown faltante.\n\nTipo de salida: ${mode === "report" ? "informe comparativo con hallazgos, criterios, contexto por documento, límites y próximos pasos" : "respuesta analítica completa, organizada por criterios y documentos, sin reducirla a una respuesta acotada"}.\nPregunta del usuario: ${question}\nContexto JSON: ${context}`;
  const selectedModel = validModel(model) || validModel(DEFAULT_MODEL);

  try {
    const output = await runOpenCode({ model: selectedModel, prompt });
    return { answer: output.text, provider: "opencode", model: selectedModel || "configurado por OpenCode", contextBytes: fitted.bytes, contextLimitBytes, contextDocuments: fitted.selected.length, contextOmitted: fitted.omitted };
  } catch (error) {
    const aiError = classifyOpenCodeError(error);
    const fallbackResult = fallback();
    return {
      ...fallbackResult,
      ...(error.partialText ? { partialAnswer: error.partialText } : {}),
      aiError,
      warning: `${aiError.title}: ${aiError.message}`,
      contextBytes: fitted.bytes,
      contextLimitBytes,
      contextDocuments: fitted.selected.length,
      contextOmitted: fitted.omitted
    };
  }
}
