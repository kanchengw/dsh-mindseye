import { describe, expect, it, vi } from 'vitest'
const puppeteerLaunch = vi.hoisted(() => vi.fn())
vi.mock('puppeteer-core', () => ({ default: { launch: puppeteerLaunch } }))

import {
  browserChoiceFromProgId,
  createPuppeteerBrowser,
  GuiSessionManager,
  type GuiBrowser,
  type GuiPage,
} from '../src/gui/browser.js'

function fakePage(): GuiPage & { actions: string[]; setTitle: (title: string) => void } {
  const actions: string[] = []
  let currentTitle = 'Fixture'
  return {
    actions,
    url: 'http://localhost:3000/',
    title: async () => currentTitle,
    setTitle: (title: string) => { currentTitle = title },
    focus: async () => { actions.push('focus') },
    screenshot: async () => new Uint8Array([1, 2, 3]),
    viewport: async () => ({ width: 800, height: 600 }),
    interactiveElements: async () => [{
      elementId: 'element-search',
      kind: 'input',
      label: 'Search',
      box: { x: 100, y: 100, width: 300, height: 40 },
    }],
    click: async (target) => { actions.push(`click:${target.kind}:${target.value}`) },
    type: async (target, text) => { actions.push(`type:${target?.kind}:${target?.value ?? ''}:${text}`) },
    keypress: async (key) => { actions.push(`keypress:${key}`) },
    scroll: async (deltaX, deltaY) => { actions.push(`scroll:${deltaX}:${deltaY}`) },
    wait: async (ms) => { actions.push(`wait:${ms}`) },
    close: async () => { actions.push('close') },
  }
}

function runtime(overrides: Partial<ConstructorParameters<typeof GuiSessionManager>[0]> = {}) {
  const page = fakePage()
  const browser: GuiBrowser = {
    open: vi.fn(async () => page),
  }
  const saveImage = vi.fn(async () => ({
    attachmentId: 'attachment:screenshot',
    mediaType: 'image/png',
    bytes: 3,
    name: 'mindseye-gui-snapshot.png',
  }))
  const manager = new GuiSessionManager({
    browser,
    saveImage,
    allowedHosts: ['localhost'],
    restrictHosts: true,
    maxSteps: 3,
    timeoutMs: 1000,
    ...overrides,
  })
  return { manager, page, browser, saveImage }
}

