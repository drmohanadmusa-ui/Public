// LedgerOS exchange balances (#165, v5.36): the Binance function's twin for KuCoin, MEXC, LBank and Poloniex.
// Reads balances, and (like binance-balances #154) Spot trades for one coin/USDT or coin/USDC pair over at most
// 24 hours, deposits and withdrawals over at most 90 days, with his read-only keys kept only as Edge Function
// secrets (KUCOIN_API_KEY/SECRET/PASSPHRASE, MEXC_API_KEY/SECRET, LBANK_API_KEY/SECRET, POLONIEX_API_KEY/SECRET).
// Only these fixed GET/read calls are made; anything else is refused. The app calls it with x-region eu-central-1
// (these exchanges refuse US servers). Plain JavaScript on purpose (valid TypeScript), so the tests run it in Node.
// Input {exchange, action?, symbol?, startTime?, endTime?}; output {balances:{COIN: units}} or {rows:[...]} as
// binance-balances: trades {time, buy, qty, quoteQty, price, fee, feeAsset}; deposits/withdrawals {time, coin, amount, fee}.
// Deploy: edge/README.md (verify_jwt true).
const enc = (s) => new TextEncoder().encode(s);
export async function hmac(secret, msg, subtle, out) {
  const key = await subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const b = new Uint8Array(await subtle.sign("HMAC", key, enc(msg)));
  return out === "base64" ? btoa(String.fromCharCode(...b)) : Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
}
// MD5 (LBank signs the MD5 of the sorted parameters; WebCrypto has no MD5). Hex, lower case.
export function md5(str) {
  const b = enc(str), n = ((b.length + 8) >> 6) + 1, w = new Array(n * 16).fill(0);
  for (let i = 0; i < b.length; i++) w[i >> 2] |= b[i] << ((i % 4) * 8);
  w[b.length >> 2] |= 0x80 << ((b.length % 4) * 8);
  w[n * 16 - 2] = b.length * 8;
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0);
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  for (let j = 0; j < w.length; j += 16) {
    let a = a0, bb = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (bb & c) | (~bb & d); g = i; }
      else if (i < 32) { f = (d & bb) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = bb ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (bb | ~d); g = (7 * i) % 16; }
      const t = d; d = c; c = bb;
      const x = (a + f + K[i] + w[j + g]) | 0, s = S[(i >> 4) * 4 + (i % 4)];
      bb = (bb + ((x << s) | (x >>> (32 - s)))) | 0; a = t;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + bb) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  return [a0, b0, c0, d0].map(v => Array.from({ length: 4 }, (_, i) => ((v >>> (i * 8)) & 255).toString(16).padStart(2, "0")).join("")).join("");
}
const NAMES = { kucoin: "KuCoin", mexc: "MEXC", lbank: "LBank", poloniex: "Poloniex" };
const SECRETS = { kucoin: ["KUCOIN_API_KEY", "KUCOIN_API_SECRET", "KUCOIN_API_PASSPHRASE"], mexc: ["MEXC_API_KEY", "MEXC_API_SECRET"], lbank: ["LBANK_API_KEY", "LBANK_API_SECRET"], poloniex: ["POLONIEX_API_KEY", "POLONIEX_API_SECRET"] };
const DAY = 86400000;
const ok = (o) => ({ status: 200, body: JSON.stringify(o) });
const bad = (status, error) => ({ status, body: JSON.stringify({ error }) });
async function getJson(fetchFn, url, opt, ex) {
  const r = await fetchFn(url, opt);
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch (e) {}
  return { r, data, text, fail: (why) => bad(502, `${NAMES[ex]} said ${r.status}: ${why || (data && (data.msg || data.message || data.error_code)) || text.slice(0, 200)}`) };
}
const num = (v) => Number(v) || 0;
const add = (o, coin, u) => { const k = String(coin || "").toUpperCase(); if (k && u > 0) o[k] = (o[k] || 0) + u; };

