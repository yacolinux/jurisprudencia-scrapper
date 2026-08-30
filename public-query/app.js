const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const markdown = (value) => escapeHtml(value).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("submit").disabled = true;
  $("error").hidden = true;
  $("answer").hidden = true;
  $("results").hidden = true;
  $("status").textContent = "Consultando el portal remoto…";
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
        filters
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "La consulta falló");
    $("answerText").innerHTML = markdown(data.answer || "No se generó una respuesta.");
    $("meta").textContent = (data.search?.total ?? 0) + " resultados encontrados · " + (data.documents?.length ?? 0) + " documentos analizados";
    $("answer").hidden = false;
    $("resultList").innerHTML = (data.search?.results || []).map((item) =>
      "<article class=\"result\"><h3>" + escapeHtml(item.caratula || item.fallo || "Resultado") + "</h3><div>" + escapeHtml(item.materia || "") + " " + escapeHtml(item.fecha || "") + "</div><small>" + escapeHtml(item.expediente || "") + "</small></article>"
    ).join("") || "<p>No hubo resultados.</p>";
    $("results").hidden = false;
    $("raw").textContent = JSON.stringify(data, null, 2);
    $("status").textContent = "Consulta completada: " + new Date(data.generatedAt || Date.now()).toLocaleString("es-AR");
  } catch (error) {
    $("error").textContent = error.message;
    $("error").hidden = false;
    $("status").textContent = "";
  } finally {
    $("submit").disabled = false;
  }
});
