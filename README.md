# TNMM Calculator (Transfer Pricing)

Web app for Malaysian TNMM benchmarking: staff upload audited accounts, Google Gemini reads them (OCR on the server),
figures are reviewed and adjusted, comparables are tested, and the arm's length range is exported
to a formula-driven Excel workbook (two tabs: Calculation, Summary of Interquartile).

- Site: GitHub Pages, single `index.html` (built from `src/` with `python3 build.py`).
- Backend: Supabase project **Transfer Pricing** (`fqxxrqjrbhrifybzxvly`, Singapore).
  - Sign-in: staff sign in once in the **CCTaxLab portal** (same address, clowws-byte.github.io), and this
    app reads that session. The `tnmm-api` Edge Function re-checks the token with CCTaxLab on every call and
    allows only people who can see the TNMM application in CCTaxLab (Admin → Access), plus CCTaxLab admins.
    The application must be listed in CCTaxLab with a link containing `tnmm-benchmarking`.
  - `tnmm_jobs`: saved jobs keyed by CCTaxLab user id, reached only through the Edge Function.
  - PDFs, images, Word and PowerPoint files are uploaded to private Storage (tnmm-uploads), read by Gemini, then deleted.
    Excel and CSV files are still read in the browser. Text already read is reused for 14 days (same file, same browser) and for 14 days on the server (same file, same person), so the same file is not charged twice.
  - Edge Function `tnmm-api`: jobs, OCR, and mapping lines to the TNMM keys with Google Gemini.
    Secret `GEMINI_API_KEY` (also accepted: GOOGLE_API_KEY, GOOGLE_GEMINI_API_KEY, GEMINI_KEY).
    Optional `GEMINI_MODEL` (default gemini-flash-latest, then gemini-flash-lite-latest). `MISTRAL_API_KEY` is
    used only if no Gemini key is set, or for Word/PowerPoint files.
- Rules follow the `tnmm-benchmarking-v3` skill: IRBM-supported adjustments only; rejection tests are
  turnover >= 10% of the tested party, RPT sales (of turnover) and RPT purchases (of cost of sales, or total
  costs if there is none) each <= 20%, comparable FYE within the comparable period (-6/+6 or -7/+5 months,
  MTPG 2024 paras 4.5-4.7), plus the three manual tests. Range is 37.5th-62.5th percentile with mid-point
  median (YA 2023+) or 25th-75th (before YA 2023). For YA 2023+, a tested party below the range gets the
  adjustment to the median for each PLI (never adjusted downwards). The Excel export mirrors the skill's
  `build_benchmark.py` layout.
