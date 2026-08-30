const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const markdown = (value) => escapeHtml(value).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
const safeUrl = (value) => /^(?:https?:\/\/|\/api\/local\/(?:file|markdown|metadata)\?path=)/i.test(String(value || "")) ? escapeHtml(value) : "";
const localUrl = (kind, path) => path ? "/api/local/" + kind + "?path=" + encodeURIComponent(path) : "";
const fileName = (path) => String(path || "").split("/").filter(Boolean).pop() || "archivo sin nombre";

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("submit").disabled = true;
  $("error").hidden = true;
  $("answer").hidden = true;
  $("results").hidden = true;
  const includeRemote = $("includeRemote").checked;
  $("status").textContent = includeRemote ? "Leyendo JSON/Markdown local y ampliando con el MCP remoto…" : "Buscando en JSON/Markdown local, sin tocar PDFs ni JSON…";
  const filters = {};
  if ($("year").value) filters.year = Number($("year").value);
  if ($("month").value) filters.month = Number($("month").value);
  if ($("materia").value.trim()) filters.materias = [$("materia").value.trim()];
  try {
    const response = await fetch("/api/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: $("question").value,
        searchText: $("searchText").value,
        mode: document.querySelector('input[name="mode"]:checked').value,
        includeRemote,
        filters
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "La consulta falló");
    $("answerText").innerHTML = markdown(data.answer || "No se generó una respuesta.");
    const localInfo = data.sources?.local;
    const remoteInfo = data.sources?.remote;
    const remoteUsed = data.queryMode === "local+remote" && remoteInfo?.enabled;
    $("provider-badge").textContent = remoteUsed ? "ARCHIVO LOCAL + MCP + LLM" : "ARCHIVO LOCAL + LLM";
    $("result-source").textContent = remoteUsed ? "Archivo local y portal oficial" : "Desde el archivo local";
    const remoteText = remoteInfo?.requested ? " · MCP: " + (remoteInfo.enabled ? (remoteInfo.returned || remoteInfo.total || 0) + " resultados · " + (remoteInfo.downloaded || 0) + " PDFs nuevos · " + (remoteInfo.cached || 0) + " ya cacheados" : "no disponible") : "";
    $("meta").textContent = (data.search?.total ?? 0) + " resultados mostrados · " + (data.documents?.length ?? 0) + " documentos analizados · " + (localInfo?.indexed ?? 0) + " indexados localmente" + remoteText;
    $("answer").hidden = false;
    $("resultList").innerHTML = (data.search?.results || []).map((item) => {
      const document = (data.documents || []).find((candidate) => String(candidate.id) === String(item.id));
      const pdfUrl = safeUrl(item.pdfUrl || item.source || document?.pdfUrl || document?.source);
      const pdf = pdfUrl ? "<a class=\"pdf\" href=\"" + pdfUrl + "\" target=\"_blank\" rel=\"noreferrer\">PDF disponible ↗</a>" : "<span>PDF no recuperado</span>";
      return "<article class=\"result\"><h3>" + escapeHtml(item.caratula || item.fallo || "Resultado") + "</h3><p>" + escapeHtml(item.fallo || "Fallo recuperado del portal oficial") + "</p><div class=\"result-meta\"><span>" + escapeHtml(item.materia || "Materia no indicada") + "</span><span>" + escapeHtml(item.fecha || "Fecha no indicada") + "</span><span>" + escapeHtml(item.expediente || "") + "</span>" + pdf + "</div></article>";
    }).join("") || "<p class=\"muted\">No hubo resultados.</p>";
    $("sourceList").innerHTML = (data.documents || []).map((document, index) => {
      const mdPath = document.markdownPath || (document.localPath || "").replace(/\.pdf$/i, ".md");
      const jsonPath = document.metadataPath || (document.localPath || "").replace(/\.pdf$/i, ".pdf.json");
      const mdUrl = safeUrl(localUrl("markdown", mdPath));
      const jsonUrl = safeUrl(localUrl("metadata", jsonPath));
      const pdfUrl = safeUrl(document.pdfUrl);
      const path = mdPath || document.localPath || document.source || "Fuente remota sin copia local";
      const links = [
        mdUrl ? "<a href=\"" + mdUrl + "\" target=\"_blank\" rel=\"noreferrer\">Leer .md ↗</a>" : "",
        jsonUrl ? "<a href=\"" + jsonUrl + "\" target=\"_blank\" rel=\"noreferrer\">JSON ↗</a>" : "",
        pdfUrl ? "<a href=\"" + pdfUrl + "\" target=\"_blank\" rel=\"noreferrer\">PDF ↗</a>" : ""
      ].filter(Boolean).join("");
      return "<article class=\"source-item\"><span class=\"source-number\">" + String(index + 1).padStart(2, "0") + "</span><strong title=\"" + escapeHtml(path) + "\">" + escapeHtml(fileName(path)) + "</strong><code>" + escapeHtml(path) + "</code><div class=\"source-links\">" + (links || "<span>Sin copia local</span>") + "</div></article>";
    }).join("") || "<p class=\"muted\">No hubo fuentes documentales.</p>";
    $("results").hidden = false;
    $("raw").textContent = JSON.stringify(data, null, 2);
    const markdownCreated = data.derivedMarkdownCreated || localInfo?.createdMarkdown || 0;
    $("status").textContent = (data.nonDestructive ? "✓ Modo no destructivo · " : "") + "Consulta completada: " + new Date(data.generatedAt || Date.now()).toLocaleString("es-AR") + (markdownCreated ? " · .md nuevos: " + markdownCreated : "") + (data.warning ? " · " + data.warning : "");
  } catch (error) {
    $("error").textContent = error.message;
    $("error").hidden = false;
    $("status").textContent = "";
  } finally {
    $("submit").disabled = false;
  }
});
