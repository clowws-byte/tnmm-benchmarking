# TNMM Calculator (Transfer Pricing)

Web app for Malaysian TNMM benchmarking: staff upload audited accounts, the browser reads them (pdf.js / Tesseract.js, free; Gemini as fallback),
figures are reviewed and adjusted, comparables are tested, and the arm's length range is exported
to a formula-driven Excel workbook (two tabs: Calculation, Summary of Interquartile).

- Site: GitHub Pages, single `index.html` (built from `src/` with `python3 build.py`).
- Backend: Supabase project **Transfer Pricing** (`fqxxrqjrbhrifybzxvly`, Singapore).
  - Sign-in: staff sign in once in the **CCTaxLab portal** (same address, clowws-byte.github.io), and this
    app reads that session. The `tnmm-api` Edge Function re-checks the token with CCTaxLab on every call and
    allows only people who can see the TNMM application in CCTaxLab (Admin → Access), plus CCTaxLab admins.
    The application must be listed in CCTaxLab with a link containing `tnmm-benchmarking`.
  - `tnmm_jobs`: saved jobs keyed by CCTaxLab user id, reached only through the Edge Function.
  - Text is read in the browser. Only when that fails is the file uploaded to private Storage (tnmm-uploads), read by Gemini, then deleted.
  - Edge Function `tnmm-api`: jobs, fallback OCR, and mapping lines to the TNMM keys with Google Gemini.
    Secret `GEMINI_API_KEY` (also accepted: GOOGLE_API_KEY, GOOGLE_GEMINI_API_KEY, GEMINI_KEY).
    Optional `GEMINI_MODEL` (default gemini-flash-latest, then gemini-2.5-flash). `MISTRAL_API_KEY` is
    used only if no Gemini key is set, or for Word/PowerPoint files.
- Rules follow the `tnmm-benchmarking-v3` skill: IRBM-supported adjustments only, 10% size test,
  20% RPT test, 37.5th–62.5th percentile with mid-point median (YA 2023+) or 25th–75th (before YA 2023).