describe('GuiSessionManager', () => {
  it('recognizes supported Windows default browser ProgIds only', () => {
    expect(browserChoiceFromProgId('ChromeHTML')).toBe('chrome')
    expect(browserChoiceFromProgId('MSEdgeHTM')).toBe('edge')
    expect(browserChoiceFromProgId('FirefoxURL')).toBeUndefined()
  })

  it('opens only allowlisted URLs and creates an isolated run', async () => {
    const { manager, browser } = runtime()
    const opened = await manager.open('agent-a', 'http://localhost:3000/app')
    expect(opened.url).toBe('http://localhost:3000/')
    expect(opened.title).toBe('Fixture')
    expect(opened.runId).toMatch(/^gui-/)
    expect(browser.open).toHaveBeenCalledWith('http://localhost:3000/app', { timeoutMs: 1000 })
    await expect(manager.open('agent-a', 'https://example.com')).rejects.toThrow('not allowlisted')
  })

  it('allows any http or https host when host restriction is disabled', async () => {
    const { manager, browser } = runtime({ restrictHosts: false })

    const opened = await manager.open('agent-a', 'https://example.com')

    expect(opened.url).toBe('http://localhost:3000/')
    expect(browser.open).toHaveBeenCalledWith('https://example.com', { timeoutMs: 1000 })
  })

  it('rejects an initial redirect outside the allowlist and closes the page', async () => {
    const page = fakePage()
    Object.defineProperty(page, 'url', { value: 'https://outside.example/', configurable: true })
    const manager = new GuiSessionManager({
      browser: { open: vi.fn(async () => page) },
      saveImage: async () => ({ attachmentId: 'attachment:screenshot', mediaType: 'image/png' }),
      allowedHosts: ['localhost'],
      restrictHosts: true,
      maxSteps: 3,
      timeoutMs: 1000,
    })

    await expect(manager.open('agent-a', 'http://localhost:3000')).rejects.toThrow('not allowlisted')
    expect(page.actions).toContain('close')
  })

  it('keeps sessions isolated by agent and closes a replaced session', async () => {
    const firstPage = fakePage()
    const secondPage = fakePage()
    const browser: GuiBrowser = {
      open: vi.fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(secondPage)
        .mockResolvedValueOnce(fakePage()),
    }
    const manager = new GuiSessionManager({
      browser,
      saveImage: async () => ({ attachmentId: 'attachment:screenshot', mediaType: 'image/png' }),
      allowedHosts: ['localhost'],
      restrictHosts: true,
      maxSteps: 3,
      timeoutMs: 1000,
    })

    await manager.open('agent-a', 'http://localhost:3000')
    await manager.open('agent-b', 'http://localhost:3000')
    const firstSnapshot = await manager.snapshot('agent-a')
    const secondSnapshot = await manager.snapshot('agent-b')
    await manager.click('agent-a', firstSnapshot.snapshotId, { kind: 'point', value: '1,2' })
    await manager.click('agent-b', secondSnapshot.snapshotId, { kind: 'point', value: '3,4' })

    expect(firstPage.actions).toContain('click:point:1,2')
    expect(secondPage.actions).toContain('click:point:3,4')
    await manager.open('agent-a', 'http://localhost:3000')
    expect(firstPage.actions).toContain('close')
  })

  it('creates an attachment-backed snapshot token', async () => {
    const { manager, saveImage } = runtime()
    await manager.open('agent-a', 'http://localhost:3000')
    const snapshot = await manager.snapshot('agent-a')
    expect(snapshot.snapshotId).toMatch(/^snapshot-/)
    expect(snapshot.attachment).toMatchObject({ attachmentId: 'attachment:screenshot' })
    expect(snapshot.url).toBe('http://localhost:3000/')
    expect(snapshot.viewport).toEqual({ width: 800, height: 600 })
    expect(saveImage).toHaveBeenCalledWith(expect.objectContaining({
      data: new Uint8Array([1, 2, 3]),
      mediaType: 'image/png',
      name: 'mindseye-gui-snapshot.png',
    }))
  })

  it('reads the current page title for each snapshot', async () => {
    const { manager, page } = runtime()
    await manager.open('agent-a', 'http://localhost:3000')
    page.setTitle('After navigation')

    const snapshot = await manager.snapshot('agent-a')

    expect(snapshot.title).toBe('After navigation')
  })

  it('marks security verification pages as blocked and prevents actions', async () => {
    const { manager, page } = runtime()
    page.setTitle('百度安全验证')

    const opened = await manager.open('agent-a', 'http://localhost:3000')
    expect(opened.state).toBe('blocked')
    expect(opened.reason).toBe('security-verification')

    const snapshot = await manager.snapshot('agent-a')
    expect(snapshot.state).toBe('blocked')
    await expect(manager.click('agent-a', snapshot.snapshotId, { kind: 'point', value: '10,20' }))
      .rejects.toThrow('security verification')
    expect(page.actions).not.toContain('click:point:10,20')
  })

  it('hands a blocked run to the user and blocks model actions until resumed', async () => {
    const { manager, page } = runtime()
    page.setTitle('百度安全验证')

    const opened = await manager.open('agent-a', 'http://localhost:3000')
    const takeover = await manager.takeover(opened.runId)

    expect(takeover).toMatchObject({ runId: opened.runId, state: 'blocked', control: 'user', action: 'takeover' })
    expect(page.actions).toContain('focus')
    const snapshot = await manager.snapshot('agent-a')
    expect(snapshot.control).toBe('user')
    await expect(manager.click('agent-a', snapshot.snapshotId, { kind: 'point', value: '10,20' }))
      .rejects.toThrow('under user control')
  })

  it('keeps user control when resume finds the page still blocked', async () => {
    const { manager, page } = runtime()
    page.setTitle('百度安全验证')

    const opened = await manager.open('agent-a', 'http://localhost:3000')
    await manager.takeover(opened.runId)
    const resumed = await manager.resume(opened.runId)

    expect(resumed).toMatchObject({ state: 'blocked', control: 'user', action: 'resume' })
  })

  it('returns model control after the user clears the blocked page', async () => {
    const { manager, page } = runtime()
    page.setTitle('百度安全验证')

    const opened = await manager.open('agent-a', 'http://localhost:3000')
    await manager.takeover(opened.runId)
    page.setTitle('Fixture')
    const resumed = await manager.resume(opened.runId)

    expect(resumed).toMatchObject({ state: 'ready', control: 'model', action: 'resume' })
    const snapshot = await manager.snapshot('agent-a')
    await manager.click('agent-a', snapshot.snapshotId, { kind: 'point', value: '10,20' })
    expect(page.actions).toContain('click:point:10,20')
  })

  it('removes a run id when the browser session closes', async () => {
    const { manager } = runtime()
    const opened = await manager.open('agent-a', 'http://localhost:3000')

    await manager.close('agent-a')

    await expect(manager.takeover(opened.runId)).rejects.toThrow('no active browser run')
  })

  it('requires a fresh snapshot and invalidates it after an action', async () => {
    const { manager, page } = runtime()
    await manager.open('agent-a', 'http://localhost:3000')
    const snapshot = await manager.snapshot('agent-a')
    await manager.click('agent-a', snapshot.snapshotId, { kind: 'selector', value: '#save' })
    expect(page.actions).toContain('click:selector:#save')
    await expect(manager.click('agent-a', snapshot.snapshotId, { kind: 'selector', value: '#save' }))
      .rejects.toThrow('snapshot is stale')
  })

  it('invalidates the snapshot when an action fails', async () => {
    const { manager, page } = runtime()
    page.click = async () => { throw new Error('click failed') }
    await manager.open('agent-a', 'http://localhost:3000')
    const snapshot = await manager.snapshot('agent-a')

    await expect(manager.click('agent-a', snapshot.snapshotId, { kind: 'point', value: '1,2' }))
      .rejects.toThrow('click failed')
    await expect(manager.click('agent-a', snapshot.snapshotId, { kind: 'point', value: '1,2' }))
      .rejects.toThrow('snapshot is stale')
  })

  it('supports type and scroll and enforces the step limit', async () => {
    const { manager, page } = runtime({ maxSteps: 2 })
    await manager.open('agent-a', 'http://localhost:3000')
    let snapshot = await manager.snapshot('agent-a')
    await manager.type('agent-a', snapshot.snapshotId, { kind: 'selector', value: '#name' }, 'hello')
    snapshot = await manager.snapshot('agent-a')
    await manager.scroll('agent-a', snapshot.snapshotId, 0, 600)
    snapshot = await manager.snapshot('agent-a')
    await expect(manager.click('agent-a', snapshot.snapshotId, { kind: 'point', value: '10,20' }))
      .rejects.toThrow('step limit')
    expect(page.actions).toEqual(['type:selector:#name:hello', 'scroll:0:600'])
  })

  it('types into the current focus when selector is omitted', async () => {
    const { manager, page } = runtime()
    await manager.open('agent-a', 'http://localhost:3000')
    const snapshot = await manager.snapshot('agent-a')

    await manager.type('agent-a', snapshot.snapshotId, undefined, 'hello')

    expect(page.actions).toContain('type:undefined::hello')
  })

  it('uses a snapshot element id without site-specific selectors', async () => {
    const { manager, page } = runtime()
    await manager.open('agent-a', 'http://localhost:3000')
    const snapshot = await manager.snapshot('agent-a')

    await manager.click('agent-a', snapshot.snapshotId, { kind: 'element', value: 'element-search' })
    const next = await manager.snapshot('agent-a')
    await manager.type('agent-a', next.snapshotId, { kind: 'element', value: 'element-search' }, 'hello')
    const final = await manager.snapshot('agent-a')
    await manager.keypress('agent-a', final.snapshotId, 'Enter')

    expect(page.actions).toContain('click:element:element-search')
    expect(page.actions).toContain('type:element:element-search:hello')
    expect(page.actions).toContain('keypress:Enter')
  })

  it('rejects point clicks outside the latest snapshot viewport', async () => {
    const { manager, page } = runtime()
    await manager.open('agent-a', 'http://localhost:3000')
    const snapshot = await manager.snapshot('agent-a')

    await expect(manager.click('agent-a', snapshot.snapshotId, { kind: 'point', value: '800,600' }))
      .rejects.toThrow('outside viewport 800x600')
    expect(page.actions).not.toContain('click:point:800,600')
  })

  it('waits and invalidates the current snapshot', async () => {
    const { manager, page } = runtime()
    await manager.open('agent-a', 'http://localhost:3000')
    const snapshot = await manager.snapshot('agent-a')
    await manager.wait('agent-a', 250)
    expect(page.actions).toContain('wait:250')
    await expect(manager.click('agent-a', snapshot.snapshotId, { kind: 'point', value: '1,2' }))
      .rejects.toThrow('snapshot is stale')
  })

  it('invalidates the snapshot when waiting fails', async () => {
    const { manager, page } = runtime()
    page.wait = async () => { throw new Error('wait failed') }
    await manager.open('agent-a', 'http://localhost:3000')
    const snapshot = await manager.snapshot('agent-a')

    await expect(manager.wait('agent-a', 250)).rejects.toThrow('wait failed')
    await expect(manager.click('agent-a', snapshot.snapshotId, { kind: 'point', value: '1,2' }))
      .rejects.toThrow('snapshot is stale')
  })

  it('rejects invalid wait durations before touching the page', async () => {
    const { manager, page } = runtime({ timeoutMs: 100 })
    await manager.open('agent-a', 'http://localhost:3000')

    await expect(manager.wait('agent-a', -1)).rejects.toThrow('between 0 and 100')
    await expect(manager.wait('agent-a', 101)).rejects.toThrow('between 0 and 100')
    expect(page.actions).toEqual([])
  })

  it('closes a run when an action navigates away from the allowlist', async () => {
    const page = fakePage()
    let currentUrl = page.url
    Object.defineProperty(page, 'url', { get: () => currentUrl })
    page.click = async () => { currentUrl = 'https://outside.example/' }
    const manager = new GuiSessionManager({
      browser: { open: vi.fn(async () => page) },
      saveImage: async () => ({ attachmentId: 'attachment:screenshot', mediaType: 'image/png' }),
      allowedHosts: ['localhost'],
      restrictHosts: true,
      maxSteps: 3,
      timeoutMs: 1000,
    })
    await manager.open('agent-a', 'http://localhost:3000')
    const snapshot = await manager.snapshot('agent-a')

    await expect(manager.click('agent-a', snapshot.snapshotId, { kind: 'point', value: '1,2' }))
      .rejects.toThrow('not allowlisted')
    await expect(manager.snapshot('agent-a')).rejects.toThrow('no active browser run')
    expect(page.actions).toContain('close')
  })

  it('checks the allowlist again before executing an action', async () => {
    const page = fakePage()
    let currentUrl = page.url
    Object.defineProperty(page, 'url', { get: () => currentUrl })
    const manager = new GuiSessionManager({
      browser: { open: vi.fn(async () => page) },
      saveImage: async () => ({ attachmentId: 'attachment:screenshot', mediaType: 'image/png' }),
      allowedHosts: ['localhost'],
      restrictHosts: true,
      maxSteps: 3,
      timeoutMs: 1000,
    })
    await manager.open('agent-a', 'http://localhost:3000')
    const snapshot = await manager.snapshot('agent-a')
    currentUrl = 'https://outside.example/'

    await expect(manager.click('agent-a', snapshot.snapshotId, { kind: 'point', value: '1,2' }))
      .rejects.toThrow('not allowlisted')
    expect(page.actions).not.toContain('click:point:1,2')
  })

  it('fails when a page operation exceeds the configured timeout', async () => {
    const { manager, page } = runtime({ timeoutMs: 10 })
    page.wait = async () => await new Promise<void>(() => undefined)
    await manager.open('agent-a', 'http://localhost:3000')
    await expect(manager.wait('agent-a', 10)).rejects.toThrow('operation timed out')
  })

  it('closes every active agent session with closeAll', async () => {
    const firstPage = fakePage()
    const secondPage = fakePage()
    const manager = new GuiSessionManager({
      browser: {
        open: vi.fn()
          .mockResolvedValueOnce(firstPage)
          .mockResolvedValueOnce(secondPage),
      },
      saveImage: async () => ({ attachmentId: 'attachment:screenshot', mediaType: 'image/png' }),
      allowedHosts: ['localhost'],
      restrictHosts: true,
      maxSteps: 3,
      timeoutMs: 1000,
    })
    await manager.open('agent-a', 'http://localhost:3000')
    await manager.open('agent-b', 'http://localhost:3000')

    await manager.closeAll()

    expect(firstPage.actions).toContain('close')
    expect(secondPage.actions).toContain('close')
    await expect(manager.snapshot('agent-a')).rejects.toThrow('no active browser run')
    await expect(manager.snapshot('agent-b')).rejects.toThrow('no active browser run')
  })

  it('does not let an old in-flight action close a replacement session', async () => {
    const oldPage = fakePage()
    const newPage = fakePage()
    let currentUrl = oldPage.url
    let releaseClick!: () => void
    let clickStarted!: () => void
    const clickReleased = new Promise<void>((resolve) => { releaseClick = resolve })
    const clickStartedPromise = new Promise<void>((resolve) => { clickStarted = resolve })
    Object.defineProperty(oldPage, 'url', { get: () => currentUrl })
    oldPage.click = async () => {
      clickStarted()
      await clickReleased
      currentUrl = 'https://outside.example/'
    }
    const manager = new GuiSessionManager({
      browser: {
        open: vi.fn()
          .mockResolvedValueOnce(oldPage)
          .mockResolvedValueOnce(newPage),
      },
      saveImage: async () => ({ attachmentId: 'attachment:screenshot', mediaType: 'image/png' }),
      allowedHosts: ['localhost'],
      restrictHosts: true,
      maxSteps: 3,
      timeoutMs: 1000,
    })
    await manager.open('agent-a', 'http://localhost:3000')
    const oldSnapshot = await manager.snapshot('agent-a')
    const oldAction = manager.click('agent-a', oldSnapshot.snapshotId, { kind: 'point', value: '1,2' })
    await clickStartedPromise

    await manager.open('agent-a', 'http://localhost:3000')
    releaseClick()
    await expect(oldAction).rejects.toThrow('not allowlisted')

    await expect(manager.snapshot('agent-a')).resolves.toMatchObject({ title: 'Fixture' })
    expect(newPage.actions).not.toContain('close')
  })
})

