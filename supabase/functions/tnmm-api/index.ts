// TNMM Benchmarking API (Transfer Pricing project).
// Staff sign in through the CCTaxLab portal; this function verifies that sign-in with CCTaxLab and
// checks the person can see the TNMM application there (portal visibility rules and Access grants).
// Jobs live in public.tnmm_jobs here; Mistral OCR runs here with the MISTRAL_API_KEY secret.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { encodeBase64 } from "jsr:@std/encoding@1.0.5/base64";
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const CCT_URL = "https://orszbsqshrzhjgtlihzc.supabase.co";
const CCT_KEY = "sb_publishable_by4wqCu53U9son8u0kp1qA_Uij0ysHW"; // CCTaxLab public (publishable) key
const APP_MATCH = Deno.env.get("TNMM_PORTAL_URL_MATCH") ?? "tnmm-benchmarking";
const MISTRAL = "https://api.mistral.ai/v1";
const OCR_MODEL = Deno.env.get("MISTRAL_OCR_MODEL") ?? "mistral-ocr-latest";
const CHAT_MODEL = Deno.env.get("MISTRAL_CHAT_MODEL") ?? "mistral-large-latest";
const MAX_FILE = 20 * 1024 * 1024;
// PDFs, Word, PowerPoint and images go to Mistral OCR; spreadsheets and text are read in the browser.
const OCR_TYPES = /^(application\/pdf|image\/(png|jpeg|webp|gif|avif)|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.presentation))$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-file-name",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function cct(path: string, token: string) {
  const r = await fetch(CCT_URL + path, { headers: { apikey: CCT_KEY, Authorization: `Bearer ${token}` } });
  return r.ok ? await r.json() : null;
}

/* Who is calling, and may they use TNMM? Uses the caller's own CCTaxLab token, so CCTaxLab's RLS decides. */
async function identify(token: string) {
  if (!token) return { error: "signin" };
  const user = await cct("/auth/v1/user", token);
  if (!user?.id) return { error: "signin" };
  const [profs, tools] = await Promise.all([
    cct(`/rest/v1/portal_profiles?select=full_name,email,status,is_admin,branch&id=eq.${user.id}`, token),
    cct(`/rest/v1/portal_tools?select=id,name&url=ilike.*${encodeURIComponent(APP_MATCH)}*`, token),
  ]);
  const profile = Array.isArray(profs) ? profs[0] : null;
  if (!profile || profile.status !== "approved") return { error: "not_approved", user, profile };
  const access = !!profile.is_admin || (Array.isArray(tools) && tools.length > 0);
  if (!access) return { error: "no_access", user, profile };
  return { user, profile };
}

/* OCR runs in the background (a scanned PDF can take longer than one request may stay open).
   PDFs and Office files are uploaded to Mistral's file store, read through a short-lived link, then deleted. */
