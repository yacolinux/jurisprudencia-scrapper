const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const markdown = (value) => escapeHtml(value).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
const safeUrl = (value) => /^(?:https?:\/\/|\/api\/local\/(?:file|markdown|metadata)\?path=)/i.test(String(value || "")) ? escapeHtml(value) : "";
const localUrl = (kind, path) => path ? "/api/local/" + kind + "?path=" + encodeURIComponent(path) : "";
const fileName = (path) => String(path || "").split("/").filter(Boolean).pop() || "archivo sin nombre";
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
  const portalReady = diagnosis.portalReachable === true;
  const aiReady = diagnosis.ai?.ok === true;
  const cdpUrl = diagnosis.cdpUrl || "http://127.0.0.1:9222";

  if (cdpReady) {
    setSetupCheck("chrome", "ready", "Disponible", "GET " + cdpUrl + "/json/version respondió HTTP " + (diagnosis.cdpStatus || "2xx") + ".");
  } else {
    setSetupCheck("chrome", "attention", "No disponible", "GET " + cdpUrl + "/json/version falló" + (diagnosis.cdpError ? ": " + diagnosis.cdpError : ".") + (diagnosis.cdpAction ? " " + diagnosis.cdpAction : ""));
  }

  if (diagnosis.challenge === true) {
    setSetupCheck("portal", "attention", "Bloqueado por Cloudflare", "GET " + (diagnosis.url || "el portal") + " respondió HTTP " + (diagnosis.status || "-") + " con un desafío; no llegó a la página final.");
  } else if (portalReady) {
    setSetupCheck("portal", "ready", "Página de consulta disponible", "GET " + (diagnosis.finalUrl || diagnosis.url || "el portal") + " respondió HTTP " + (diagnosis.status || "2xx") + ".");
  } else {
    const portalReason = diagnosis.portalError ? "falló: " + diagnosis.portalError + (diagnosis.portalErrorCode ? " (" + diagnosis.portalErrorCode + ")" : "") + (diagnosis.portalErrorCause ? ". Causa: " + diagnosis.portalErrorCause : "") : diagnosis.message || "no llegó a la página final de consulta";
    setSetupCheck("portal", "attention", "No disponible", "GET " + (diagnosis.url || "el portal") + " " + portalReason + (diagnosis.portalAction ? " Acción: " + diagnosis.portalAction : ""));
  }

  if (aiReady) {
    setSetupCheck("ai", "ready", "Disponible", "OpenCode respondió OK con " + (diagnosis.ai.model || "el modelo predeterminado") + " dentro de " + (diagnosis.ai.timeoutMs || 30_000) + " ms.");
  } else {
    const ai = diagnosis.ai || {};
    const timeout = ai.timeoutMs ? " Límite: " + ai.timeoutMs + " ms." : "";
    setSetupCheck("ai", "attention", "No disponible", (ai.error || "OpenCode no devolvió una respuesta completa.") + (ai.errorCode ? " (" + ai.errorCode + ")" : "") + "." + timeout + " " + (ai.action || "Volvé a verificar o elegí otro modelo free."));
  }

  const needsRecovery = !cdpReady || diagnosis.challenge === true;
  $("setupRecovery").hidden = !needsRecovery;
  if (cdpReady && portalReady && aiReady) {
    setSetupState("ready", "Verificado");
  } else {
    setSetupState("attention", "No verificado aún");
  }
}

async function diagnose() {
  setSetupState("loading", "Comprobando acceso…");
  $("setupRecovery").hidden = true;
  setSetupCheck("chrome", "loading", "Comprobando…", "Verificando la conexión con el navegador externo.");
  setSetupCheck("portal", "loading", "Comprobando…", "Probando el acceso público y la protección anti-bot.");
  setSetupCheck("ai", "loading", "Comprobando…", "Probando OpenCode con una consulta mínima.");
  try {
    const response = await fetch("/api/diagnose", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "El diagnóstico no está disponible");
    renderDiagnosis(data);
  } catch (error) {
    const reason = error instanceof Error && error.message ? " Motivo: " + error.message : "";
    setSetupState("attention", "No verificado aún");
    setSetupCheck("chrome", "unknown", "Sin confirmar", "No se pudo verificar CDP desde la aplicación." + reason);
    setSetupCheck("portal", "unknown", "Sin confirmar", "No se pudo verificar la página final del portal." + reason);
    setSetupCheck("ai", "unknown", "Sin confirmar", "No se pudo verificar OpenCode desde la aplicación." + reason);
  }
}

