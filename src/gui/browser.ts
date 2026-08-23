import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

export interface GuiAttachmentRef {
  attachmentId: string
  mediaType: string
  bytes?: number
  name?: string
}

export interface GuiTarget {
  kind: 'element' | 'selector' | 'point'
  value: string
}

export interface GuiInputTarget {
  kind: 'element' | 'selector' | 'focus'
  value?: string
}

export type GuiKey = 'Enter' | 'Tab' | 'Escape' | 'Backspace' | 'Delete' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
export type GuiBrowserChoice = 'auto' | 'chrome' | 'edge'

export interface GuiElementRef {
  elementId: string
  kind: 'link' | 'button' | 'input' | 'textarea' | 'select' | 'editable'
  label: string
  value?: string
  box: { x: number; y: number; width: number; height: number }
}

export interface GuiViewport {
  width: number
  height: number
}

export interface GuiPage {
  readonly url: string
  title(): Promise<string>
  focus(): Promise<void>
  screenshot(): Promise<Uint8Array>
  viewport(): Promise<GuiViewport>
  interactiveElements(): Promise<GuiElementRef[]>
  click(target: GuiTarget): Promise<void>
  type(target: GuiInputTarget | undefined, text: string): Promise<void>
  keypress(key: GuiKey): Promise<void>
  scroll(deltaX: number, deltaY: number): Promise<void>
  wait(milliseconds: number): Promise<void>
  close(): Promise<void>
}

export interface GuiBrowser {
  open(url: string, options: { timeoutMs: number }): Promise<GuiPage>
}

export interface GuiSessionManagerOptions {
  browser: GuiBrowser
  saveImage: (input: {
    data: Uint8Array
    mediaType: 'image/png'
    name: string
  }) => Promise<GuiAttachmentRef>
  restrictHosts: boolean
  allowedHosts: string[]
  maxSteps: number
  timeoutMs: number
}

export interface GuiOpenResult {
  runId: string
  url: string
  title: string
  state: 'ready' | 'blocked'
  control: 'model' | 'user'
  reason?: 'security-verification'
}

export interface GuiHandoffResult {
  runId: string
  url: string
  title: string
  state: 'ready' | 'blocked'
  control: 'model' | 'user'
  action: 'takeover' | 'resume'
  reason?: 'security-verification'
}

export interface GuiSnapshotResult {
  runId: string
  snapshotId: string
  url: string
  title: string
  state: 'ready' | 'blocked'
  control: 'model' | 'user'
  reason?: 'security-verification'
  viewport: GuiViewport
  elements: GuiElementRef[]
  attachment: GuiAttachmentRef
}

export interface GuiActionResult {
  runId: string
  action: 'click' | 'type' | 'keypress' | 'scroll' | 'wait'
  completed: true
  nextStep: 'snapshot-required'
}

interface GuiRun {
  runId: string
  page: GuiPage
  steps: number
  snapshotId?: string
  snapshotViewport?: GuiViewport
  state: 'ready' | 'blocked'
  control: 'model' | 'user'
  lastTitle: string
  reason?: 'security-verification'
  closed?: boolean
}

export class GuiSessionManager {
  private readonly runs = new Map<unknown, GuiRun>()
  private readonly runsById = new Map<string, GuiRun>()

  constructor(private readonly options: GuiSessionManagerOptions) {}

  async open(agent: unknown, url: string): Promise<GuiOpenResult> {
    this.assertAgent(agent)
    this.assertAllowedUrl(url)
    await this.close(agent)
    const page = await this.options.browser.open(url, { timeoutMs: this.options.timeoutMs })
    try {
      this.assertAllowedUrl(page.url)
      const title = await this.withTimeout(page.title())
      const status = pageStatus(page.url, title)
      const run: GuiRun = {
        runId: `gui-${randomUUID()}`,
        page,
        steps: 0,
        control: 'model',
        lastTitle: title,
        ...status,
      }
      this.runs.set(agent, run)
      this.runsById.set(run.runId, run)
      return { runId: run.runId, url: page.url, title, control: run.control, ...status }
    } catch (error) {
      await page.close().catch(() => undefined)
      throw error
    }
  }

