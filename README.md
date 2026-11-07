# TNMM Benchmarking (Transfer Pricing)

Web app for Malaysian TNMM benchmarking: staff upload audited accounts, Mistral OCR reads them,
figures are reviewed and adjusted, comparables are tested, and the arm's length range is exported
to a formula-driven Excel workbook (two tabs: Calculation, Summary of Interquartile).

- Site: GitHub Pages, single `index.html` (built from `src/` with `python3 build.py`).
- Backend: Supabase project **Transfer Pricing** (`fqxxrqjrbhrifybzxvly`, Singapore).
  - Auth: email + password; new accounts wait for admin approval (`tp_profiles.status`).
  - `tnmm_jobs`: saved jobs, private to each user (admins can read all).
  - Storage bucket `tnmm-uploads`: the uploaded file is deleted as soon as OCR finishes.
  - Edge Function `tnmm-ocr`: calls Mistral OCR, then Mistral chat to map lines. Needs the
    secret `MISTRAL_API_KEY` (Supabase → Edge Functions → Secrets). Optional overrides:
    `MISTRAL_OCR_MODEL`, `MISTRAL_CHAT_MODEL`.
- Rules follow the `tnmm-benchmarking-v3` skill: IRBM-supported adjustments only, 10% size test,
  20% RPT test, 37.5th–62.5th percentile with mid-point median (YA 2023+) or 25th–75th (before YA 2023).
