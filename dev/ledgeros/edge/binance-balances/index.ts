// LedgerOS Binance balances (#151): a Supabase Edge Function that reads the Spot wallet's balances with a
// read-only Binance API key. Binance needs every private call signed with the key's secret, so it can't run in
// the browser; the key and secret live only in this project's Edge Function secrets (BINANCE_API_KEY,
// BINANCE_API_SECRET), never in the app or this repo. Only fixed read calls are made: the Spot account (balances),
// and (#154) Spot trades for one coin/USDT or coin/USDC pair over at most 24 hours, deposits and withdrawals.
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
// #154: one signed GET to an allow-listed read endpoint. Returns {status, body}.
const BINANCE_HISTORY = {
  trades:      "https://api.binance.com/api/v3/myTrades",
  deposits:    "https://api.binance.com/sapi/v1/capital/deposit/hisrec",
  withdrawals: "https://api.binance.com/sapi/v1/capital/withdraw/history",
};
export async function binanceHistory(env, input, fetchFn, subtle, now) {
  const key = env.BINANCE_API_KEY, secret = env.BINANCE_API_SECRET;
  if (!key || !secret) return { status: 400, body: JSON.stringify({ error: "Binance key not set up: add BINANCE_API_KEY and BINANCE_API_SECRET as Edge Function secrets" }) };
  const action = input && input.action, base = BINANCE_HISTORY[action];
  const start = Math.floor(Number(input && input.startTime)), end = Math.floor(Number(input && input.endTime));
  if (!base) return { status: 400, body: JSON.stringify({ error: "Unknown action: " + action }) };
  if (!(start > 0) || !(end > start)) return { status: 400, body: JSON.stringify({ error: "startTime and endTime are needed" }) };
  let qs = `startTime=${start}&endTime=${end}`;
  if (action === "trades") {
    const symbol = String(input.symbol || "");
    if (!/^[A-Z0-9]{2,20}(USDT|USDC)$/.test(symbol)) return { status: 400, body: JSON.stringify({ error: "Only coin/USDT or coin/USDC pairs" }) };
    if (end - start > 86400000) return { status: 400, body: JSON.stringify({ error: "At most 24 hours of trades per call" }) };
    qs = `symbol=${symbol}&${qs}&limit=1000`;
  } else if (end - start > 90 * 86400000) return { status: 400, body: JSON.stringify({ error: "At most 90 days per call" }) };
  qs += `&recvWindow=10000&timestamp=${now}`;
  const r = await fetchFn(`${base}?${qs}&signature=${await hmacHex(secret, qs, subtle)}`, { method: "GET", headers: { "X-MBX-APIKEY": key } });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch (e) {}
  if (!r.ok) {
    if (action === "trades" && data && data.code === -1121) return { status: 200, body: JSON.stringify({ rows: [] }) };   // no such pair
    const why = r.status === 451 ? "Binance refused this server's location (call it from a non-US region)" : ((data && data.msg) || text.slice(0, 200));
    return { status: 502, body: JSON.stringify({ error: `Binance said ${r.status}: ${why}` }) };
  }
  const list = Array.isArray(data) ? data : [];
  const rows = action === "trades"
    ? list.map(t => ({ time: Number(t.time), buy: !!t.isBuyer, qty: Number(t.qty), quoteQty: Number(t.quoteQty), price: Number(t.price), fee: Number(t.commission), feeAsset: String(t.commissionAsset || "") }))
    : action === "deposits"
      ? list.filter(x => Number(x.status) === 1).map(x => ({ time: Number(x.insertTime), coin: String(x.coin), amount: Number(x.amount) }))
      : list.filter(x => Number(x.status) === 6).map(x => ({ time: Date.parse(String(x.applyTime).replace(" ", "T") + "Z"), coin: String(x.coin), amount: Number(x.amount), fee: Number(x.transactionFee) || 0 }));
  return { status: 200, body: JSON.stringify({ rows }) };
}
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-region", "Access-Control-Allow-Methods": "POST, OPTIONS" };
if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    try {
      const env = { BINANCE_API_KEY: Deno.env.get("BINANCE_API_KEY"), BINANCE_API_SECRET: Deno.env.get("BINANCE_API_SECRET") };
      const input = await req.json().catch(() => ({}));
      const out = input && input.action ? await binanceHistory(env, input, fetch, crypto.subtle, Date.now()) : await binanceBalances(env, fetch, crypto.subtle, Date.now());
      return new Response(out.body, { status: out.status, headers: Object.assign({ "Content-Type": "application/json" }, CORS) });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500, headers: Object.assign({ "Content-Type": "application/json" }, CORS) });
    }
  });
}
