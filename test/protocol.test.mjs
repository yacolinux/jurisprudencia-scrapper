import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchUrl } from "../src/jurisprudencia-client.mjs";

test("construye la URL GET nativa con arrays y paginación", () => {
  const url = new URL(buildSearchUrl({
    text: "amparo",
    exact: true,
    materias: ["Amparo"],
    tipoFallo: "Sentencia",
    page: 2,
    perPage: 50
  }));
  assert.equal(url.searchParams.get("filtros"), "1");
  assert.equal(url.searchParams.get("texto"), "amparo");
  assert.equal(url.searchParams.get("busqueda_exacta"), "1");
  assert.equal(url.searchParams.get("materias[]"), "2");
  assert.equal(url.searchParams.get("tipo_fallo"), "2");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("per_page"), "50");
});

test("rechaza páginas o tamaños fuera de rango", () => {
  assert.throws(() => buildSearchUrl({ page: 0 }), /page debe estar/);
  assert.throws(() => buildSearchUrl({ perPage: 3 }), /perPage debe ser/);
  assert.throws(() => buildSearchUrl({ perPage: 101 }), /perPage debe ser/);
});
