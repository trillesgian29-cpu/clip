# Loop Engineering Configuration — ClipGenius AI

## Active Loops

| Pattern | Cadence | Mode | Target |
|---------|---------|------|--------|
| Checkpoint Orchestrator | Bounded step-loop | L1 Report-Only on high-risk / external / paid ops | Complete Checkpoints 3B–4E & Security/Regression |

## Workflow Stages
`DISCOVER -> PLAN -> IMPLEMENT -> VERIFY -> REVIEW -> PERSIST STATE -> NEXT TASK`

## Task Status Vocabulary
- `NOT_STARTED`
- `IN_PROGRESS`
- `BLOCKED`
- `FAILED`
- `PASSED`
- `NOT_VERIFIED`

## Circuit Breakers & Limits
- Max fix-verify cycles per defect: `3` (escalate to human as `BLOCKED` if still failing).
- Max concurrent E2E AI suites: `1` (strictly serial OpenRouter calls).
- Minimum cooldown between OpenRouter `:free` requests: `20s`.
- On HTTP `429`: maximum 1 wait of `65s` per test, then stop retrying and mark `BLOCKED` or report exact failure.
- Verification discipline: No `PASSED` status without observed runtime output (`tsc`, `vite build`, HTTP checks, `ffprobe`, `ffmpeg -f null -`).
- Maker/Checker disclosure: Single-agent orchestrator runs separate read/verify checks (`verifier pass` explicitly executed after each implementation pass and disclosed in `STATE.md` and Final Report).

## Human Gates & Safety Boundaries
- Never delete existing user source videos, `.env`, or unrelated rendered assets without explicit user approval.
- Never commit or log secrets, bearer tokens, cookies, API keys, or private transcript contents.
- Never invoke paid OpenRouter models or paid external services.
- Never mask upstream provider errors (e.g., Gemini HTTP 403 `PERMISSION_DENIED`) with fake template data.
- Never deploy, change production secrets, or alter external infrastructure without explicit user approval.

## Budget & Kill Switch
- See `loop-budget.md` for API cost caps (`$0.00` free-tier only) and kill-switch rules.
- See `loop-constraints.md` for binding safety denylists and rules.
- See `STATE.md` for live task state and `CHECKPOINT_LOG.md` for timestamped step history.
