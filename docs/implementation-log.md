# Implementation Log

## 2026-08-22: V3 M1-M3

### M1: Browser session foundation

- Added an opt-in Puppeteer-Core browser adapter that uses an existing Chrome, Chromium, or Edge executable.
- Added per-agent GUI sessions with replacement cleanup and explicit `close` / `closeAll` lifecycle handling.
- Restricted navigation to `http` / `https` URLs whose host is present in the configured allowlist.
- Kept GUI disabled by default and exposed `enabled`, `browser` (`auto` / `chrome` / `edge`), `allowedHosts`, `executablePath`, `maxSteps`, and `timeoutMs` in plugin settings. Enabled GUI runs use a visible, separate browser window.

### M2: Safe stateful actions

- Added snapshot tokens for click, type, keypress, and scroll actions.
- GUI actions consume the current snapshot immediately and count against the step budget, including failed attempts; no per-call approval is requested.
- Navigation and snapshots expose security-verification pages as `state: blocked`, and blocked pages reject further actions.
- Point clicks are checked against the latest snapshot viewport. Snapshots also expose generic interactive element ids with viewport-pixel boxes, so models do not need to guess site-specific CSS selectors.
- Retry-only turns such as `再次尝试` reuse the previous substantive user request instead of becoming a new vision query.
- Grounding boxes outside the source image dimensions are rejected before evidence persistence.
- Structured provider errors are serialized instead of surfacing as `[object Object]`.
- Wait and page operations enforce the configured timeout; timed-out operations no longer leave timeout timers behind.

### M3: DSH tool integration

- Added `mindseye_gui_open`, `mindseye_gui_snapshot`, `mindseye_gui_wait`, `mindseye_gui_click`, `mindseye_gui_type`, `mindseye_gui_keypress`, `mindseye_gui_scroll`, and `mindseye_gui_close`.
- GUI snapshots are saved through the DSH attachment service and rendered as native image blocks with a JSON result block.
- `auto` follows the Windows default browser when it is Chrome or Edge, then falls back to an installed supported browser; the plugin never attaches to an already-open personal browser profile.
- Tool registration remains conditional on `gui.enabled`; settings changes rebuild the tool set and close the previous manager.

### Verification

- M1-M3 focused tests: 27 passed.
- Core/V2 regression set remains covered by the full suite.
- Full suite: 248 passed across 36 test files.
- Type check: passed.
- Build: passed.

### Self-check hardening

- Re-check the current page URL before and after waits/actions; a redirect or action navigation outside the allowlist closes that specific run.
- Consume snapshot state before waiting or executing an approved action, including failure and timeout paths.
- Refresh the page title for each snapshot instead of caching it at open time.
- Bind cleanup to the concrete run so an old in-flight action cannot close a replacement session for the same agent.
- Validate point targets as exactly `x,y` and keep the browser sandbox enabled by default.
- Plugin teardown now awaits GUI browser cleanup.

No commit, push, version bump, or npm publish was performed.
