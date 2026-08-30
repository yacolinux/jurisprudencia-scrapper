import { spawn } from "node:child_process";

const DEFAULT_MODEL = process.env.OPENCODE_MODEL || (process.env.NVIDIA_API_KEY ? "nvidia/nemotron-3-super-120b-a12b" : "");

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
    "Esta salida es un resumen técnico del material recuperado y no constituye asesoramiento jurídico. Verificá siempre el fallo original antes de tomar una decisión."
  ];
  if (visible.length) {
    lines.push("", "### Documentos considerados");
    for (const document of visible) {
      lines.push(`- ${document.title || document.fallo || `Fallo ${document.id}`} (${document.source || "fuente oficial"})`);
    }
  }
  return { answer: lines.join("\n"), provider: "local-fallback", model: null };
}

function parseOpenCodeOutput(stdout) {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const texts = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const candidates = [event.text, event.part?.text, event.message?.content, event.data?.text];
      const text = candidates.find((value) => typeof value === "string" && value.trim());
      if (text) texts.push(text);
    } catch {
      // El formato estándar puede mezclar texto legible y eventos no JSON.
    }
  }
  return texts.join("").trim() || stdout.trim();
}

export async function synthesize({ question, mode, search, documents }) {
  const fallback = () => localAnswer({ question, mode, documents, search });
  if (process.env.OPENCODE_ENABLED !== "1") return fallback();

  const context = JSON.stringify({
    search: { total: search?.total, results: search?.results },
    documents: documents.map(({ id, title, source, localPath, markdownPath, materia, fecha, expediente, metadata, content }) => ({
      metadata: metadata || { id, title, source, localPath, markdownPath, materia, fecha, expediente },
      markdown: content?.slice(0, 18_000)
    }))
  });
  const prompt = `Sos un asistente de análisis jurídico para un prototipo. Respondé en español rioplatense, con lenguaje claro y prudente. No inventes hechos, normas ni precedentes. Usá solamente el contexto JSON entregado. Indicá cuando falte información. Incluí una sección breve de fuentes con los enlaces oficiales presentes en el contexto. No des asesoramiento jurídico definitivo y recordá que debe verificarse el texto original.\n\nOrden obligatorio de lectura: primero analizá los objetos metadata, que representan los archivos JSON y ya fueron filtrados por año, mes y materia/categoría. Después leé exclusivamente el campo markdown de los documentos seleccionados. Si metadata indica un PDF sin su versión Markdown, la preparación previa debe crear un .md derivado sin modificar el PDF ni el JSON; recién después se puede leer ese Markdown. No leas ni uses el contenido binario del PDF directamente y no inventes el contenido de un Markdown faltante.\n\nTipo de salida: ${mode === "report" ? "reporte preliminar con hallazgos, documentos relevantes, límites y próximos pasos" : "respuesta puntual one-shot, directa y acotada"}.\nPregunta: ${question}\nContexto JSON: ${context}`;
  const args = ["run", "--format", "json"];
  if (DEFAULT_MODEL) args.push("--model", DEFAULT_MODEL);
  args.push(prompt);

  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.env.OPENCODE_BIN || "opencode", args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("OpenCode excedió el tiempo máximo")); }, Number(process.env.OPENCODE_TIMEOUT_MS || 90_000));
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(stderr.trim() || `OpenCode terminó con código ${code}`));
        else resolve(stdout);
      });
    });
    const answer = parseOpenCodeOutput(output);
    if (!answer) throw new Error("OpenCode no devolvió texto");
    return { answer, provider: "opencode", model: DEFAULT_MODEL || "configurado por OpenCode" };
  } catch (error) {
    return { ...fallback(), warning: `OpenCode no estuvo disponible: ${error.message}` };
  }
}