$("refreshDiagnosis").addEventListener("click", diagnose);

const modelToggle = $("modelToggle");
const modelMenu = $("modelMenu");
const modelSelect = $("model");
const modelStatus = $("modelStatus");
modelToggle.addEventListener("click", () => {
  const expanded = modelToggle.getAttribute("aria-expanded") === "true";
  modelToggle.setAttribute("aria-expanded", String(!expanded));
  modelMenu.hidden = expanded;
});

async function loadModels() {
  try {
    const response = await fetch("/api/models", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.models) || !data.models.length) throw new Error(data.error || "No hay modelos free disponibles");
    modelSelect.innerHTML = data.models.map((model) => "<option value=\"" + escapeHtml(model) + "\">" + escapeHtml(model.replace(/^opencode\//, "")) + "</option>").join("");
    if (data.defaultModel && data.models.includes(data.defaultModel)) modelSelect.value = data.defaultModel;
    modelStatus.textContent = data.refreshed ? "Modelos free actualizados." : "Modelos free disponibles en caché.";
  } catch (error) {
    modelSelect.innerHTML = "<option value=\"\">Modelo predeterminado</option>";
    modelStatus.textContent = error.message;
  }
}

loadModels();

let lastResult = null;
let lastQueryInput = null;
let documentListText = "";

function documentIdentity(document) {
  return String(document?.id || document?.localPath || document?.source || document?.title || "");
}

function formatDocumentList(title, documents) {
  const items = Array.isArray(documents) ? documents : [];
  if (!items.length) return title + "\n\nNo hay documentos en este grupo.";
  return [title, "", ...items.map((document, index) => {
    const path = document.markdownPath || document.localPath || document.source || "sin ruta local";
    const details = [document.materia, document.fecha, document.expediente].filter(Boolean).join(" · ");
    return `${String(index + 1).padStart(2, "0")}. ${document.title || document.fallo || "Documento sin título"}${details ? `\n    ${details}` : ""}\n    ${path}`;
  })].join("\n");
}

function showDocumentList(title, documents) {
  documentListText = formatDocumentList(title, documents);
  $("documentDialogTitle").textContent = title;
  $("documentListText").textContent = documentListText;
  $("copyDocumentStatus").textContent = "";
  const dialog = $("documentListDialog");
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.hidden = false;
}

function renderContextReview(data) {
  const review = data.contextReview;
  if (!review) {
    $("contextReview").hidden = true;
    return;
  }
  const candidates = review.candidates || [];
  const sent = review.sent || [];
  const omitted = review.omitted || [];
  $("contextCandidateCount").textContent = String(review.candidateCount ?? candidates.length);
  $("contextSentCount").textContent = String(review.sentCount ?? sent.length);
  $("contextOmittedCount").textContent = String(review.omittedCount ?? omitted.length);
  $("contextReviewSubtitle").textContent = review.allDocuments
    ? "Se reintentó la consulta con todos los documentos que coincidieron con la búsqueda."
    : `El límite local de contexto es de ${Math.round((review.contextLimitBytes || 0) / 1024)} KiB; los documentos no enviados quedan identificados para que puedas reintentar.`;
  $("showCandidateDocuments").onclick = () => showDocumentList("Documentos encontrados", candidates);
  $("showSentDocuments").onclick = () => showDocumentList("Documentos enviados a la IA", sent);
  $("showOmittedDocuments").onclick = () => showDocumentList("Documentos no enviados a la IA", omitted);
  $("retryAllDocuments").disabled = review.allDocuments || omitted.length === 0;
  $("contextReview").hidden = false;
}

$("closeDocumentDialog").addEventListener("click", () => {
  const dialog = $("documentListDialog");
  if (typeof dialog.close === "function") dialog.close();
  else dialog.hidden = true;
});
$("documentListDialog").addEventListener("click", (event) => {
  if (event.target === $("documentListDialog")) $("closeDocumentDialog").click();
});
$("copyDocumentList").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(documentListText);
    $("copyDocumentStatus").textContent = "Lista copiada.";
  } catch {
    $("copyDocumentStatus").textContent = "No se pudo copiar automáticamente.";
  }
});