async function runOcr(db: any, runId: string, bytes: Uint8Array, mime: string, name: string, key: string) {
  let fileId: string | null = null;
  const auth = { Authorization: `Bearer ${key}` };
  try {
    let document: Record<string, string>;
    if (mime.startsWith("image/")) {
      document = { type: "image_url", image_url: `data:${mime};base64,${encodeBase64(bytes)}` };
    } else {
      const fd = new FormData();
      fd.append("purpose", "ocr");
      fd.append("file", new Blob([bytes], { type: mime }), name || "accounts.pdf");
      const up = await fetch(`${MISTRAL}/files`, { method: "POST", headers: auth, body: fd });
      if (!up.ok) throw new Error(`Upload to Mistral failed (${up.status}): ${(await up.text()).slice(0, 200)}`);
      fileId = (await up.json()).id;
      const su = await fetch(`${MISTRAL}/files/${fileId}/url?expiry=1`, { headers: auth });
      if (!su.ok) throw new Error(`Mistral file link failed (${su.status}): ${(await su.text()).slice(0, 200)}`);
      document = { type: "document_url", document_url: (await su.json()).url };
    }
    const r = await fetch(`${MISTRAL}/ocr`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ model: OCR_MODEL, document, include_image_base64: false }),
    });
    if (!r.ok) throw new Error(`Mistral OCR failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    const out = await r.json();
    const pages = (out.pages || []).map((p: any) => ({ index: p.index, markdown: String(p.markdown || "") }));
    if (!pages.length) throw new Error("OCR returned no text. Check the file is the accounts.");
    await db.from("tnmm_ocr_runs").update({ status: "done", pages, page_count: pages.length, updated_at: new Date().toISOString() }).eq("id", runId);
  } catch (e) {
    await db.from("tnmm_ocr_runs").update({ status: "error", error: String((e as any)?.message || e).slice(0, 400), updated_at: new Date().toISOString() }).eq("id", runId);
  } finally {
    if (fileId) await fetch(`${MISTRAL}/files/${fileId}`, { method: "DELETE", headers: auth }).catch(() => {});
  }
}

const ADJ_KEYS = ["less_interest", "less_dividend", "adj_invest_disposal", "adj_invest_fv", "less_rental_nonop",
  "adj_nontrade_forex", "less_exceptional_income", "add_exceptional_expense"];

function extractPrompt(ctx: { role: string; fye?: string; window?: string; kind?: string }, pages: { index: number; markdown: string }[]) {
  const target = ctx.role === "tested"
    ? `This is the TESTED PARTY. Use the financial year ending ${ctx.fye || "shown as the current year"}.`
    : `This is a COMPARABLE company. Use the financial year whose year end falls ${ctx.window || "closest to the tested party year end"}. If both columns qualify, use the more recent one.`;
  const body = pages.map(p => `=== PAGE ${p.index + 1} ===\n${p.markdown}`).join("\n\n");
  return `You are a Malaysian transfer pricing analyst preparing a TNMM benchmarking. Below is text (Markdown) from one company's ${ctx.kind === "management" ? "management accounts" : "financial statements (audited accounts or management accounts)"}. ${target}

Read every figure exactly from the text. Do not estimate. If the text is management accounts with different line names, map each line to the closest key below and say so in warnings. Check: gross profit = revenue + cost of sales, and your computed PBT must equal the PBT shown in the statement of profit or loss.

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const who = await identify(token);
  const action = new URL(req.url).searchParams.get("action") ?? "";

  if (action === "me") {
    return json({ ok: !who.error, reason: who.error ?? null,
      profile: who.profile ? { name: who.profile.full_name, email: who.profile.email, admin: !!who.profile.is_admin, branch: who.profile.branch } : null });
  }
  if (who.error) {
    const msg = who.error === "signin" ? "Please sign in to CCTaxLab again." : who.error === "not_approved" ? "Your CCTaxLab account is not approved." : "You don't have access to TNMM Benchmarking. Ask an admin to grant it in CCTaxLab → Admin → Access.";
    return json({ error: msg, reason: who.error }, who.error === "signin" ? 401 : 403);
  }
  const uid = who.user.id as string;
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    if (action === "list") {
      const { data, error } = await db.from("tnmm_jobs").select("id,title,job,updated_at").eq("owner", uid).order("updated_at", { ascending: false });
      if (error) throw error;
      return json({ jobs: data });
    }

    if (action === "save") {
      const b = await req.json();
      if (!UUID.test(String(b.id || "")) || typeof b.job !== "object") return json({ error: "Bad job." }, 400);
      if (JSON.stringify(b.job).length > 2_000_000) return json({ error: "This job is too large to save." }, 413);
      const { data: cur } = await db.from("tnmm_jobs").select("owner").eq("id", b.id).maybeSingle();
      if (cur && cur.owner !== uid) return json({ error: "This job belongs to someone else." }, 403);
      const { error } = await db.from("tnmm_jobs").upsert({
        id: b.id, owner: uid, owner_email: who.profile.email ?? "", owner_name: who.profile.full_name ?? "",
        title: String(b.title || "").slice(0, 200), job: b.job, updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "delete") {
      const b = await req.json();
      if (!UUID.test(String(b.id || ""))) return json({ error: "Bad job." }, 400);
      const { error } = await db.from("tnmm_jobs").delete().eq("id", b.id).eq("owner", uid);
      if (error) throw error;
      return json({ ok: true });
    }

    const key = Deno.env.get("MISTRAL_API_KEY");
    if (action === "ocr" || action === "extract") {
      if (!key) return json({ error: "The OCR key is not set up yet. An admin needs to add MISTRAL_API_KEY in Supabase Edge Function secrets." }, 503);
    }

    if (action === "ocr") {
      // the file arrives as the raw request body; it is not kept after OCR
      const mime = (req.headers.get("Content-Type") || "").split(";")[0].trim();
      if (!OCR_TYPES.test(mime)) return json({ error: "This file type cannot be read. Use PDF, Word, PowerPoint, an image, Excel or CSV." }, 415);
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (!bytes.length) return json({ error: "The file was empty." }, 400);
      if (bytes.length > MAX_FILE) return json({ error: "The file is over 20 MB. Upload only the financial statements pages." }, 413);
      const name = decodeURIComponent(req.headers.get("X-File-Name") || "accounts").slice(0, 120);
      // Never pay twice for the same file: reuse a finished OCR of identical bytes from the last day,
      // or join one still running (started under 10 minutes ago).
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(x => x.toString(16).padStart(2, "0")).join("");
      const since = new Date(Date.now() - 86400000).toISOString(), fresh = Date.now() - 600000;
      const { data: prior } = await db.from("tnmm_ocr_runs").select("id,status,created_at").eq("owner", uid).eq("file_hash", hash)
        .gte("created_at", since).in("status", ["done", "running"]).order("created_at", { ascending: false }).limit(5);
      const reuse = (prior || []).find((r: any) => r.status === "done" || Date.parse(r.created_at) > fresh);
      if (reuse) return json({ run: reuse.id, reused: true });
      const { data: run, error } = await db.from("tnmm_ocr_runs").insert({ owner: uid, file_name: name, file_hash: hash }).select("id").single();
      if (error) throw error;
      EdgeRuntime.waitUntil(runOcr(db, run.id, bytes, mime, name, key!));
      return json({ run: run.id, reused: false });
    }

    if (action === "ocr_status") {
      const b = await req.json();
      if (!UUID.test(String(b.run || ""))) return json({ error: "Bad request." }, 400);
      const { data, error } = await db.from("tnmm_ocr_runs").select("status,pages,error").eq("id", b.run).eq("owner", uid).maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "That OCR run was not found." }, 404);
      return json(data);
    }

    if (action === "extract") {
      const b = await req.json();
      const pages = (Array.isArray(b.pages) ? b.pages : []).slice(0, 30)
        .map((p: any) => ({ index: Number(p.index) || 0, markdown: String(p.markdown || "").slice(0, 40000) }));
      if (!pages.length) return json({ error: "No pages were sent." }, 400);
      const ctx = { role: b.role === "tested" ? "tested" : "comparable", fye: String(b.fye || ""), window: String(b.window || ""), kind: b.kind === "management" ? "management" : "any" };
      const r = await fetch(`${MISTRAL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: CHAT_MODEL, temperature: 0, response_format: { type: "json_object" },
          messages: [{ role: "user", content: extractPrompt(ctx, pages) }] }),
      });
      if (!r.ok) return json({ error: `Mistral failed (${r.status}): ${(await r.text()).slice(0, 300)}` }, 502);
      const out = await r.json();
      const text = out.choices?.[0]?.message?.content ?? "";
      let result: any = null;
      try { result = JSON.parse(text); } catch { const m = String(text).match(/\{[\s\S]*\}/); if (m) try { result = JSON.parse(m[0]); } catch { /* fallthrough */ } }
      if (!result || !result.pl) return json({ error: "The figures could not be read from the answer. Try again." }, 502);
      result.adjustments = (result.adjustments || []).filter((a: any) => a && ADJ_KEYS.includes(a.key));
      return json({ result, model: out.model });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: "Something went wrong: " + String((e as any)?.message || e).slice(0, 200) }, 500);
  }
});
