# MindsEye

![MindsEye header](assets/MindsEye-header.png)

[![dsh.so security](https://www.dsh.so/badges/dsh-mindseye.svg)](https://www.dsh.so/artifact/dsh-mindseye/)

> Intent-driven vision, image generation, and visible browser automation for DeepSeek Harness.

[English](README.md) | [中文](README.zh-CN.md)

Current version: 0.2.7

MindsEye is a plugin for [DeepSeek Harness](https://github.com/haiziyao/dsh). It gives text-only models access to image understanding, image generation, and optional browser automation while keeping the DSH conversation as the main user experience.

## Capabilities

### Image understanding

- Preserves DSH image attachments instead of asking users to select local files manually.
- Automatically mounts vision tools on image turns. Text-only turns keep a single activation entry until vision is needed.
- `mindseye_read_image` handles visual questions and focused tasks such as OCR, layout, charts, colors, and pixel differences.
- `mindseye_ground` returns a target's pixel bounding box for downstream actions such as clicking or cropping.
- Supports single-image and multi-image reads, with structured results for images, evidence, answers, and call metadata.

### Image generation and editing

- `mindseye_generate_image` sends a user's image request to the configured image-generation route.
- `mindseye_edit_image` sends a DSH image attachment and an edit request to the configured image-editing route.
- Generated images are returned as native DSH attachments and displayed in the conversation.
- Generation does not automatically save files to the project or run a verification pass.

### Browser automation

When `gui.enabled` is turned on, MindsEye opens a separate visible Chrome or Edge session. The GUI tools can open pages, take snapshots, wait, click, type, send key presses, scroll, and close the session.

If a page requires CAPTCHA, login, or permission confirmation, the run pauses on a native DSH question card. The user can:

- take over the visible browser and complete the step;
- skip the first handoff question when the step may already be complete; or
- abandon the run.

After the user resumes, MindsEye checks the page state before returning control to the model. The browser uses an isolated session and does not attach to the user's existing Chrome or Edge profile. GUI actions require a fresh snapshot after each action so element references and coordinates cannot silently become stale.

## Tools

| Tool | Purpose |
| --- | --- |
| `mindseye_plan` | Extracts the current request and prepares the intent context used by downstream tools. |
| `mindseye_read_image` | Answers questions about one or more images and extracts focused visual evidence. |
| `mindseye_ground` | Locates a target and returns its pixel bounding box. |
| `mindseye_generate_image` | Generates an image from the user's request. |
| `mindseye_edit_image` | Edits a supplied image attachment. |
| `mindseye_vision_activate` | Mounts the vision tools during a text-only turn. |
| `mindseye_gui_open` / `snapshot` / `wait` | Opens a browser session and observes its current state. |
| `mindseye_gui_click` / `type` / `keypress` / `scroll` | Performs a state-checked browser action. |
| `mindseye_gui_close` | Closes the current browser session. |

The memory tools are optional and expose explicit DSH operations for storing, retrieving, searching, and comparing image-related records.

## Configuration

Configure MindsEye from the DSH settings card or the plugin configuration.

- `vision.routes`: independent routes for `understand`, `extract`, and `locate`.
- `vision.fallbacks`: fallback routes for vision calls.
- `image.generate`: ordered image-generation routes.
- `image.edit`: ordered image-editing routes.
- `gui.enabled`: enables the visible browser tools. It is disabled by default.
- `gui.browser`: `auto`, `chrome`, or `edge`.
- `gui.restrictHosts`: enables host allowlisting when set to `true`.
- `gui.allowedHosts`: hosts allowed when host restriction is enabled.
- `gui.maxSteps` and `gui.timeoutMs`: limits for one browser run.

Vision routes use OpenAI-compatible Chat Completions or Responses APIs. Image routes support JSON and multipart request bodies so different image providers can be configured independently.

## Data and Safety

- Image-capable models keep native DSH image blocks. Text-only fallback paths use isolated temporary files created for the current paste operation.
- Image bytes and questions are sent to the configured provider only when a MindsEye tool makes that provider call.
- Credentials come from DSH credentials, environment variables, or plugin settings and are sent only to the matching provider.
- Browser automation starts a local Chrome or Edge child process only when explicitly enabled. It does not use the user's existing browser profile and does not execute downloaded code.
- Browser navigation can be restricted to an explicit host allowlist.

## Install

```sh
npm install dsh-mindseye
npx @deepseek-ai/dsh plugin --profile web add dsh-mindseye
```

Restart DSH Web after installation. Then configure at least one vision route in the MindsEye settings card. Unconfigured focused vision routes fall back to the general understanding route when available.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```
