// LedgerOS wallet reader (v5.15, #75): a Supabase Edge Function that passes read-only wallet calls
// to public blockchain servers from Supabase's side. Browsers can't use them directly: publicnode
// blocks getTokenAccountsByOwner ("Request blocked") and Solana's own server refuses browser calls.
// Only read methods are allowed, and only to the fixed servers below. Plain JavaScript on purpose
// (valid TypeScript), so the tests can run it in Node. Deploy: edge/README.md (verify_jwt true).
export const WALLET_RPC = {
  solana: "https://api.mainnet-beta.solana.com",
  base: "https://mainnet.base.org",
  ethereum: "https://ethereum-rpc.publicnode.com",
};
export const WALLET_METHODS = ["getTokenAccountsByOwner", "getBalance", "getSignaturesForAddress", "getTransaction",
  "eth_call", "eth_getBalance", "eth_blockNumber", "eth_chainId"];
// Returns {status, body}: the server's own answer, or a 400 for anything not allowed.
export async function walletRpc(input, fetchFn) {
  const chain = input && input.chain, body = input && input.body;
  const url = WALLET_RPC[chain];
  if (!url) return { status: 400, body: JSON.stringify({ error: "Unknown chain: " + chain }) };
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > 50) return { status: 400, body: JSON.stringify({ error: "Send 1 to 50 calls" }) };
  const bad = calls.find(c => !c || WALLET_METHODS.indexOf(c.method) < 0);
  if (bad) return { status: 400, body: JSON.stringify({ error: "Method not allowed: " + (bad && bad.method) }) };
  const r = await fetchFn(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.text() };
}
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    try {
      const out = await walletRpc(await req.json(), fetch);
      return new Response(out.body, { status: out.status, headers: Object.assign({ "Content-Type": "application/json" }, CORS) });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500, headers: Object.assign({ "Content-Type": "application/json" }, CORS) });
    }
  });
}
