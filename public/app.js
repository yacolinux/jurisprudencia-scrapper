const $ = (selector) => document.querySelector(selector);
const form = $("#query-form");
const loading = $("#loading");
const errorBox = $("#error");
const result = $("#result");

function setBusy(value) {
  $("#submit").disabled = value;
  loading.classList.toggle("hidden", !value);
  if (value) { errorBox.classList.add("hidden"); result.classList.add("hidden"); }
}

function markdown(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/^### (.+)$/gm, "<h3>$1</h3>").replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^- (.+)$/gm, "<li>$1</li>").replace(/\n\n/g, "<br /><br />").replace(/\n/g, "<br />");
}

function escapeHtml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeUrl(value) {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : ""; } catch { return ""; }
}

function showError(payload) {
  $("#error-title").textContent = payload.code === "CHALLENGE_REQUIRED" ? "El portal pidió una verificación adicional" : "No se pudo completar la consulta";
  $("#error-message").textContent = payload.code === "CHALLENGE_REQUIRED" ? "El MCP no pudo completar el desafío de Cloudflare en el tiempo configurado. Probá nuevamente o revisá el modo de acceso del contenedor." : `${payload.error || "Error inesperado"} (${payload.code || "WEB_ERROR"})`;
  if (payload.browserState) { $("#error-state").textContent = JSON.stringify(payload.browserState, null, 2); $("#error-state").classList.remove("hidden"); }
  errorBox.classList.remove("hidden");
}

function render(data) {
  $("#result-title").textContent = data.mode === "report" ? "Reporte preliminar" : "Respuesta puntual";
  $("#provider-badge").textContent = (data.provider || "local").toUpperCase();
  $("#generated-at").textContent = new Date(data.generatedAt).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
  $("#answer").innerHTML = markdown(data.answer);
  $("#source-count").textContent = `${data.documents.length} fuente${data.documents.length === 1 ? "" : "s"}`;
  $("#access-mode").textContent = `${data.accessMode} · MCP JSON-RPC`;
  $("#ai-mode").textContent = data.provider === "opencode" ? `OpenCode · ${data.model}` : "fallback local reproducible";
  $("#sources").innerHTML = data.documents.length ? data.documents.map((source) => { const url = safeUrl(source.source); return `<div class="source"><strong>${escapeHtml(source.title || "Fallo sin título")}</strong><p>${escapeHtml([source.expediente, source.materia, source.fecha].filter(Boolean).join(" · ") || "Metadatos parciales")}</p>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Abrir fuente oficial ↗</a>` : "<p>Sin enlace recuperado</p>"}</div>`; }).join("") : '<p class="form-hint">No se recuperaron documentos con contenido.</p>';
  $("#raw").textContent = JSON.stringify({ search: data.search, documents: data.documents.map(({ detail, content, ...document }) => ({ ...document, contentChars: content?.length || 0 })) }, null, 2);
  result.classList.remove("hidden");
  result.scrollIntoView({ behavior: "smooth", block: "start" });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true);
  const data = Object.fromEntries(new FormData(form));
  const filters = data.materia ? { materias: [data.materia] } : {};
  try {
    const response = await fetch("/api/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: data.question, searchText: data.searchText, mode: data.mode, filters }) });
    const payload = await response.json();
    if (!response.ok) throw payload;
    render(payload);
  } catch (payload) { showError(payload); }
  finally { setBusy(false); }
});

$("#diagnose").addEventListener("click", async () => {
  const button = $("#diagnose"); button.disabled = true; button.textContent = "Verificando…";
  try { const response = await fetch("/api/diagnose"); const payload = await response.json(); if (!response.ok) throw payload; alert(payload.challenge ? "MCP accesible, pero el portal está mostrando un desafío de Cloudflare." : "MCP accesible: el acceso HTTP directo no fue bloqueado."); }
  catch (payload) { showError(payload); }
  finally { button.disabled = false; button.textContent = "Verificar MCP"; }
});

$("#new-query").addEventListener("click", () => { result.classList.add("hidden"); window.scrollTo({ top: 0, behavior: "smooth" }); $("#question").focus(); });

fetch("/api/health").then((response) => response.json()).then((health) => { $("#access-mode").textContent = `${health.accessMode} · MCP JSON-RPC`; $("#ai-mode").textContent = health.ai === "opencode" ? "OpenCode habilitado" : "fallback local reproducible"; }).catch(() => {});