// ---- KuCoin: headers signed over timestamp + method + path?query; passphrase HMAC'd (API key v2/v3) ----
async function kucoin(env, input, f, subtle, now) {
  const [key, secret, pass] = SECRETS.kucoin.map(k => env[k]);
  const get = async (pathQ) => {
    const ts = String(now);
    const h = { "KC-API-KEY": key, "KC-API-SIGN": await hmac(secret, ts + "GET" + pathQ, subtle, "base64"), "KC-API-TIMESTAMP": ts,
      "KC-API-PASSPHRASE": await hmac(secret, pass, subtle, "base64"), "KC-API-KEY-VERSION": env.KUCOIN_API_KEY_VERSION || "3" };
    const g = await getJson(f, "https://api.kucoin.com" + pathQ, { method: "GET", headers: h }, "kucoin");
    if (!g.r.ok || !g.data || g.data.code !== "200000") return { fail: g.fail(g.data && g.data.msg) };
    return { data: g.data.data };
  };
  const a = input.action;
  if (!a) {
    const g = await get("/api/v1/accounts"); if (g.fail) return g.fail;
    const balances = {};
    (g.data || []).filter(x => x.type === "main" || x.type === "trade").forEach(x => add(balances, x.currency, num(x.balance)));   // 165b: Funding + Trading
    return ok({ balances });
  }
  if (a === "trades") {
    const sym = input.coin + "-" + input.quote;
    const g = await get(`/api/v1/fills?symbol=${sym}&startAt=${input.startTime}&endAt=${input.endTime}&pageSize=500`); if (g.fail) return g.fail;
    return ok({ rows: ((g.data && g.data.items) || []).map(t => ({ time: num(t.createdAt), buy: t.side === "buy", qty: num(t.size), quoteQty: num(t.funds), price: num(t.price), fee: num(t.fee), feeAsset: String(t.feeCurrency || "") })) });
  }
  const rows = [];   // KuCoin lists at most 7 days per call
  for (let s = input.startTime; s < input.endTime; s += 7 * DAY) {
    const g = await get(`/api/v1/${a}?status=SUCCESS&startAt=${s}&endAt=${Math.min(s + 7 * DAY, input.endTime)}&pageSize=500`); if (g.fail) return g.fail;
    ((g.data && g.data.items) || []).forEach(x => rows.push({ time: num(x.createdAt), coin: String(x.currency), amount: num(x.amount), fee: num(x.fee) }));
  }
  return ok({ rows });
}
// ---- MEXC: Binance-style (hex signature of the query string, X-MEXC-APIKEY) ----
async function mexc(env, input, f, subtle, now) {
  const [key, secret] = SECRETS.mexc.map(k => env[k]);
  const get = async (path, q) => {
    const qs = (q ? q + "&" : "") + `recvWindow=10000&timestamp=${now}`;
    const g = await getJson(f, `https://api.mexc.com${path}?${qs}&signature=${await hmac(secret, qs, subtle)}`, { method: "GET", headers: { "X-MEXC-APIKEY": key, "Content-Type": "application/json" } }, "mexc");
    return g.r.ok ? { data: g.data } : { fail: g.fail(), data: g.data };
  };
  const a = input.action, coinOf = (c) => String(c || "").split("-")[0];
  if (!a) {
    const g = await get("/api/v3/account", ""); if (g.fail) return g.fail;
    const balances = {}; ((g.data && g.data.balances) || []).forEach(b => add(balances, b.asset, num(b.free) + num(b.locked)));
    return ok({ balances });
  }
  if (a === "trades") {
    const g = await get("/api/v3/myTrades", `symbol=${input.coin}${input.quote}&startTime=${input.startTime}&endTime=${input.endTime}&limit=100`);
    if (g.fail) return (g.data && /symbol/i.test(String(g.data.msg || ""))) ? ok({ rows: [] }) : g.fail;   // no such pair
    return ok({ rows: (Array.isArray(g.data) ? g.data : []).map(t => ({ time: num(t.time), buy: !!t.isBuyer, qty: num(t.qty), quoteQty: num(t.quoteQty), price: num(t.price), fee: num(t.commission), feeAsset: String(t.commissionAsset || "") })) });
  }
  const g = await get(a === "deposits" ? "/api/v3/capital/deposit/hisrec" : "/api/v3/capital/withdraw/history", `startTime=${input.startTime}&endTime=${input.endTime}`); if (g.fail) return g.fail;
  const list = Array.isArray(g.data) ? g.data : [];
  return ok({ rows: a === "deposits"
    ? list.filter(x => num(x.status) === 5).map(x => ({ time: num(x.insertTime), coin: coinOf(x.coin), amount: num(x.amount), fee: 0 }))
    : list.filter(x => num(x.status) === 7).map(x => ({ time: num(x.applyTime) || Date.parse(x.applyTime), coin: coinOf(x.coin), amount: num(x.amount), fee: num(x.transactionFee) })) });
}
// RSA keys: the secret is the private key (base64 PKCS#8); the signature is RSA-SHA256, base64.
async function rsaSign(secret, msg, subtle) {
  const der = Uint8Array.from(atob(String(secret).replace(/-----[^-]+-----|\s/g, "")), c => c.charCodeAt(0));
  const key = await subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  return btoa(String.fromCharCode(...new Uint8Array(await subtle.sign("RSASSA-PKCS1-v1_5", key, enc(msg)))));
}
// ---- LBank: sorted params → MD5 (upper case) → HMAC-SHA256 hex (or RSA when the key is an RSA key); POST form ----
async function lbank(env, input, f, subtle, now) {
  const [key, secret] = SECRETS.lbank.map(k => env[k]);
  const method = String(secret).length > 64 ? "RSA" : "HmacSHA256";   // an HMAC secret is short; an RSA private key is long
  const post = async (path, extra) => {
    const echostr = "ledgeros" + String(now).padStart(24, "0");
    const p = Object.assign({ api_key: key, echostr, signature_method: method, timestamp: String(now) }, extra || {});
    const qs = Object.keys(p).sort().map(k => `${k}=${p[k]}`).join("&");
    const pre = md5(qs).toUpperCase();
    const sign = method === "RSA" ? await rsaSign(secret, pre, subtle) : await hmac(secret, pre, subtle);
    const g = await getJson(f, "https://api.lbkex.com" + path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", timestamp: String(now), signature_method: method, echostr },
      body: Object.keys(p).filter(k => k !== "echostr").map(k => `${k}=${encodeURIComponent(p[k])}`).join("&") + `&sign=${encodeURIComponent(sign)}` }, "lbank");
    if (!g.r.ok || !g.data || !(g.data.result === true || g.data.result === "true")) return { fail: g.fail(g.data && (g.data.msg || g.data.error_code)), data: g.data };
    return { data: g.data.data };
  };
  const a = input.action;
  if (!a) {
    const g = await post("/v2/supplement/user_info.do"); if (g.fail) return g.fail;
    const balances = {}; (Array.isArray(g.data) ? g.data : []).forEach(x => add(balances, x.coin, num(x.assetAmt) || (num(x.usableAmt) + num(x.freezeAmt))));
    return ok({ balances });
  }
  if (a === "trades") {
    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    const g = await post("/v2/supplement/transaction_history.do", { symbol: `${input.coin}_${input.quote}`.toLowerCase(), startTime: day(input.startTime), endTime: day(input.endTime) });
    if (g.fail) return (g.data && /symbol|pair/i.test(String(g.data.msg || ""))) ? ok({ rows: [] }) : g.fail;
    return ok({ rows: (Array.isArray(g.data) ? g.data : []).filter(t => num(t.time) >= input.startTime && num(t.time) < input.endTime).map(t => ({ time: num(t.time), buy: t.isBuyer === true || t.isBuyer === "true", qty: num(t.qty), quoteQty: num(t.quoteQty), price: num(t.price), fee: num(t.commission),
      feeAsset: (t.isBuyer === true || t.isBuyer === "true") ? input.coin : input.quote })) });   // LBank takes the fee from what you receive
  }
  const g = await post(a === "deposits" ? "/v2/supplement/deposit_history.do" : "/v2/supplement/withdraws.do", { startTime: String(input.startTime), endTime: String(input.endTime) }); if (g.fail) return g.fail;
  const list = (g.data && (g.data.depositOrders || g.data.withdraws)) || (Array.isArray(g.data) ? g.data : []);
  return ok({ rows: list.filter(x => a === "deposits" ? String(x.status) === "2" : String(x.status) === "4")
    .map(x => ({ time: num(x.insertTime || x.applyTime || x.time), coin: String(x.coin || x.assetCode || "").split("-")[0], amount: num(x.amount), fee: num(x.fee) })) });
}
// ---- Poloniex: "GET\n/path\n" + sorted params incl. signTimestamp → HMAC-SHA256 base64 ----
async function poloniex(env, input, f, subtle, now) {
  const [key, secret] = SECRETS.poloniex.map(k => env[k]);
  const get = async (path, q) => {
    const p = Object.assign({ signTimestamp: String(now) }, q || {});
    const qs = Object.keys(p).sort().map(k => `${k}=${encodeURIComponent(p[k])}`).join("&");
    const sig = await hmac(secret, `GET\n${path}\n${qs}`, subtle, "base64");
    const url = "https://api.poloniex.com" + path + (q && Object.keys(q).length ? "?" + Object.keys(q).map(k => `${k}=${encodeURIComponent(q[k])}`).join("&") : "");
    const g = await getJson(f, url, { method: "GET", headers: { key, signatureMethod: "HmacSHA256", signatureVersion: "2", signTimestamp: String(now), signature: sig } }, "poloniex");
    return g.r.ok ? { data: g.data } : { fail: g.fail(), data: g.data };
  };
  const a = input.action;
  if (!a) {
    const g = await get("/accounts/balances"); if (g.fail) return g.fail;
    const balances = {};
    (Array.isArray(g.data) ? g.data : []).filter(x => String(x.accountType || "SPOT").toUpperCase() === "SPOT").forEach(acc => (acc.balances || []).forEach(b => add(balances, b.currency, num(b.available) + num(b.hold))));
    return ok({ balances });
  }
  if (a === "trades") {
    const g = await get("/trades", { symbols: `${input.coin}_${input.quote}`, startTime: String(input.startTime), endTime: String(input.endTime), limit: "1000" });
    if (g.fail) return (g.data && /symbol/i.test(String(g.data.message || ""))) ? ok({ rows: [] }) : g.fail;
    return ok({ rows: (Array.isArray(g.data) ? g.data : []).map(t => ({ time: num(t.createTime), buy: String(t.side).toUpperCase() === "BUY", qty: num(t.quantity), quoteQty: num(t.amount), price: num(t.price), fee: num(t.feeAmount), feeAsset: String(t.feeCurrency || "") })) });
  }
  const g = await get("/wallets/activity", { start: String(Math.floor(input.startTime / 1000)), end: String(Math.floor(input.endTime / 1000)) }); if (g.fail) return g.fail;
  const list = (g.data && g.data[a]) || [];
  return ok({ rows: list.filter(x => /^COMPLETE/i.test(String(x.status || ""))).map(x => ({ time: num(x.timestamp) * 1000, coin: String(x.currency || ""), amount: num(x.amount), fee: num(x.fee) })) });
}
const RUN = { kucoin, mexc, lbank, poloniex };
// Checks the input, then makes the exchange's fixed read call(s). Returns {status, body}.
export async function exchangeCall(env, input, fetchFn, subtle, now) {
  const ex = String((input && input.exchange) || "").toLowerCase();
  if (!RUN[ex]) return bad(400, "Unknown exchange: " + ex);
  const missing = SECRETS[ex].filter(k => !env[k]);
  if (missing.length) return bad(400, `${NAMES[ex]} key not set up: add ${missing.join(", ")} as Edge Function secrets`);
  const a = input.action;
  const q = { action: a };
  if (a) {
    if (!["trades", "deposits", "withdrawals"].includes(a)) return bad(400, "Unknown action: " + a);
    q.startTime = Math.floor(Number(input.startTime)); q.endTime = Math.floor(Number(input.endTime));
    if (!(q.startTime > 0) || !(q.endTime > q.startTime)) return bad(400, "startTime and endTime are needed");
    if (a === "trades") {
      const m = /^([A-Z0-9]{2,20})(USDT|USDC)$/.exec(String(input.symbol || ""));
      if (!m) return bad(400, "Only coin/USDT or coin/USDC pairs");
      if (q.endTime - q.startTime > DAY) return bad(400, "At most 24 hours of trades per call");
      q.coin = m[1]; q.quote = m[2];
    } else if (q.endTime - q.startTime > 90 * DAY) return bad(400, "At most 90 days per call");
  }
  return RUN[ex](env, q, fetchFn, subtle, now);
}
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-region", "Access-Control-Allow-Methods": "POST, OPTIONS" };
if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    try {
      const env = {}; Object.values(SECRETS).flat().concat(["KUCOIN_API_KEY_VERSION"]).forEach(k => { env[k] = Deno.env.get(k); });
      const out = await exchangeCall(env, await req.json().catch(() => ({})), fetch, crypto.subtle, Date.now());
      return new Response(out.body, { status: out.status, headers: Object.assign({ "Content-Type": "application/json" }, CORS) });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500, headers: Object.assign({ "Content-Type": "application/json" }, CORS) });
    }
  });
}
