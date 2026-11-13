# Loop Constraints — ClipGenius AI

## Protected Paths & Data (Never Modify or Expose Without Explicit Approval)
- `.env` (never log, copy to client code, commit, or read secrets into reports)
- Existing user uploaded videos in `uploads/` and baseline sample files in `samples/`
- Unrelated existing completed MP4 renders in `rendered/`

## Code & Testing Discipline
- Preserve working Strict Nemotron routing (`nvidia/nemotron-3.5-super-vl:free`), JSON Schema enforcement, and editorial duration policies (`viral_shorts` 30-60s, `punchy_hooks` 15-30s, `educational` 20-60s, `storytelling` 25-60s).
- Never silence failing assertions or substitute mock/template clips for failed AI calls.
- Max 3 fix-verify attempts per failing item; stop and escalate as `BLOCKED` if unresolved.
- Wait >= 20 seconds between OpenRouter `:free` requests; never run duplicate concurrent E2E suites.
- Always restart dev server before verifying server code edits, and run `tsc --noEmit` + `vite build`.

## Human Approval Required For
- Deleting any existing user source videos or unrelated persisted renders
- Enabling any paid API model or billing tier
- Changing production credentials or deploying externally
