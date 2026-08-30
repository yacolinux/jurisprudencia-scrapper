const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const markdown = (value) => escapeHtml(value).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
const safeUrl = (value) => /^https?:\/\//i.test(String(value || "")) ? escapeHtml(value) : "";

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("submit").disabled = true;
  $("error").hidden = true;
  $("answer").hidden = true;
  $("results").hidden = true;
  const includeRemote = $("includeRemote").checked;
  $("status").textContent = includeRemote ? "Leyendo archivo local y ampliando con el MCP remoto…" : "Buscando en el archivo local (modo solo lectura)…";
  const filters = {};
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
    const remoteText = remoteInfo?.requested ? " · MCP: " + (remoteInfo.enabled ? (remoteInfo.returned || remoteInfo.total || 0) + " resultados" : "no disponible") : "";
    $("meta").textContent = (data.search?.total ?? 0) + " resultados mostrados · " + (data.documents?.length ?? 0) + " documentos analizados · " + (localInfo?.indexed ?? 0) + " indexados localmente" + remoteText;
    $("answer").hidden = false;
    $("resultList").innerHTML = (data.search?.results || []).map((item) => {
      const document = (data.documents || []).find((candidate) => String(candidate.id) === String(item.id));
      const pdfUrl = safeUrl(item.pdfUrl || item.source || document?.pdfUrl || document?.source);
      const pdf = pdfUrl ? "<a class=\"pdf\" href=\"" + pdfUrl + "\" target=\"_blank\" rel=\"noreferrer\">PDF disponible ↗</a>" : "<span>PDF no recuperado</span>";
      return "<article class=\"result\"><h3>" + escapeHtml(item.caratula || item.fallo || "Resultado") + "</h3><p>" + escapeHtml(item.fallo || "Fallo recuperado del portal oficial") + "</p><div class=\"result-meta\"><span>" + escapeHtml(item.materia || "Materia no indicada") + "</span><span>" + escapeHtml(item.fecha || "Fecha no indicada") + "</span><span>" + escapeHtml(item.expediente || "") + "</span>" + pdf + "</div></article>";
    }).join("") || "<p class=\"muted\">No hubo resultados.</p>";
    $("results").hidden = false;
    $("raw").textContent = JSON.stringify(data, null, 2);
    $("status").textContent = (data.readOnly ? "✓ Modo no destructivo · " : "") + "Consulta completada: " + new Date(data.generatedAt || Date.now()).toLocaleString("es-AR") + (data.warning ? " · " + data.warning : "");
  } catch (error) {
    $("error").textContent = error.message;
    $("error").hidden = false;
    $("status").textContent = "";
  } finally {
    $("submit").disabled = false;
  }
});