  async snapshot(agent: unknown): Promise<GuiSnapshotResult> {
    const run = this.runOf(agent)
    await this.ensurePageAllowed(agent, run)
    const data = await this.withTimeout(run.page.screenshot())
    const title = await this.withTimeout(run.page.title())
    await this.ensurePageAllowed(agent, run)
    const status = pageStatus(run.page.url, title)
    run.state = status.state
    run.reason = status.reason
    run.lastTitle = title
    const viewport = await this.withTimeout(run.page.viewport())
    const elements = await this.withTimeout(run.page.interactiveElements())
    const attachment = await this.options.saveImage({
      data,
      mediaType: 'image/png',
      name: 'mindseye-gui-snapshot.png',
    })
    const snapshotId = `snapshot-${randomUUID()}`
    run.snapshotId = snapshotId
    run.snapshotViewport = viewport
    return {
      runId: run.runId,
      snapshotId,
      url: run.page.url,
      title,
      ...status,
      control: run.control,
      viewport,
      elements,
      attachment,
    }
  }

  async click(agent: unknown, snapshotId: string, target: GuiTarget): Promise<GuiActionResult> {
    return this.action(agent, snapshotId, 'click', async (run) => {
      await run.page.click(target)
    }, target)
  }

  async type(agent: unknown, snapshotId: string, target: GuiInputTarget | undefined, text: string): Promise<GuiActionResult> {
    return this.action(agent, snapshotId, 'type', async (run) => {
      await run.page.type(target, text)
    })
  }

  async keypress(agent: unknown, snapshotId: string, key: GuiKey): Promise<GuiActionResult> {
    return this.action(agent, snapshotId, 'keypress', async (run) => {
      await run.page.keypress(key)
    })
  }

  async scroll(agent: unknown, snapshotId: string, deltaX: number, deltaY: number): Promise<GuiActionResult> {
    return this.action(agent, snapshotId, 'scroll', async (run) => {
      await run.page.scroll(deltaX, deltaY)
    })
  }

  async wait(agent: unknown, milliseconds: number): Promise<GuiActionResult> {
    const run = this.runOf(agent)
    this.assertMilliseconds(milliseconds)
    this.assertStepBudget(run)
    await this.ensurePageAllowed(agent, run)
    run.snapshotId = undefined
    run.steps += 1
    try {
      await this.withTimeout(run.page.wait(milliseconds))
    } finally {
      await this.ensurePageAllowed(agent, run)
    }
    return {
      runId: run.runId,
      action: 'wait',
      completed: true,
      nextStep: 'snapshot-required',
    }
  }

  async close(agent: unknown): Promise<void> {
    const run = this.runs.get(agent)
    if (run === undefined) return
    await this.closeRun(agent, run)
  }

  async closeAll(): Promise<void> {
    const agents = [...this.runs.keys()]
    await Promise.all(agents.map((agent) => this.close(agent)))
  }

  async takeover(runId: string): Promise<GuiHandoffResult> {
    const run = this.runById(runId)
    await this.ensurePageAllowedByRun(run)
    await this.withTimeout(run.page.focus())
    run.control = 'user'
    run.snapshotId = undefined
    run.snapshotViewport = undefined
    return this.handoffResult(run, 'takeover')
  }

  async resume(runId: string): Promise<GuiHandoffResult> {
    const run = this.runById(runId)
    await this.ensurePageAllowedByRun(run)
    await this.withTimeout(run.page.focus())
    await this.refreshPageStatus(run)
    run.snapshotId = undefined
    run.snapshotViewport = undefined
    if (run.state === 'ready') run.control = 'model'
    return this.handoffResult(run, 'resume')
  }

