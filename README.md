# TNMM Calculator (Transfer Pricing)

Web app for Malaysian TNMM benchmarking: staff upload audited accounts, Mistral OCR reads them,
figures are reviewed and adjusted, comparables are tested, and the arm's length range is exported
to a formula-driven Excel workbook (two tabs: Calculation, Summary of Interquartile).

- Site: GitHub Pages, single `index.html` (built from `src/` with `python3 build.py`).
- Backend: Supabase project **Transfer Pricing** (`fqxxrqjrbhrifybzxvly`, Singapore).
  - Sign-in: staff sign in once in the **CCTaxLab portal** (same address, clowws-byte.github.io), and this
    app reads that session. The `tnmm-api` Edge Function re-checks the token with CCTaxLab on every call and
    allows only people who can see the TNMM application in CCTaxLab (Admin → Access), plus CCTaxLab admins.
    The application must be listed in CCTaxLab with a link containing `tnmm-benchmarking`.
  - `tnmm_jobs`: saved jobs keyed by CCTaxLab user id, reached only through the Edge Function.
  - Uploaded accounts go straight to the function and on to Mistral; they are never stored.
  - Edge Function `tnmm-api`: jobs, Mistral OCR, then Mistral chat to map lines. Needs the
    secret `MISTRAL_API_KEY` (Supabase → Edge Functions → Secrets). Optional overrides:
    `MISTRAL_OCR_MODEL`, `MISTRAL_CHAT_MODEL`.
- Rules follow the `tnmm-benchmarking-v3` skill: IRBM-supported adjustments only, 10% size test,
  20% RPT test, 37.5th–62.5th percentile with mid-point median (YA 2023+) or 25th–75th (before YA 2023).
