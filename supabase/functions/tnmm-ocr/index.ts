// TNMM Benchmarking: OCR audited accounts with Mistral and map them to TNMM lines.
// The Mistral key lives only here, as the MISTRAL_API_KEY secret.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const MISTRAL = "https://api.mistral.ai/v1";
const OCR_MODEL = Deno.env.get("MISTRAL_OCR_MODEL") ?? "mistral-ocr-latest";
const CHAT_MODEL = Deno.env.get("MISTRAL_CHAT_MODEL") ?? "mistral-large-latest";

function b64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

const ADJ_KEYS = ["less_interest", "less_dividend", "adj_invest_disposal", "adj_invest_fv", "less_rental_nonop",
  "adj_nontrade_forex", "less_exceptional_income", "add_exceptional_expense"];

function extractPrompt(ctx: { role: string; fye?: string; window?: string }, pages: { index: number; markdown: string }[]) {
  const target = ctx.role === "tested"
    ? `This is the TESTED PARTY. Use the financial year ending ${ctx.fye || "shown as the current year"}.`
    : `This is a COMPARABLE company. Use the financial year whose year end falls ${ctx.window || "closest to the tested party year end"}. If both columns qualify, use the more recent one.`;
  const body = pages.map(p => `=== PAGE ${p.index + 1} ===\n${p.markdown}`).join("\n\n");
  return `You are a Malaysian transfer pricing analyst preparing a TNMM benchmarking. Below is OCR text (Markdown) of pages from one company's audited financial statements. ${target}

Read every figure exactly from the text. Do not estimate. Check: gross profit = revenue + cost of sales, and your computed PBT must equal the PBT shown in the statement of profit or loss.

1. Statement of profit or loss, signed: income positive, expenses and losses negative, figures in full ringgit (multiply by 1000 if presented in RM'000). Keys:
- rev: revenue; cos: cost of sales
- ooi: other operating income / other income shown above profit from operations
- dist: distribution / selling expenses; admin: administrative expenses; staff: staff costs only if a separate line on the face; ooe: other operating expenses
- fv: fair value gains/losses on investments shown as a separate line on the face
- intinc: interest / finance income shown as a separate line below operating profit; invinc: other investing income below operating profit
- fin: finance costs (negative); tax: income tax expense (negative; positive if a credit)
Every line on the face must land in exactly one key so that rev+cos+ooi+dist+admin+staff+ooe+fv+intinc+invinc+fin equals PBT.

2. TNMM adjustments from the notes (profit before tax note, other income note, finance note), each a signed contribution to normalised operating profit, using ONLY these keys:
- less_interest (negative): all interest income, wherever it sits, including inside other income
- less_dividend (negative): dividend income
- adj_invest_disposal: gain (negative) or loss (positive) on disposal of investments (not PPE)
- adj_invest_fv: fair value gain (negative) or loss (positive) on investments
- less_rental_nonop (negative): rental income not from the company's core business
- adj_nontrade_forex: non-trade foreign exchange gain (negative) or loss (positive), e.g. on loans; only if the note shows it is non-trade
- less_exceptional_income (negative): genuinely one-off non-recurring income (e.g. one-off insurance claim, one-off wage subsidy)
- add_exceptional_expense (positive): genuinely one-off non-recurring expense (e.g. impairment of PPE or investments, a one-off write-off from a specific event)
Do NOT adjust these; list them under kept_in: PPE disposal gains or losses, trade foreign exchange (realised or unrealised), normal bad debts or their reversals, payables written back, routine write-offs, depreciation. Finance costs are added back automatically, so do not include them.

3. Related party transactions for the same year: total sales to related parties and total purchases from related parties, in full ringgit; 0 if none disclosed.

4. Company details: name, registration number as printed (e.g. "450571-M (199701035071)"), principal activity in a few words, and the financial year end used, like "31 Dec 2023".

Reply with only this JSON object:
{"name":"","regno":"","activity":"","fye":"","pl":{"rev":0,"cos":0,"ooi":0,"dist":0,"admin":0,"staff":0,"ooe":0,"fv":0,"intinc":0,"invinc":0,"fin":0,"tax":0},"pbt_reported":0,"adjustments":[{"key":"less_interest","amount":0,"reason":"","page":0}],"kept_in":[{"item":"","amount":0,"reason":""}],"rpt":{"sales":0,"purchases":0,"page":0},"warnings":[""]}
Use warnings for anything a reviewer should check (unclear figures, missing notes, a year outside the window, totals that do not agree).

${body}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  const key = Deno.env.get("MISTRAL_API_KEY");
  if (!key) return json({ error: "The OCR key is not set up yet. An admin needs to add MISTRAL_API_KEY in Supabase Edge Function secrets." }, 503);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u, error: ue } = await admin.auth.getUser(token);
  if (ue || !u?.user) return json({ error: "Please sign in again." }, 401);
  const { data: prof } = await admin.from("tp_profiles").select("status").eq("id", u.user.id).maybeSingle();
  if (!prof || prof.status !== "approved") return json({ error: "Your account is not approved yet." }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }

  try {
    if (body.action === "ocr") {
      const path = String(body.path || "");
      if (!path.startsWith(u.user.id + "/")) return json({ error: "File not found." }, 404);
      const { data: file, error: fe } = await admin.storage.from("tnmm-uploads").download(path);
      if (fe || !file) return json({ error: "The uploaded file could not be read." }, 404);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mime = file.type || (path.endsWith(".pdf") ? "application/pdf" : "image/jpeg");
      const document = mime === "application/pdf"
        ? { type: "document_url", document_url: `data:application/pdf;base64,${b64(bytes)}` }
        : { type: "image_url", image_url: `data:${mime};base64,${b64(bytes)}` };
      const r = await fetch(`${MISTRAL}/ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: OCR_MODEL, document, include_image_base64: false }),
      });
      // the uploaded accounts are not kept once OCR has run
      await admin.storage.from("tnmm-uploads").remove([path]);
      if (!r.ok) return json({ error: `Mistral OCR failed (${r.status}): ${(await r.text()).slice(0, 300)}` }, 502);
      const out = await r.json();
      const pages = (out.pages || []).map((p: any) => ({ index: p.index, markdown: String(p.markdown || "") }));
      return json({ pages });
    }

    if (body.action === "extract") {
      const pages = (Array.isArray(body.pages) ? body.pages : []).slice(0, 30)
        .map((p: any) => ({ index: Number(p.index) || 0, markdown: String(p.markdown || "").slice(0, 40000) }));
      if (!pages.length) return json({ error: "No pages were sent." }, 400);
      const ctx = { role: body.role === "tested" ? "tested" : "comparable", fye: String(body.fye || ""), window: String(body.window || "") };
      const r = await fetch(`${MISTRAL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: CHAT_MODEL, temperature: 0, response_format: { type: "json_object" },
          messages: [{ role: "user", content: extractPrompt(ctx, pages) }],
        }),
      });
      if (!r.ok) return json({ error: `Mistral failed (${r.status}): ${(await r.text()).slice(0, 300)}` }, 502);
      const out = await r.json();
      const text = out.choices?.[0]?.message?.content ?? "";
      let result: any;
      try { result = JSON.parse(text); } catch {
        const m = String(text).match(/\{[\s\S]*\}/); result = m ? JSON.parse(m[0]) : null;
      }
      if (!result || !result.pl) return json({ error: "The figures could not be read from the answer. Try again." }, 502);
      result.adjustments = (result.adjustments || []).filter((a: any) => a && ADJ_KEYS.includes(a.key));
      return json({ result, model: out.model });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: "Something went wrong: " + String((e as Error)?.message || e).slice(0, 200) }, 500);
  }
});
