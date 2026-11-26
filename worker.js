// Cloudflare Worker: serves the app's files and one small API, /api/weather, which asks MET Norway's Locationforecast
// on the app's behalf. MET's terms ask for an identifying User-Agent with a contact and for results to be reused
// (at least 3 hours outside the Nordics), so responses are kept in memory here and marked cacheable for the browser.
// Note: caches.default does nothing on *.workers.dev addresses, so the in-memory cache is what helps until a custom domain.

const UA = "vanlife-map/1.0 github.com/annajagiello/vanlife-map";
const KEEP_MS = 3 * 60 * 60 * 1000;
const memory = new Map(); // "lat|lon|alt" -> { at, body }, per Worker instance

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/weather") return weather(url, ctx);
    return env.ASSETS.fetch(request);
  },
};

function reply(body, status = 200, extra = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", ...extra },
  });
}

async function weather(url, ctx) {
  const lat = Number(url.searchParams.get("lat")), lon = Number(url.searchParams.get("lon"));
  const altRaw = url.searchParams.get("alt");
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return reply({ error: "bad coordinates" }, 400);
  // Two decimals (about 1 km) so nearby requests share one MET call; MET allows at most four.
  const la = lat.toFixed(2), lo = lon.toFixed(2);
  const alt = altRaw !== null && altRaw !== "" && Number.isFinite(Number(altRaw)) ? String(Math.round(Number(altRaw))) : "";
  const key = la + "|" + lo + "|" + alt;
  const cacheHeaders = { "Cache-Control": "public, max-age=10800" };

  const hit = memory.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return reply(hit.body, 200, cacheHeaders);
  const cacheKey = new Request("https://vanlife-map.cache/weather?" + key);
  const cached = await caches.default.match(cacheKey); // works only on a custom domain
  if (cached) return cached;

  const met = "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=" + la + "&lon=" + lo + (alt ? "&altitude=" + alt : "");
  const r = await fetch(met, { headers: { "User-Agent": UA } });
  if (!r.ok) return reply({ error: "MET Norway answered " + r.status }, r.status === 429 ? 429 : 502);
  const d = await r.json();
  // Only what the app uses: time, temperature, 1-hour and 6-hour symbol and precipitation.
  const series = d.properties.timeseries.map((e) => {
    const x = e.data;
    return [e.time, x.instant.details.air_temperature,
      x.next_1_hours?.summary?.symbol_code ?? null, x.next_1_hours?.details?.precipitation_amount ?? null,
      x.next_6_hours?.summary?.symbol_code ?? null, x.next_6_hours?.details?.precipitation_amount ?? null];
  });
  const body = JSON.stringify({ altitude: d.geometry.coordinates[2], updated: d.properties.meta.updated_at, series });
  memory.set(key, { at: Date.now(), body });
  if (memory.size > 5000) memory.delete(memory.keys().next().value); // keep memory bounded
  const res = reply(body, 200, cacheHeaders);
  ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
  return res;
}