  private async action(
    agent: unknown,
    snapshotId: string,
    action: GuiActionResult['action'],
    execute: (run: GuiRun) => Promise<void>,
    target?: GuiTarget,
  ): Promise<GuiActionResult> {
    const run = this.runOf(agent)
    this.assertSnapshot(run, snapshotId)
    this.assertStepBudget(run)
    await this.ensurePageAllowed(agent, run)
    await this.refreshPageStatus(run)
    this.assertActionable(run)
    if (action === 'click' && target !== undefined) this.assertPointInSnapshot(run, target)
    run.snapshotId = undefined
    run.snapshotViewport = undefined
    run.steps += 1
    try {
      await this.withTimeout(execute(run))
    } finally {
      await this.ensurePageAllowed(agent, run)
    }
    return { runId: run.runId, action, completed: true, nextStep: 'snapshot-required' }
  }

  private async ensurePageAllowed(agent: unknown, run: GuiRun): Promise<void> {
    try {
      this.assertAllowedUrl(run.page.url)
    } catch (error) {
      await this.closeRun(agent, run).catch(() => undefined)
      throw error
    }
  }

  private async refreshPageStatus(run: GuiRun): Promise<void> {
    const title = await this.withTimeout(run.page.title())
    run.lastTitle = title
    const status = pageStatus(run.page.url, title)
    run.state = status.state
    run.reason = status.reason
  }

  private assertActionable(run: GuiRun): void {
    if (run.control === 'user') {
      throw new Error('mindseye_gui: browser is under user control; wait for the user to continue')
    }
    if (run.state === 'blocked') {
      throw new Error('mindseye_gui: page requires security verification; stop and ask the user to handle it')
    }
  }

  private assertPointInSnapshot(run: GuiRun, target: GuiTarget): void {
    if (target.kind !== 'point') return
    const viewport = run.snapshotViewport
    if (viewport === undefined) throw new Error('mindseye_gui: snapshot viewport is unavailable')
    const values = target.value.split(',').map((value) => Number(value.trim()))
    if (values.length !== 2 || values.some((value) => !Number.isFinite(value))) {
      throw new Error('mindseye_gui_click: point must be x,y')
    }
    const x = values[0] as number
    const y = values[1] as number
    if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
      throw new Error(`mindseye_gui_click: point ${target.value} is outside viewport ${viewport.width}x${viewport.height}`)
    }
  }

  private async closeRun(agent: unknown, run: GuiRun): Promise<void> {
    if (run.closed === true) return
    run.closed = true
    if (this.runs.get(agent) === run) this.runs.delete(agent)
    if (this.runsById.get(run.runId) === run) this.runsById.delete(run.runId)
    await run.page.close()
  }

  private runOf(agent: unknown): GuiRun {
    this.assertAgent(agent)
    const run = this.runs.get(agent)
    if (run === undefined) throw new Error('mindseye_gui: no active browser run')
    return run
  }

  private runById(runId: string): GuiRun {
    if (runId === '') throw new Error('mindseye_gui: runId is required')
    const run = this.runsById.get(runId)
    if (run === undefined || run.closed === true) throw new Error('mindseye_gui: no active browser run')
    return run
  }

  private async ensurePageAllowedByRun(run: GuiRun): Promise<void> {
    try {
      this.assertAllowedUrl(run.page.url)
    } catch (error) {
      await this.closeRunByRun(run).catch(() => undefined)
      throw error
    }
  }

  private async closeRunByRun(run: GuiRun): Promise<void> {
    if (run.closed === true) return
    run.closed = true
    for (const [agent, candidate] of this.runs) {
      if (candidate === run) this.runs.delete(agent)
    }
    if (this.runsById.get(run.runId) === run) this.runsById.delete(run.runId)
    await run.page.close()
  }

  private handoffResult(run: GuiRun, action: GuiHandoffResult['action']): GuiHandoffResult {
    return {
      runId: run.runId,
      url: run.page.url,
      title: run.lastTitle ?? '',
      state: run.state,
      control: run.control,
      action,
      ...(run.reason === undefined ? {} : { reason: run.reason }),
    }
  }

  private assertAgent(agent: unknown): void {
    if (agent === undefined || agent === null) throw new Error('mindseye_gui: agent session is required')
  }

  private assertSnapshot(run: GuiRun, snapshotId: string): void {
    if (run.snapshotId === undefined || run.snapshotId !== snapshotId) {
      throw new Error('mindseye_gui: snapshot is stale; call gui_snapshot first')
    }
  }

  private assertStepBudget(run: GuiRun): void {
    if (!Number.isInteger(this.options.maxSteps) || this.options.maxSteps < 1) {
      throw new Error('mindseye_gui: invalid step limit')
    }
    if (run.steps >= this.options.maxSteps) throw new Error('mindseye_gui: step limit reached')
  }

  private assertMilliseconds(milliseconds: number): void {
    if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > this.options.timeoutMs) {
      throw new Error(`mindseye_gui_wait: milliseconds must be between 0 and ${this.options.timeoutMs}`)
    }
  }

  private assertAllowedUrl(value: string): void {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error('mindseye_gui_open: invalid URL')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('mindseye_gui_open: only http and https URLs are allowed')
    }
    if (!this.options.restrictHosts) return
    const allowed = this.options.allowedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean)
    if (!allowed.includes(url.hostname.toLowerCase())) {
      throw new Error(`mindseye_gui_open: host ${url.hostname} is not allowlisted`)
    }
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        reject(new Error('mindseye_gui: operation timed out'))
      }, this.options.timeoutMs)
      promise.then(
        (value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }
}

