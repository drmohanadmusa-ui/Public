// LedgerOS daily closing prices: a Supabase Edge Function, run once a day by pg_cron.
// Setup and deployment: dev/ledgeros/edge/README.md. Tests: node dev/ledgeros/edge/test_edge.js
//
// Reads the price links and keys LedgerOS keeps in pd_ui_prefs.dismissals.invPrices, fetches one price per
// linked position, and writes it to pd_inv_valuations as the CLOSE of the previous UTC day.
// A close's id is fixed by position and date (same formula as the app's invCloseValId), so a re-run or the
// app's Backfill rewrites the same row instead of adding a duplicate.
// Plain JavaScript on purpose (valid TypeScript), so the tests can run it in Node.

const CLOSE_ID_BASE = 1e12;
const CHAINS = { solana: { dex: "solana", gt: "solana" }, base: { dex: "base", gt: "base" }, ethereum: { dex: "ethereum", gt: "eth" } };
const dayNumber = (date) => Math.round(Date.parse(date + "T00:00:00Z") / 864e5);
const closeId = (posId, date) => CLOSE_ID_BASE + Number(posId) * 1e5 + dayNumber(date);
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

async function getJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${(String(url).match(/^https?:\/\/([^/]+)/) || [])[1]} said ${r.status}`);
  return r.json();
}

async function quoteDex(items) {
  const out = {};
  const byChain = {};
  items.forEach((it) => { if (CHAINS[it.chain]) (byChain[it.chain] = byChain[it.chain] || []).push(it); });
  for (const chain of Object.keys(byChain)) {
    for (const chunk of chunks(byChain[chain], 30)) {
      try {
        const pairs = await getJson(`https://api.dexscreener.com/tokens/v1/${CHAINS[chain].dex}/${chunk.map((i) => i.address).join(",")}`);
        chunk.forEach((it) => {
          const mine = (Array.isArray(pairs) ? pairs : []).filter((p) => p && p.baseToken &&
            String(p.baseToken.address).toLowerCase() === String(it.address).toLowerCase() && Number(p.priceUsd) > 0);
          if (!mine.length) return;
          mine.sort((a, b) => ((b.liquidity || {}).usd || 0) - ((a.liquidity || {}).usd || 0));
          out[it.posId] = Number(mine[0].priceUsd);
        });
      } catch (_e) { /* backup below */ }
      const missing = chunk.filter((it) => !out[it.posId]);
      if (!missing.length) continue;
      try {
        const gt = await getJson(`https://api.geckoterminal.com/api/v2/simple/networks/${CHAINS[chain].gt}/token_price/${missing.map((i) => i.address).join(",")}`);
        const prices = (((gt || {}).data || {}).attributes || {}).token_prices || {};
        const lower = {};
        Object.keys(prices).forEach((k) => { lower[k.toLowerCase()] = prices[k]; });
        missing.forEach((it) => { const p = Number(lower[String(it.address).toLowerCase()]); if (p > 0) out[it.posId] = p; });
      } catch (_e) { /* left without a price */ }
    }
  }
  return out;
}
async function quoteCoinGecko(items, key) {
  const out = {};
  const ids = Array.from(new Set(items.map((i) => i.id)));
  for (const chunk of chunks(ids, 200)) {
    const data = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(chunk.join(","))}&vs_currencies=usd${key ? "&x_cg_demo_api_key=" + encodeURIComponent(key) : ""}`);
    items.forEach((it) => { const p = Number(((data || {})[it.id] || {}).usd); if (p > 0) out[it.posId] = p; });
  }
  return out;
}
async function quoteStocks(items, key) {
  const out = {};
  if (!key) return out;
  for (const it of items) {
    try {
      const q = await getJson(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(it.id)}&token=${encodeURIComponent(key)}`);
      if (Number(q && q.c) > 0) out[it.posId] = Number(q.c);
    } catch (_e) { /* skip */ }
  }
  return out;
}

export async function runDailyClose(opts) {
  const url = String(opts.supabaseUrl || "").replace(/\/+$/, "");
  const key = opts.serviceKey;
  const now = opts.now ? new Date(opts.now) : new Date();
  const date = opts.date || new Date(now.getTime() - 864e5).toISOString().slice(0, 10);   // yesterday (UTC)
  const h = { apikey: key, Authorization: `Bearer ${key}` };
  const prefs = await getJson(`${url}/rest/v1/pd_ui_prefs?select=dismissals&id=eq.1`, { headers: h });
  const cfg = (((prefs || [])[0] || {}).dismissals || {}).invPrices || {};
  const links = cfg.links || {}, keys = cfg.keys || {};
  const positions = await getJson(`${url}/rest/v1/pd_inv_positions?select=id,status`, { headers: h });
  const open = new Set((positions || []).filter((p) => p.status !== "Closed").map((p) => String(p.id)));
  const dex = [], cg = [], st = [];
  Object.keys(links).forEach((posId) => {
    const l = links[posId];
    if (!open.has(String(posId)) || !l || !l.kind) return;
    if (l.kind === "dex") dex.push({ posId: Number(posId), chain: l.chain, address: l.address });
    else if (l.kind === "cg") cg.push({ posId: Number(posId), id: l.id });
    else if (l.kind === "stock") st.push({ posId: Number(posId), id: l.id });
  });
  const errors = [];
  const safe = async (fn, label) => { try { return await fn(); } catch (e) { errors.push(`${label}: ${e && e.message || e}`); return {}; } };
  const prices = Object.assign({},
    dex.length ? await safe(() => quoteDex(dex), "DEX") : {},
    cg.length ? await safe(() => quoteCoinGecko(cg, keys.cg || ""), "CoinGecko") : {},
    st.length ? await safe(() => quoteStocks(st, keys.finnhub || ""), "Finnhub") : {});
  const stamp = now.toISOString();
  const rows = Object.keys(prices).map((posId) => ({ id: closeId(posId, date), position_id: Number(posId), entry_date: date, price: prices[posId], updated_at: stamp }));
  if (rows.length) {
    const r = await fetch(`${url}/rest/v1/pd_inv_valuations?on_conflict=id`, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, h),
      body: JSON.stringify(rows),
    });
    if (!r.ok) throw new Error(`Saving prices failed: ${r.status} ${await r.text()}`);
  }
  const linked = dex.length + cg.length + st.length;
  return { date, linked, saved: rows.length, missing: linked - rows.length, errors };
}

// Supabase runs this; the tests call runDailyClose directly.
// The app's "Run the daily job now" button calls this from the browser, so it answers CORS.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    try {
      let body = {};
      try { body = await req.json(); } catch (_e) { /* empty body from pg_cron */ }
      const result = await runDailyClose({
        supabaseUrl: Deno.env.get("SUPABASE_URL"),
        serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
        date: body && /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : undefined,
      });
      return new Response(JSON.stringify(result), { headers: Object.assign({ "Content-Type": "application/json" }, CORS) });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500, headers: Object.assign({ "Content-Type": "application/json" }, CORS) });
    }
  });
}
