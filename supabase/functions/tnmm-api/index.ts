// TNMM Benchmarking API (Transfer Pricing project).
// Staff sign in through the CCTaxLab portal; this function verifies that sign-in with CCTaxLab and
// checks the person can see the TNMM application there (portal visibility rules and Access grants).
// Jobs live in public.tnmm_jobs here. AI reading uses Google Gemini (GEMINI_API_KEY); Mistral is an optional fallback.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const CCT_URL = "https://orszbsqshrzhjgtlihzc.supabase.co";
const CCT_KEY = "sb_publishable_by4wqCu53U9son8u0kp1qA_Uij0ysHW"; // CCTaxLab public (publishable) key
const APP_MATCH = Deno.env.get("TNMM_PORTAL_URL_MATCH") ?? "tnmm-benchmarking";
const MISTRAL = "https://api.mistral.ai/v1";
const OCR_MODEL = Deno.env.get("MISTRAL_OCR_MODEL") ?? "mistral-ocr-latest";
const CHAT_MODEL = Deno.env.get("MISTRAL_CHAT_MODEL") ?? "mistral-large-latest";
const MAX_FILE = 50 * 1024 * 1024;
// Google Gemini (preferred when its key is set). Accepts any of these secret names.
const GEMINI_KEY = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_API_KEY", "GEMINI_KEY"].map(n => Deno.env.get(n)).find(Boolean) || "";
const GEMINI = "https://generativelanguage.googleapis.com";
const GEMINI_MODELS = [Deno.env.get("GEMINI_MODEL"), "gemini-flash-latest", "gemini-2.5-flash"].filter(Boolean) as string[];
// File types the server can OCR (only used when reading in the browser fails).
const OCR_TYPES = /^(application\/pdf|image\/(png|jpeg|webp|gif|avif)|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.presentation))$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
   The browser uploads the file straight to private Storage (tnmm-uploads/<user>/<run>); Gemini (or Mistral)
   reads it, and the file is deleted as soon as OCR finishes. */