export async function createPuppeteerBrowser(options: {
  executablePath?: string
  browser?: GuiBrowserChoice
  headless?: boolean
} = {}): Promise<GuiBrowser> {
  const puppeteer = await import('puppeteer-core')
  const executablePath = options.executablePath ?? await findBrowserExecutable(options.browser ?? 'auto')
  if (executablePath === undefined) {
    throw new Error('mindseye_gui_open: Chrome, Chromium, or Edge was not found')
  }
  const headless = options.headless ?? true
  const isEdge = /(?:^|[\\/])msedge\.exe$/i.test(executablePath)
  return {
    open: async (url, openOptions) => {
      const browser = await puppeteer.default.launch({
        executablePath,
        headless,
        defaultViewport: null,
        args: [
          '--disable-gpu',
          '--incognito',
          ...(isEdge ? ['--edge-skip-compat-layer-relaunch'] : []),
        ],
      })
      try {
        const page = await browser.newPage()
        await page.setDefaultTimeout(openOptions.timeoutMs)
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: openOptions.timeoutMs })
        const initialPages = typeof browser.pages === 'function' ? await browser.pages() : [page]
        return new PuppeteerPage(page, browser, initialPages)
      } catch (error) {
        await browser.close()
        throw error
      }
    },
  }
}

class PuppeteerPage implements GuiPage {
  private readonly knownPages = new Set<any>()

  constructor(
    private page: any,
    private readonly browser: {
      close(): Promise<void>
      pages?: () => Promise<any[]>
    },
    initialPages: any[],
  ) {
    initialPages.forEach((page) => this.knownPages.add(page))
    this.knownPages.add(page)
  }

  get url(): string { return this.page.url() }

  async title(): Promise<string> {
    await this.syncActivePage()
    return await this.page.title() as string
  }

  async focus(): Promise<void> {
    await this.syncActivePage()
    await this.page.bringToFront?.()
  }

  async screenshot(): Promise<Uint8Array> {
    await this.syncActivePage()
    return await this.page.screenshot({ type: 'png' }) as Uint8Array
  }

