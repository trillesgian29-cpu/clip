# Loop Budget & Rate-Limit Policy — ClipGenius AI

- **Monetary API Cap**: `$0.00` (OpenRouter free tier `nvidia/nemotron-3.5-super-vl:free` only; never invoke paid models).
- **OpenRouter Concurrency**: Max `1` active live analysis request at a time.
- **OpenRouter Cooldown**: Minimum `20s` delay between live OpenRouter requests in test suites.
- **HTTP 429 Circuit Breaker**: At most `1` cooldown wait (`65s`) per request on HTTP 429; if second 429 occurs or another provider blocks, stop loop test and mark `BLOCKED`.
- **Iteration Budget**: Max `3` fix-verify cycles per defect.
- **Kill Switch**: Stop immediately if secret exposure, destructive file deletion, or runaway retries are detected.
