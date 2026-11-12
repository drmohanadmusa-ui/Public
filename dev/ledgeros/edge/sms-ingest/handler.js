// ===== sms-ingest handler (hand-written; the parser above is generated from sms/ledger_sms_logger.js) =====
// The iPhone Shortcut posts the raw SMS: {"text": "<message>"}. One call per automation run.
// Answer: {result, notify}. The Shortcut shows `notify` as a notification when it isn't empty, so a
// logged SMS (or one that needs a review) gives exactly one notice, and duplicates/skips stay silent.
const REVIEW_CURRENCY = /(?:\b(?:SAR|USD|AED|EUR|GBP|KWD|BHD|QAR|OMR|EGP)\b|(?<=\d)(?:SAR|USD|AED)|ريال|ر\.س)/i;
const REVIEW_NUMBER = /\d[\d,]*(?:\.\d{1,2})?/;
const CODE_WORDS = /(?:\bOTP\b|verification code|one[- ]time|passcode|password|\bcode\b|رمز|كلمة مرور|كلمة المرور|التحقق)/i;
// A skipped message that still looks like money (a currency and a number, not a code): saved as "Needs review".
function looksLikeMoney(text) { return REVIEW_CURRENCY.test(text) && REVIEW_NUMBER.test(text) && !CODE_WORDS.test(text); }
function reviewAmount(text) {
  const m = text.match(/(?:SAR|USD|AED|ريال)\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*(?:SAR|USD|AED|ريال)/i);
  const v = m ? parseFloat((m[1] || m[2]).replace(/,/g, "")) : NaN;
  return isFinite(v) ? v : null;
}
const riyadhNow = (now) => new Date(now.getTime() + 3 * 3600e3).toISOString();   // Saudi time, no daylight saving

async function ingestSms(rawText, opt) {
  const url = String(opt.supabaseUrl || "").replace(/\/+$/, "");
  const h = { apikey: opt.serviceKey, Authorization: `Bearer ${opt.serviceKey}` };
  const now = opt.now || new Date();
  const text = normalise(String(rawText || ""));
  if (!text.trim()) return { result: "No message text received", notify: "" };

  let p = null, r = null;
  for (const x of PARSERS) {
    if (!x.test(text)) continue;
    r = x.parse(text);
    if (r) { p = x; break; }
  }
  const insert = async (row) => {
    const res = await fetch(`${url}/rest/v1/pd_sms_inbox?on_conflict=id`, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=representation" }, h),
      body: JSON.stringify([row]),
    });
    if (!res.ok) throw new Error(`Saving to LedgerOS failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const back = await res.json();
    return Array.isArray(back) && back.length > 0;   // empty = that id was already there (a duplicate run)
  };

  if (r) {
    r = Object.assign({ counter: "", fee: "", currency: "SAR", fxAmount: "", remaining: "" }, r);
    const source = r.source || p.source;
    // Same "core" and id as the Scriptable script, so a message logged either way is never logged twice.
    const core = [r.date, r.time, source, r.acct, r.counter, r.type, r.desc, r.amount, r.side,
      r.fee, r.currency, r.fxAmount, r.remaining].join("\t");
    const shown = r.amount ? `SAR ${r.amount}` : `${r.currency} ${r.fxAmount}`;
    const row = Object.assign(inboxRow(core, source, r), { status: "pending", logged_at: now.toISOString() });
    if (!(await insert(row))) return { result: `Duplicate, not logged: ${r.desc} ${shown}`, notify: "" };
    const msg = `${source} · ${shown} · ${r.desc}`;
    return { result: "Logged: " + msg, notify: "Logged to Ledger Inbox: " + msg };
  }

  // Not recognised: ignore it if he has marked similar messages as "not a bank", else keep it for review when it looks like money.
  const pr = await fetch(`${url}/rest/v1/pd_ui_prefs?select=dismissals&limit=1`, { headers: h });
  const prefs = pr.ok ? await pr.json() : [];
  const ignore = (((prefs && prefs[0]) || {}).dismissals || {}).smsIgnore;
  const phrase = (Array.isArray(ignore) ? ignore : []).find((w) => w && text.toLowerCase().includes(String(w).toLowerCase()));
  if (phrase) return { result: `Ignored: contains "${phrase}" (marked not a bank)`, notify: "" };
  if (!looksLikeMoney(text)) return { result: "Skipped: not a recognised transaction SMS", notify: "" };
  const t = riyadhNow(now);
  const first = (linesOf(text)[0] || "").slice(0, 60);
  const row = { id: cyrb53("review\t" + text), entry_date: t.slice(0, 10), entry_time: t.slice(11, 16), source: "Needs review", acct: "",
    counter_acct: null, kind: "Needs review", descr: text.slice(0, 1000), amt: reviewAmount(text), side: "Cr", fee: null,
    currency: "SAR", fx_amount: null, remaining: null, logged_at: now.toISOString(), status: "review" };
  if (!(await insert(row))) return { result: `Duplicate, needs review already: ${first}`, notify: "" };
  return { result: "Needs review: " + first, notify: "LedgerOS: an SMS needs a look (📩 SMS → Needs review): " + first };
}

// Supabase runs this. The phone's Shortcut and LedgerOS's "Paste SMS" box call it; the tests call ingestSms directly.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    const json = (b, status) => new Response(JSON.stringify(b), { status: status || 200, headers: Object.assign({ "Content-Type": "application/json" }, CORS) });
    try {
      let body = {};
      try { body = await req.json(); } catch (_e) { /* not JSON */ }
      const raw = body && typeof body.text === "string" ? body.text : (body && body.text && (body.text.content || body.text.text)) || "";
      return json(await ingestSms(raw, { supabaseUrl: Deno.env.get("SUPABASE_URL"), serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") }));
    } catch (e) {
      const m = String(e && e.message || e).slice(0, 200);
      return json({ result: "Failed: " + m, notify: "Ledger SMS needs a look: " + m }, 500);
    }
  });
}
