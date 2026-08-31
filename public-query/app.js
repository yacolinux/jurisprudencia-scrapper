const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const markdown = (value) => escapeHtml(value).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
const safeUrl = (value) => /^(?:https?:\/\/|\/api\/local\/(?:file|markdown|metadata)\?path=)/i.test(String(value || "")) ? escapeHtml(value) : "";
const localUrl = (kind, path) => path ? "/api/local/" + kind + "?path=" + encodeURIComponent(path) : "";
const fileName = (path) => String(path || "").split("/").filter(Boolean).pop() || "archivo sin nombre";
const recoverySteps = $("recoverySteps").value;

function setSetupCheck(id, state, title, detail) {
  const check = $(id + "Check");
  check.className = "setup-check is-" + state;
  $(id + "Status").textContent = title;
  $(id + "Detail").textContent = detail;
}

function setSetupState(state, text) {
  $("setupState").className = "setup-state is-" + state;
  $("setupStateText").textContent = text;
}

function renderDiagnosis(diagnosis) {
  const cdpReady = diagnosis.cdpReachable === true;
  const cdpConfigured = diagnosis.cdpConfigured === true;
  const portalReady = diagnosis.challenge !== true && Number(diagnosis.status) >= 200 && Number(diagnosis.status) < 400;

  if (cdpReady) {
    setSetupCheck("chrome", "ready", "Disponible", "Chrome externo responde por CDP y puede conservar la sesión del desafío.");
  } else if (cdpConfigured) {
    setSetupCheck("chrome", "attention", "No disponible", "CDP está configurado, pero no responde en http://127.0.0.1:9222.");
  } else if (diagnosis.challenge) {
    setSetupCheck("chrome", "attention", "Necesario", "No hay Chrome/CDP configurado para completar el desafío de Cloudflare.");
  } else {
    setSetupCheck("chrome", "neutral", "No configurado", "No hace falta para este acceso directo; se recomienda si el portal presenta un desafío.");
  }

  if (portalReady) {
    setSetupCheck("portal", "ready", "Listo", "El portal oficial respondió sin desafío en esta comprobación.");
  } else if (diagnosis.challenge) {
    setSetupCheck("portal", "attention", "Bloqueado por Cloudflare", "El portal respondió con un desafío que requiere una sesión normal de navegador.");
  } else {
    setSetupCheck("portal", "attention", "No disponible", diagnosis.message || "El portal no respondió de forma utilizable.");
  }

  const needsRecovery = diagnosis.challenge === true || (!portalReady && cdpConfigured && !cdpReady);
  $("setupRecovery").hidden = !needsRecovery;
  if (diagnosis.challenge) {
    setSetupState("attention", "Acción necesaria para el portal");
  } else if (portalReady) {
    setSetupState("ready", cdpReady ? "Acceso remoto preparado" : "Portal listo para consultar");
  } else {
    setSetupState("attention", "Revisá la preparación del acceso");
  }
}

async function diagnose() {
  setSetupState("loading", "Comprobando acceso…");
  $("setupRecovery").hidden = true;
  setSetupCheck("chrome", "loading", "Comprobando…", "Verificando la conexión con el navegador externo.");
  setSetupCheck("portal", "loading", "Comprobando…", "Probando el acceso público y la protección anti-bot.");
  try {
    const response = await fetch("/api/diagnose", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "El diagnóstico no está disponible");
    renderDiagnosis(data);
  } catch (error) {
    setSetupState("error", "No se pudo completar el diagnóstico");
    setSetupCheck("chrome", "unknown", "Sin confirmar", "No se pudo verificar Chrome/CDP desde la aplicación.");
    setSetupCheck("portal", "unknown", "Sin confirmar", "No se pudo verificar el portal oficial desde la aplicación.");
    $("setupRecovery").hidden = false;
    $("copyFeedback").textContent = error.message;
  }
}

$("refreshDiagnosis").addEventListener("click", diagnose);
$("copyRecovery").addEventListener("click", async () => {
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(recoverySteps);
      copied = true;
    }
  } catch { /* El navegador puede bloquear el portapapeles fuera de un contexto seguro. */ }
  if (!copied) {
    $("recoverySteps").focus();
    $("recoverySteps").select();
    copied = document.queryCommandSupported?.("copy") ? document.execCommand("copy") : false;
  }
  $("copyFeedback").textContent = copied ? "Pasos copiados al portapapeles." : "Pasos seleccionados; presioná Ctrl+C para copiarlos.";
  setTimeout(() => { $("copyFeedback").textContent = ""; }, 3000);
});

diagnose();

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