describe('Puppeteer browser adapter', () => {
  it('resolves the browser page title before exposing it to GUI tools', async () => {
    const page = {
      setDefaultTimeout: vi.fn(),
      goto: vi.fn(),
      title: vi.fn(async () => 'Resolved title'),
      url: vi.fn(() => 'http://localhost:3000/'),
      mouse: { click: vi.fn() },
    }
    const browser = {
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => undefined),
    }
    puppeteerLaunch.mockResolvedValueOnce(browser)

    const adapter = await createPuppeteerBrowser({ executablePath: 'chrome-test' })
    const opened = await adapter.open('http://localhost:3000', { timeoutMs: 1000 })

    expect(await opened.title()).toBe('Resolved title')
    expect(page.title).toHaveBeenCalledOnce()
    await expect(opened.click({ kind: 'point', value: '1,2,3' })).rejects.toThrow('point must be x,y')
    expect(page.mouse.click).not.toHaveBeenCalled()
    expect(puppeteerLaunch).toHaveBeenCalledWith(expect.objectContaining({
      defaultViewport: null,
      args: ['--disable-gpu', '--incognito'],
    }))
  })

  it('prevents Edge compatibility-layer relaunch during headful startup', async () => {
    const page = {
      setDefaultTimeout: vi.fn(),
      goto: vi.fn(),
      title: vi.fn(async () => 'Resolved title'),
      url: vi.fn(() => 'http://localhost:3000/'),
    }
    const browser = {
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => undefined),
    }
    puppeteerLaunch.mockResolvedValueOnce(browser)

    const adapter = await createPuppeteerBrowser({
      executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      headless: false,
    })
    await adapter.open('http://localhost:3000', { timeoutMs: 1000 })

    expect(puppeteerLaunch).toHaveBeenCalledWith(expect.objectContaining({
      headless: false,
      defaultViewport: null,
      args: ['--disable-gpu', '--incognito', '--edge-skip-compat-layer-relaunch'],
    }))
  })

  it('switches to a newly opened tab after a click', async () => {
    const page = {
      setDefaultTimeout: vi.fn(),
      goto: vi.fn(),
      title: vi.fn(async () => 'Search results'),
      url: vi.fn(() => 'https://example.com/search'),
      click: vi.fn(async () => undefined),
    }
    const popup = {
      title: vi.fn(async () => 'News article'),
      url: vi.fn(() => 'https://news.example.com/article'),
      bringToFront: vi.fn(async () => undefined),
    }
    const initialBlank = {}
    const browser = {
      newPage: vi.fn(async () => page),
      pages: vi.fn()
        .mockResolvedValueOnce([initialBlank, page])
        .mockResolvedValue([initialBlank, page, popup]),
      close: vi.fn(async () => undefined),
    }
    puppeteerLaunch.mockResolvedValueOnce(browser)

    const adapter = await createPuppeteerBrowser({ executablePath: 'chrome-test' })
    const opened = await adapter.open('https://example.com/search', { timeoutMs: 1000 })
    await opened.click({ kind: 'selector', value: 'a[target=_blank]' })

    expect(await opened.title()).toBe('News article')
    expect(opened.url).toBe('https://news.example.com/article')
    expect(popup.bringToFront).toHaveBeenCalledOnce()
  })

  it('exposes generic interactive element ids and keyboard actions', async () => {
    const page = {
      setDefaultTimeout: vi.fn(),
      goto: vi.fn(),
      title: vi.fn(async () => 'Resolved title'),
      url: vi.fn(() => 'http://localhost:3000/'),
      viewport: vi.fn(() => ({ width: 800, height: 600 })),
      screenshot: vi.fn(async () => new Uint8Array([1])),
      keyboard: { type: vi.fn(), press: vi.fn() },
      mouse: { click: vi.fn() },
      evaluate: vi.fn()
        .mockResolvedValueOnce([{
          kind: 'input',
          label: 'Search',
          box: { x: 12, y: 20, width: 200, height: 32 },
        }])
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined),
    }
    const browser = {
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => undefined),
    }
    puppeteerLaunch.mockResolvedValueOnce(browser)

    const adapter = await createPuppeteerBrowser({ executablePath: 'chrome-test' })
    const opened = await adapter.open('http://localhost:3000', { timeoutMs: 1000 })
    const elements = await opened.interactiveElements()
    await opened.click({ kind: 'element', value: elements[0]!.elementId })
    await opened.type({ kind: 'element', value: elements[0]!.elementId }, 'ox alpha')
    await opened.keypress('Enter')

    expect(elements[0]).toMatchObject({ kind: 'input', label: 'Search', box: { x: 12, y: 20 } })
    expect(page.keyboard.type).toHaveBeenCalledWith('ox alpha')
    expect(page.keyboard.press).toHaveBeenCalledWith('Enter')
  })
})