  async viewport(): Promise<GuiViewport> {
    await this.syncActivePage()
    const viewport = this.page.viewport() as { width?: number; height?: number } | null
    if (viewport?.width !== undefined && viewport.height !== undefined) {
      return { width: viewport.width, height: viewport.height }
    }
    return await this.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })) as GuiViewport
  }

  async interactiveElements(): Promise<GuiElementRef[]> {
    await this.syncActivePage()
    const candidates = await this.page.evaluate(() => {
      const selector = 'a,button,input,textarea,select,[role="button"],[role="textbox"],[contenteditable="true"]'
      return [...document.querySelectorAll(selector)]
        .map((element) => {
          const rect = element.getBoundingClientRect()
          const style = window.getComputedStyle(element)
          if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') return undefined
          const tag = element.tagName.toLowerCase()
          const kind = tag === 'a'
            ? 'link'
            : tag === 'button' || element.getAttribute('role') === 'button'
              ? 'button'
              : tag === 'textarea'
                ? 'textarea'
                : tag === 'select'
                  ? 'select'
                  : tag === 'input' || element.getAttribute('role') === 'textbox'
                    ? 'input'
                    : 'editable'
          const label = element.getAttribute('aria-label')
            ?? element.getAttribute('placeholder')
            ?? element.getAttribute('title')
            ?? element.textContent?.trim()
            ?? ''
          const value = 'value' in element && typeof element.value === 'string' ? element.value : undefined
          return {
            kind,
            label: label.slice(0, 160),
            ...(value === undefined ? {} : { value: value.slice(0, 160) }),
            box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          }
        })
        .filter((element): element is Omit<GuiElementRef, 'elementId'> => element !== undefined)
        .slice(0, 80)
    }) as Array<Omit<GuiElementRef, 'elementId'>>
    const elementIds = candidates.map(() => `element-${randomUUID()}`)
    await this.page.evaluate((ids: string[]) => {
      const selector = 'a,button,input,textarea,select,[role="button"],[role="textbox"],[contenteditable="true"]'
      const visible = [...document.querySelectorAll(selector)].filter((element) => {
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }).slice(0, ids.length)
      visible.forEach((element, index) => element.setAttribute('data-mindseye-element-id', ids[index] as string))
    }, elementIds)
    return candidates.map((element, index) => ({ ...element, elementId: elementIds[index] as string }))
  }

  async click(target: GuiTarget): Promise<void> {
    if (target.kind === 'element') {
      await this.clickElement(target.value)
      return
    }
    if (target.kind === 'selector') {
      await this.page.click(target.value)
      await this.syncActivePage(750)
      return
    }
    const values = target.value.split(',')
    if (values.length !== 2) throw new Error('mindseye_gui_click: point must be x,y')
    const [x, y] = values.map(Number)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('mindseye_gui_click: point must be x,y')
    await this.page.mouse.click(x, y)
    await this.syncActivePage(750)
  }

  async type(target: GuiInputTarget | undefined, text: string): Promise<void> {
    if (target?.kind === 'element') await this.focusElement(target.value)
    else if (target?.kind === 'selector') await this.page.click(target.value)
    await this.page.keyboard.type(text)
    await this.syncActivePage(250)
  }

  async keypress(key: GuiKey): Promise<void> {
    await this.page.keyboard.press(key)
    await this.syncActivePage(750)
  }

  private async clickElement(elementId: string): Promise<void> {
    await this.page.evaluate((id: string) => {
      const element = [...document.querySelectorAll('[data-mindseye-element-id]')]
        .find((candidate) => candidate.getAttribute('data-mindseye-element-id') === id)
      if (!(element instanceof HTMLElement)) throw new Error('mindseye_gui: elementId is not present in the latest snapshot')
      element.click()
    }, elementId)
    await this.syncActivePage(750)
  }

  private async focusElement(elementId: string | undefined): Promise<void> {
    if (elementId === undefined || elementId === '') throw new Error('mindseye_gui_type: elementId is required')
    await this.page.evaluate((id: string) => {
      const element = [...document.querySelectorAll('[data-mindseye-element-id]')]
        .find((candidate) => candidate.getAttribute('data-mindseye-element-id') === id)
      if (!(element instanceof HTMLElement)) throw new Error('mindseye_gui: elementId is not present in the latest snapshot')
      element.focus()
    }, elementId)
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    if (![deltaX, deltaY].every(Number.isFinite)) throw new Error('mindseye_gui_scroll: deltas must be finite numbers')
    await this.page.evaluate((x: number, y: number) => window.scrollBy(x, y), deltaX, deltaY)
    await this.syncActivePage()
  }

  async wait(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
    await this.syncActivePage()
  }

  async close(): Promise<void> {
    await this.browser.close()
  }

  private async syncActivePage(waitMs = 0): Promise<void> {
    if (this.browser.pages === undefined) return
    const deadline = Date.now() + waitMs
    do {
      const pages = await this.browser.pages()
      const newPages = pages.filter((page) => !this.knownPages.has(page))
      pages.forEach((page) => this.knownPages.add(page))
      if (newPages.length > 0) {
        this.page = newPages[newPages.length - 1]
        await this.page.bringToFront?.()
        return
      }
      if (!pages.includes(this.page) && pages.length > 0) {
        this.page = pages[pages.length - 1]
        await this.page.bringToFront?.()
        return
      }
      if (Date.now() >= deadline) return
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    } while (true)
  }
}

