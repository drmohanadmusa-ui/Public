// LedgerOS Binance balances (#151): a Supabase Edge Function that reads the Spot wallet's balances with a
// read-only Binance API key. Binance needs every private call signed with the key's secret, so it can't run in
// the browser; the key and secret live only in this project's Edge Function secrets (BINANCE_API_KEY,
// BINANCE_API_SECRET), never in the app or this repo. Only one fixed read call is made (GET /api/v3/account).
// Binance refuses calls from the US and this project is in us-east-1, so the app calls it with x-region set to a
// non-US region. Plain JavaScript on purpose (valid TypeScript), so the tests can run it in Node.
// Deploy: edge/README.md (verify_jwt true).
export const BINANCE_ACCOUNT_URL = "https://api.binance.com/api/v3/account";
async function hmacHex(secret, msg, subtle) {
  const enc = new TextEncoder();
  const key = await subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await subtle.sign("HMAC", key, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}
// Returns {status, body}: {balances:{ASSET: free+locked}} or {error}. Zero balances are left out.
export async function binanceBalances(env, fetchFn, subtle, now) {
  const key = env.BINANCE_API_KEY, secret = env.BINANCE_API_SECRET;
  if (!key || !secret) return { status: 400, body: JSON.stringify({ error: "Binance key not set up: add BINANCE_API_KEY and BINANCE_API_SECRET as Edge Function secrets" }) };
  const qs = `omitZeroBalances=true&recvWindow=10000&timestamp=${now}`;
  const url = `${BINANCE_ACCOUNT_URL}?${qs}&signature=${await hmacHex(secret, qs, subtle)}`;
  const r = await fetchFn(url, { method: "GET", headers: { "X-MBX-APIKEY": key } });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch (e) {}
  if (!r.ok) {
    const why = r.status === 451 ? "Binance refused this server's location (call it from a non-US region)" : ((data && data.msg) || text.slice(0, 200));
    return { status: 502, body: JSON.stringify({ error: `Binance said ${r.status}: ${why}` }) };
  }
  const balances = {};
  ((data && data.balances) || []).forEach(b => {
    const u = (Number(b.free) || 0) + (Number(b.locked) || 0);
    if (u > 0) balances[String(b.asset).toUpperCase()] = u;
  });
  return { status: 200, body: JSON.stringify({ balances }) };
}
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-region", "Access-Control-Allow-Methods": "POST, OPTIONS" };
if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    try {
      const env = { BINANCE_API_KEY: Deno.env.get("BINANCE_API_KEY"), BINANCE_API_SECRET: Deno.env.get("BINANCE_API_SECRET") };
      const out = await binanceBalances(env, fetch, crypto.subtle, Date.now());
      return new Response(out.body, { status: out.status, headers: Object.assign({ "Content-Type": "application/json" }, CORS) });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500, headers: Object.assign({ "Content-Type": "application/json" }, CORS) });
    }
  });
}