const BUCKET = "tnmm-uploads";
/* Call an AI API, waiting and retrying when it answers 429 (rate limited) or 5xx. A rejected call is not billed. */
async function retryFetch(url: string, init: RequestInit, tries = 4) {
  let wait = 4000;
  for (let i = 1; ; i++) {
    const r = await fetch(url, init);
    if ((r.status !== 429 && r.status < 500) || i >= tries) return r;
    const ra = Number(r.headers.get("retry-after"));
    await r.body?.cancel();
    await new Promise(res => setTimeout(res, ra > 0 ? Math.min(ra * 1000, 30000) : wait));
    wait *= 2;
  }
}
function mistralError(what: string, status: number, text: string) {
  if (status === 429) return `Mistral is refusing requests on your API key (rate limit). Check the key's limits and billing in the Mistral console (Workspace > Limits / Billing), then try again.`;
  if (status === 401) return "Mistral rejected the API key. Check MISTRAL_API_KEY in Supabase Edge Function secrets.";
  return `${what} failed (${status}): ${text.slice(0, 200)}`;
}
/* ---- Gemini ---- */
function geminiError(what: string, status: number, text: string) {
  if (status === 429) return "Google Gemini is refusing requests on your key (quota or rate limit). Check the key's quota and billing in Google AI Studio, then try again.";
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(text)) return "Google rejected the Gemini API key. Check the key saved in Supabase Edge Function secrets.";
  if (status === 403) return "The Gemini API key is not allowed to use this API. In Google AI Studio, check the key and that the Generative Language API is enabled.";
  return `${what} failed (${status}): ${text.slice(0, 200)}`;
}
async function geminiGenerate(parts: any[], json: boolean, maxTokens = 8192) {
  let last: Response | null = null;
  for (const model of GEMINI_MODELS) {
    const r = await retryFetch(`${GEMINI}/v1beta/models/${model}:generateContent`, {
      method: "POST", headers: { "x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: "application/json" } : {}) } }),
    });
    if (r.status === 404) { last = r; await r.body?.cancel(); continue; } // model name not available: try the next one
    if (!r.ok) return { error: geminiError("Gemini", r.status, await r.text()) };
    const out = await r.json();
    const text = (out.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || "").join("");
    if (!text) return { error: "Gemini returned no text (" + (out.candidates?.[0]?.finishReason || out.promptFeedback?.blockReason || "empty") + ")." };
    return { text, model };
  }
  return { error: `No Gemini model was available (${last?.status}). Set GEMINI_MODEL in Supabase secrets to a model your key can use.` };
}
/* Upload a file to the Gemini Files API (resumable protocol) and wait until it can be used. */
async function geminiUpload(bytes: Uint8Array, mime: string, name: string) {
  const start = await fetch(`${GEMINI}/upload/v1beta/files`, {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_KEY, "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length), "X-Goog-Upload-Header-Content-Type": mime, "Content-Type": "application/json" },
    body: JSON.stringify({ file: { display_name: name.slice(0, 100) } }),
  });
  if (!start.ok) throw new Error(geminiError("Upload to Gemini", start.status, await start.text()));
  const url = start.headers.get("x-goog-upload-url");
  await start.body?.cancel();
  if (!url) throw new Error("Gemini did not return an upload link.");
  const up = await fetch(url, { method: "POST", headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize", "Content-Length": String(bytes.length) }, body: bytes });
  if (!up.ok) throw new Error(geminiError("Upload to Gemini", up.status, await up.text()));
  let file = (await up.json()).file;
  for (let i = 0; file?.state === "PROCESSING" && i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const g = await fetch(`${GEMINI}/v1beta/${file.name}`, { headers: { "x-goog-api-key": GEMINI_KEY } });
    if (g.ok) file = await g.json();
  }
  if (!file?.uri || file.state === "FAILED") throw new Error("Gemini could not process the file.");
  return file as { name: string; uri: string };
}
const TRANSCRIBE = `Transcribe this document to Markdown, page by page, exactly as printed. Start every page with a line "=== PAGE n ===" (n = page number in the file, starting at 1).
For the financial statements (statements of financial position, profit or loss, changes in equity, cash flows) and all notes to the financial statements, copy every word and figure; write tables as Markdown tables keeping the year columns.
For other pages (cover, contents, directors' report, auditors' report, statutory declaration), write only the page heading.
Do not add commentary.`;
async function runOcrGemini(db: any, runId: string, path: string, mime: string) {
  const { data: blob, error } = await db.storage.from(BUCKET).download(path);
  if (error || !blob) throw new Error("The uploaded file was not found. Upload it again.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const file = await geminiUpload(bytes, mime, path.split("/").pop() || "accounts");
  try {
    const g = await geminiGenerate([{ file_data: { mime_type: mime, file_uri: file.uri } }, { text: TRANSCRIBE }], false, 65536);
    if (g.error) throw new Error(g.error);
    const parts = g.text!.split(/^=== PAGE (\d+) ===\s*$/m);
    const pages: { index: number; markdown: string }[] = [];
    for (let i = 1; i < parts.length; i += 2) pages.push({ index: Number(parts[i]) - 1, markdown: parts[i + 1].trim() });
    return pages.length ? pages : [{ index: 0, markdown: g.text! }];
  } finally {
    await fetch(`${GEMINI}/v1beta/${file.name}`, { method: "DELETE", headers: { "x-goog-api-key": GEMINI_KEY } }).catch(() => {});
  }
}

async function runOcr(db: any, runId: string, path: string, mime: string, key: string) {
  const t0 = Date.now();
  try {
    if (GEMINI_KEY && (mime === "application/pdf" || mime.startsWith("image/"))) {
      console.log(`ocr ${runId}: Gemini`);
      const pages = await runOcrGemini(db, runId, path, mime);
      await db.from("tnmm_ocr_runs").update({ status: "done", pages, page_count: pages.length, updated_at: new Date().toISOString() }).eq("id", runId);
      console.log(`ocr ${runId}: done, ${pages.length} pages in ${Date.now() - t0} ms`);
      return;
    }
    if (!key) throw new Error("Word and PowerPoint files need Mistral OCR, which is not set up. Save the file as PDF and upload again.");
    const { data: signed, error: se } = await db.storage.from(BUCKET).createSignedUrl(path, 600);
    if (se || !signed?.signedUrl) throw new Error("The uploaded file was not found. Upload it again.");
    const document = mime.startsWith("image/")
      ? { type: "image_url", image_url: signed.signedUrl }
      : { type: "document_url", document_url: signed.signedUrl };
    console.log(`ocr ${runId}: calling Mistral`);
    const r = await retryFetch(`${MISTRAL}/ocr`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: OCR_MODEL, document, include_image_base64: false }),
    });
    if (!r.ok) throw new Error(mistralError("Mistral OCR", r.status, await r.text()));
    const out = await r.json();
    const pages = (out.pages || []).map((p: any) => ({ index: p.index, markdown: String(p.markdown || "") }));
    if (!pages.length) throw new Error("OCR returned no text. Check the file is the accounts.");
    await db.from("tnmm_ocr_runs").update({ status: "done", pages, page_count: pages.length, updated_at: new Date().toISOString() }).eq("id", runId);
    console.log(`ocr ${runId}: done, ${pages.length} pages in ${Date.now() - t0} ms`);
  } catch (e) {
    console.log(`ocr ${runId}: error ${String((e as any)?.message || e)}`);
    await db.from("tnmm_ocr_runs").update({ status: "error", error: String((e as any)?.message || e).slice(0, 400), updated_at: new Date().toISOString() }).eq("id", runId);
  } finally {
    await db.storage.from(BUCKET).remove([path]).catch(() => {});
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
    return json({ ok: !who.error, reason: who.error ?? null, ai: GEMINI_KEY ? "gemini" : Deno.env.get("MISTRAL_API_KEY") ? "mistral" : "none",
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

    const key = Deno.env.get("MISTRAL_API_KEY") || "";
    if (action === "ocr_start" || action === "ocr_go" || action === "extract") {
      if (!key && !GEMINI_KEY) return json({ error: "No AI key is set up. An admin needs to add GEMINI_API_KEY (or MISTRAL_API_KEY) in Supabase Edge Function secrets." }, 503);
    }

    if (action === "ocr_start") {
      // Step 1: the browser sends the file's fingerprint. Reuse an earlier OCR of the same file, or hand back
      // a one-time upload link so the file goes straight to private Storage (not through this function).
      const b = await req.json();
      const mime = String(b.mime || "");
      const hash = String(b.hash || "").toLowerCase();
      const size = Number(b.size) || 0;
      const name = String(b.name || "accounts").slice(0, 120);
      if (!OCR_TYPES.test(mime)) return json({ error: "This file type cannot be read. Use PDF, Word, PowerPoint, an image, Excel or CSV." }, 415);
      if (!/^[0-9a-f]{64}$/.test(hash)) return json({ error: "Bad request." }, 400);
      if (!size) return json({ error: "The file was empty." }, 400);
      if (size > MAX_FILE) return json({ error: "The file is over 50 MB. Upload only the financial statements pages." }, 413);
      // tidy up: remove any of this user's uploads left behind (older than an hour) by an interrupted run
      db.storage.from(BUCKET).list(uid, { limit: 100 }).then(({ data }: any) => {
        const old = (data || []).filter((o: any) => Date.parse(o.created_at) < Date.now() - 3600000).map((o: any) => `${uid}/${o.name}`);
        if (old.length) return db.storage.from(BUCKET).remove(old);
      }).catch(() => {});
      const since = new Date(Date.now() - 86400000).toISOString(), fresh = Date.now() - 600000;
      const { data: prior } = await db.from("tnmm_ocr_runs").select("id,status,created_at").eq("owner", uid).eq("file_hash", hash)
        .gte("created_at", since).in("status", ["done", "running"]).order("created_at", { ascending: false }).limit(5);
      const reuse = (prior || []).find((r: any) => r.status === "done" || Date.parse(r.created_at) > fresh);
      if (reuse) return json({ run: reuse.id, reused: true });
      const { data: run, error } = await db.from("tnmm_ocr_runs").insert({ owner: uid, file_name: name, file_hash: hash, mime, status: "waiting" }).select("id").single();
      if (error) throw error;
      const { data: up, error: ue } = await db.storage.from(BUCKET).createSignedUploadUrl(`${uid}/${run.id}`);
      if (ue || !up) throw new Error("Could not prepare the upload: " + (ue?.message || "unknown"));
      return json({ run: run.id, reused: false, upload: up.signedUrl });
    }

    if (action === "ocr_go") {
      // Step 2: the file is in Storage; start OCR in the background (once only).
      const b = await req.json();
      if (!UUID.test(String(b.run || ""))) return json({ error: "Bad request." }, 400);
      const { data: started } = await db.from("tnmm_ocr_runs").update({ status: "running", created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", b.run).eq("owner", uid).eq("status", "waiting").select("id,mime");
      if (!started?.length) return json({ ok: true, already: true });
      EdgeRuntime.waitUntil(runOcr(db, b.run, `${uid}/${b.run}`, started[0].mime, key));
      return json({ ok: true });
    }

    if (action === "ocr_status") {
      const b = await req.json();
      if (!UUID.test(String(b.run || ""))) return json({ error: "Bad request." }, 400);
      const { data, error } = await db.from("tnmm_ocr_runs").select("status,pages,error,created_at").eq("id", b.run).eq("owner", uid).maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "That OCR run was not found." }, 404);
      // the background worker can be stopped by the platform's time limit; don't leave the user waiting forever
      if ((data.status === "running" || data.status === "waiting") && Date.now() - Date.parse(data.created_at) > 7 * 60000) {
        const msg = data.status === "waiting" ? "The upload did not finish. Try again." : "OCR stopped before finishing (the file may be too long). Try a file with only the financial statements pages.";
        await db.from("tnmm_ocr_runs").update({ status: "error", error: msg }).eq("id", b.run);
        return json({ status: "error", error: msg });
      }
      return json({ status: data.status, pages: data.pages, error: data.error });
    }

    if (action === "extract") {
      const b = await req.json();
      const pages = (Array.isArray(b.pages) ? b.pages : []).slice(0, 30)
        .map((p: any) => ({ index: Number(p.index) || 0, markdown: String(p.markdown || "").slice(0, 40000) }));
      if (!pages.length) return json({ error: "No pages were sent." }, 400);
      const ctx = { role: b.role === "tested" ? "tested" : "comparable", fye: String(b.fye || ""), window: String(b.window || ""), kind: b.kind === "management" ? "management" : "any" };
      if (GEMINI_KEY) {
        const g = await geminiGenerate([{ text: extractPrompt(ctx, pages) }], true, 16384);
        if (g.error) return json({ error: g.error }, 502);
        let result: any = null;
        try { result = JSON.parse(g.text!); } catch { const m = String(g.text).match(/\{[\s\S]*\}/); if (m) try { result = JSON.parse(m[0]); } catch { /* fallthrough */ } }
        if (Array.isArray(result)) result = result[0];
        if (!result || !result.pl) return json({ error: "The figures could not be read from the answer. Try again." }, 502);
        result.adjustments = (result.adjustments || []).filter((a: any) => a && ADJ_KEYS.includes(a.key));
        return json({ result, model: g.model });
      }
      const r = await retryFetch(`${MISTRAL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: CHAT_MODEL, temperature: 0, response_format: { type: "json_object" },
          messages: [{ role: "user", content: extractPrompt(ctx, pages) }] }),
      });
      if (!r.ok) return json({ error: mistralError("Reading the figures", r.status, await r.text()) }, 502);
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