const execFileAsync = promisify(execFile)

export function browserChoiceFromProgId(value: string): Exclude<GuiBrowserChoice, 'auto'> | undefined {
  if (/chromehtml/i.test(value)) return 'chrome'
  if (/msedgehtm/i.test(value)) return 'edge'
  return undefined
}

async function systemDefaultBrowser(): Promise<Exclude<GuiBrowserChoice, 'auto'> | undefined> {
  if (process.platform !== 'win32') return undefined
  try {
    const result = await execFileAsync('reg.exe', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
      '/v',
      'ProgId',
    ], { windowsHide: true })
    const match = result.stdout.match(/ProgId\s+REG_SZ\s+([^\s\r\n]+)/i)
    return match === null ? undefined : browserChoiceFromProgId(match[1] ?? '')
  } catch {
    return undefined
  }
}

function browserCandidates(kind: Exclude<GuiBrowserChoice, 'auto'>): string[] {
  if (kind === 'chrome') {
    return [
      process.env.CHROME_PATH,
      process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env.PROGRAMFILES === undefined ? undefined : join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env['PROGRAMFILES(X86)'] === undefined ? undefined : join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ].filter((value): value is string => value !== undefined && value !== '')
  }
  return [
    process.env.EDGE_PATH,
    process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.PROGRAMFILES === undefined ? undefined : join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['PROGRAMFILES(X86)'] === undefined ? undefined : join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter((value): value is string => value !== undefined && value !== '')
}

export async function findBrowserExecutable(choice: GuiBrowserChoice = 'auto'): Promise<string | undefined> {
  const override = process.env.PUPPETEER_EXECUTABLE_PATH
  const preferred = choice === 'auto' ? await systemDefaultBrowser() : choice
  const kinds: Array<Exclude<GuiBrowserChoice, 'auto'>> = preferred === undefined
    ? ['chrome', 'edge']
    : [preferred, preferred === 'chrome' ? 'edge' : 'chrome']
  const candidates = [override, ...kinds.flatMap((kind) => browserCandidates(kind))]
    .filter((value): value is string => value !== undefined && value !== '')
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue through the platform candidates.
    }
  }
  return undefined
}

function pageStatus(url: string, title: string): {
  state: 'ready' | 'blocked'
  reason?: 'security-verification'
} {
  const marker = `${url}\n${title}`.toLowerCase()
  if (/(wappass\.baidu\.com|captcha|tuxing_v2|安全验证|人机验证|security verification|verify you are human)/i.test(marker)) {
    return { state: 'blocked', reason: 'security-verification' }
  }
  return { state: 'ready' }
}