function renderAiError(data) {
  const box = $("aiError");
  if (!data.aiError) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  const aiError = data.aiError;
  box.innerHTML = "<strong>" + escapeHtml(aiError.title || "Error de IA") + "</strong><span>" + escapeHtml(aiError.message || "La IA no pudo completar la consulta.") + (aiError.code ? " (" + escapeHtml(aiError.code) + ")" : "") + "</span><small>" + escapeHtml(aiError.action || "Volvé a intentar la consulta.") + "</small>";
  box.hidden = false;
}

function exportReferenceLink(label, url) {
  const value = String(url || "");
  const resolved = value.startsWith("/") ? "http://localhost:3001" + value : value;
  return /^(?:https?:\/\/|\/api\/local\/(?:file|markdown|metadata)\?path=)/i.test(resolved) ? { label, url: resolved } : null;
}

function buildExportPayload(data) {
  const references = (data.search?.results || []).map((item) => {
    const document = (data.documents || []).find((candidate) => String(candidate.id) === String(item.id)) || {};
    const mdPath = document.markdownPath || item.markdownPath || (document.localPath || item.localPath || "").replace(/\.pdf$/i, ".md");
    const jsonPath = document.metadataPath || item.metadataPath || (document.localPath || item.localPath || "").replace(/\.pdf$/i, ".pdf.json");
    const links = [
      exportReferenceLink("Leer .md", mdPath ? localUrl("markdown", mdPath) : ""),
      exportReferenceLink("JSON", jsonPath ? localUrl("metadata", jsonPath) : ""),
      exportReferenceLink("PDF", item.pdfUrl || item.source || document.pdfUrl || document.source)
    ].filter(Boolean);
    return {
      title: item.title || item.caratula || item.fallo || document.title || "Resultado",
      fallo: item.fallo || document.fallo,
      expediente: item.expediente || document.expediente,
      materia: item.materia || document.materia,
      fecha: item.fecha || document.fecha,
      path: mdPath || document.localPath || item.localPath || item.source || document.source,
      links
    };
  });
  return {
    question: data.question,
    model: data.model || modelSelect.value || "Modelo predeterminado",
    answer: data.answer,
    generatedAt: data.generatedAt,
    references
  };
}

async function exportResults(format) {
  if (!lastResult) return;
  const button = $("exportToggle");
  button.disabled = true;
  $("status").textContent = "Preparando archivo " + format.toUpperCase() + "…";
  try {
    const response = await fetch("/api/export/" + format, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildExportPayload(lastResult))
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "No se pudo exportar el resultado");
    }
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "resultados-consulta." + format;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    $("status").textContent = "Resultado exportado como " + format.toUpperCase() + ".";
    $("exportMenu").hidden = true;
    $("exportToggle").setAttribute("aria-expanded", "false");
  } catch (error) {
    $("error").textContent = error.message;
    $("error").hidden = false;
    $("status").textContent = "";
  } finally {
    button.disabled = false;
  }
}

const exportToggle = $("exportToggle");
const exportMenu = $("exportMenu");
exportToggle.addEventListener("click", () => {
  const expanded = exportToggle.getAttribute("aria-expanded") === "true";
  exportToggle.setAttribute("aria-expanded", String(!expanded));
  exportMenu.hidden = expanded;
});
document.querySelectorAll("[data-export-format]").forEach((button) => button.addEventListener("click", () => exportResults(button.dataset.exportFormat)));

function formQueryInput(retryAllDocuments = false) {
  const filters = {};
  if ($("year").value) filters.year = Number($("year").value);
  if ($("month").value) filters.month = Number($("month").value);
  if ($("materia").value.trim()) filters.materias = [$("materia").value.trim()];
  return {
    question: $("question").value,
    searchText: $("searchText").value,
    model: modelSelect.value,
    mode: document.querySelector('input[name="mode"]:checked').value,
    includeRemote: $("includeRemote").checked,
    filters,
    ...(retryAllDocuments ? { retryAllDocuments: true } : {})
  };
}

