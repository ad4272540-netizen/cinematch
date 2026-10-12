#!/usr/bin/env node
/**
 * sync-catalog.mjs
 * Genera catalog.json con la disponibilidad de películas por plataforma en un país
 * (por defecto Perú) usando la API oficial de TMDB (datos de disponibilidad: JustWatch).
 *
 * Requiere Node 18+ y una API key de TMDB (gratis para uso no comercial):
 *   TMDB_API_KEY=xxxxxxxx node sync-catalog.mjs
 *
 * Variables opcionales:
 *   WATCH_REGION   país ISO 3166-1 (default PE)
 *   PROVIDERS      nombres separados por coma (default: lista abajo)
 *   TYPES          flatrate,rent,buy (default flatrate,rent,buy)
 *   PAGES          páginas por plataforma y tipo, 20 títulos c/u (default 10, máx 500)
 *   OUT            archivo de salida (default catalog.json)
 *
 * No hace scraping: solo llama a api.themoviedb.org con tu key.
 */
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const API = "https://api.themoviedb.org/3";
const DEFAULT_PROVIDERS = [
  "Netflix",
  "Amazon Prime Video",
  "Disney Plus",
  "Max",
  "HBO Max",
  "Paramount Plus",
  "Apple TV Plus",
  "Apple TV",
  "Google Play Movies",
];

const norm = (s) => String(s).toLowerCase().replace(/[+]/g, " plus").replace(/[^a-z0-9]+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function buildCatalog(opts, fetchFn = fetch) {
  const {
    apiKey,
    region = "PE",
    language = "es-MX",
    providers = DEFAULT_PROVIDERS,
    types = ["flatrate", "rent", "buy"],
    pages = 10,
    log = console.log,
  } = opts;

  const isToken = apiKey.startsWith("eyJ"); // token v4 (read access token)
  const headers = isToken ? { Authorization: `Bearer ${apiKey}` } : {};

  async function get(path, params = {}, attempt = 0) {
    const url = new URL(API + path);
    if (!isToken) url.searchParams.set("api_key", apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetchFn(url.toString(), { headers });
    if (res.status === 429 && attempt < 5) {
      const wait = Number(res.headers?.get?.("retry-after") || 2) * 1000;
      await sleep(wait);
      return get(path, params, attempt + 1);
    }
    if (!res.ok) throw new Error(`TMDB ${res.status} en ${path}`);
    return res.json();
  }

  // 1) Resolver ids de proveedores en la región (los ids cambian por región, no se hardcodean)
  const list = await get("/watch/providers/movie", { watch_region: region, language });
  const wanted = new Set(providers.map(norm));
  const found = (list.results || []).filter((p) => wanted.has(norm(p.provider_name)));
  const missing = providers.filter((n) => !found.some((p) => norm(p.provider_name) === norm(n)));
  log(`Proveedores en ${region}: ${found.map((p) => `${p.provider_name}(${p.provider_id})`).join(", ") || "ninguno"}`);
  if (missing.length) log(`No listados en ${region} (se omiten): ${missing.join(", ")}`);
  if (!found.length) throw new Error("No se resolvió ningún proveedor; revisa PROVIDERS y WATCH_REGION");

  // 2) Géneros en español
  const gl = await get("/genre/movie/list", { language });
  const genreName = new Map((gl.genres || []).map((g) => [g.id, g.name]));

  // 3) Discover por proveedor + tipo de acceso
  const movies = new Map();
  for (const p of found) {
    for (const type of types) {
      let total = 0;
      for (let page = 1; page <= Math.min(pages, 500); page++) {
        const data = await get("/discover/movie", {
          watch_region: region,
          with_watch_providers: String(p.provider_id),
          with_watch_monetization_types: type,
          sort_by: "popularity.desc",
          include_adult: "false",
          language,
          page: String(page),
        });
        for (const m of data.results || []) {
          const id = String(m.id);
          if (!movies.has(id)) {
            movies.set(id, {
              id,
              title: m.title,
              year: (m.release_date || "").slice(0, 4) || null,
              genres: (m.genre_ids || []).map((g) => genreName.get(g)).filter(Boolean),
              rating: Math.round((m.vote_average || 0) * 10) / 10,
              overview: m.overview || "",
              poster: m.poster_path || null,
              popularity: m.popularity || 0,
              offers: [],
            });
          }
          const movie = movies.get(id);
          movie.popularity = Math.max(movie.popularity, m.popularity || 0);
          if (!movie.offers.some((o) => o.providerId === p.provider_id && o.type === type)) {
            movie.offers.push({ provider: p.provider_name, providerId: p.provider_id, type, country: region });
          }
          total++;
        }
        if (page >= (data.total_pages || 1)) break;
        await sleep(30);
      }
      log(`${p.provider_name} / ${type}: ${total} títulos`);
    }
  }

  const all = [...movies.values()].sort((a, b) => b.popularity - a.popularity);
  return {
    generatedAt: new Date().toISOString(),
    country: region,
    language,
    attribution: "Disponibilidad: JustWatch. Metadatos: TMDB. Este producto usa la API de TMDB pero no está avalado ni certificado por TMDB.",
    platforms: found.map((p) => ({ id: p.provider_id, label: p.provider_name })),
    movies: all,
  };
}

async function main() {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    console.error("Falta TMDB_API_KEY");
    process.exit(1);
  }
  const out = process.env.OUT || "catalog.json";
  try {
    const catalog = await buildCatalog({
      apiKey,
      region: process.env.WATCH_REGION || "PE",
      providers: process.env.PROVIDERS ? process.env.PROVIDERS.split(",").map((s) => s.trim()) : DEFAULT_PROVIDERS,
      types: process.env.TYPES ? process.env.TYPES.split(",").map((s) => s.trim()) : ["flatrate", "rent", "buy"],
      pages: Number(process.env.PAGES || 10),
    });
    if (!catalog.movies.length) throw new Error("Catálogo vacío; no se sobrescribe el archivo anterior");
    await writeFile(out, JSON.stringify(catalog));
    console.log(`OK: ${catalog.movies.length} películas -> ${out}`);
  } catch (e) {
    console.error("Falló la sincronización:", e.message);
    process.exit(1); // el catalog.json anterior se conserva
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