async function requestQuery(input, retryAllDocuments = false) {
  $("submit").disabled = true;
  $("retryAllDocuments").disabled = true;
  $("error").hidden = true;
  $("contextReview").hidden = true;
  $("answer").hidden = true;
  $("results").hidden = true;
  $("status").textContent = retryAllDocuments ? "Reintentando con todos los documentos; puede demorar…" : input.includeRemote ? "Leyendo JSON/Markdown local y ampliando con el MCP remoto…" : "Buscando en JSON/Markdown local, sin tocar PDFs ni JSON…";
  try {
    const response = await fetch("/api/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "La consulta falló");
    lastResult = data;
    lastQueryInput = { ...input, retryAllDocuments: undefined };
    renderAiError(data);
    $("answerText").innerHTML = markdown(data.partialAnswer || data.answer || "No se generó una respuesta.");
    const localInfo = data.sources?.local;
    const remoteInfo = data.sources?.remote;
    const remoteUsed = data.queryMode === "local+remote" && remoteInfo?.enabled;
    $("provider-badge").textContent = data.aiError ? "ARCHIVO LOCAL + IA CON ERROR" : remoteUsed ? "ARCHIVO LOCAL + MCP + LLM" : "ARCHIVO LOCAL + LLM";
    $("result-source").textContent = remoteUsed ? "Archivo local y portal oficial" : "Desde el archivo local";
    const remoteText = remoteInfo?.requested ? " · MCP: " + (remoteInfo.enabled ? (remoteInfo.returned || remoteInfo.total || 0) + " resultados · " + (remoteInfo.downloaded || 0) + " PDFs nuevos · " + (remoteInfo.cached || 0) + " ya cacheados" : "no disponible") : "";
    const review = data.contextReview || {};
    $("meta").textContent = (data.search?.total ?? 0) + " resultados encontrados · " + (review.sentCount ?? data.documents?.length ?? 0) + " documentos enviados a la IA · " + (localInfo?.indexed ?? 0) + " indexados localmente" + (data.model ? " · IA: " + data.model : "") + remoteText;
    renderContextReview(data);
    $("answer").hidden = false;
    $("resultList").innerHTML = (data.search?.results || []).map((item) => {
      const document = (data.documents || []).find((candidate) => documentIdentity(candidate) === documentIdentity(item));
      const pdfUrl = safeUrl(item.pdfUrl || item.source || document?.pdfUrl || document?.source);
      const state = item.contextOmitted ? " · No enviado a la IA" : item.contextIncluded ? " · Enviado a la IA" : "";
      const pdf = pdfUrl ? "<a class=\"pdf\" href=\"" + pdfUrl + "\" target=\"_blank\" rel=\"noreferrer\">PDF disponible ↗</a>" : "<span>PDF no recuperado</span>";
      return "<article class=\"result\"><h3>" + escapeHtml(item.title || item.caratula || item.fallo || "Resultado") + "</h3><p>" + escapeHtml(item.fallo || "Fallo recuperado del portal oficial") + escapeHtml(state) + "</p><div class=\"result-meta\"><span>" + escapeHtml(item.materia || "Materia no indicada") + "</span><span>" + escapeHtml(item.fecha || "Fecha no indicada") + "</span><span>" + escapeHtml(item.expediente || "") + "</span>" + pdf + "</div></article>";
    }).join("") || "<p class=\"muted\">No hubo resultados.</p>";
    $("sourceList").innerHTML = (data.documents || []).map((document, index) => {
      const mdPath = document.markdownPath || (document.localPath || "").replace(/\.pdf$/i, ".md");
      const jsonPath = document.metadataPath || (document.localPath || "").replace(/\.pdf$/i, ".pdf.json");
      const mdUrl = safeUrl(localUrl("markdown", mdPath));
      const jsonUrl = safeUrl(localUrl("metadata", jsonPath));
      const pdfUrl = safeUrl(document.pdfUrl);
      const path = mdPath || document.localPath || document.source || "Fuente remota sin copia local";
      const links = [mdUrl ? "<a href=\"" + mdUrl + "\" target=\"_blank\" rel=\"noreferrer\">Leer .md ↗</a>" : "", jsonUrl ? "<a href=\"" + jsonUrl + "\" target=\"_blank\" rel=\"noreferrer\">JSON ↗</a>" : "", pdfUrl ? "<a href=\"" + pdfUrl + "\" target=\"_blank\" rel=\"noreferrer\">PDF ↗</a>" : ""].filter(Boolean).join("");
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
    if (lastResult) renderContextReview(lastResult);
  }
}

$("form").addEventListener("submit", (event) => {
  event.preventDefault();
  lastResult = null;
  lastQueryInput = null;
  requestQuery(formQueryInput());
});

$("retryAllDocuments").addEventListener("click", () => {
  if (!lastQueryInput) return;
  requestQuery({ ...lastQueryInput, retryAllDocuments: true }, true);
});
