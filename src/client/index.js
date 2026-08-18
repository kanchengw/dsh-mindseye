import React, { useCallback, useEffect, useState } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  OVERRIDE_KINDS,
  OVERRIDE_LABELS,
  decodeSettings,
  emptyImageRoute,
  emptyRoute,
  encodeSettings,
  imageRouteIsComplete,
  optionalImageRouteValidationError,
  optionalRouteValidationError,
  routeIsComplete,
  routeValidationError,
  updateRoute,
} from './settings.js'
import { CSS, STYLE_ID } from './styles.js'

const CONFIG_ROUTE = '/_dsh/mindseye/config'
const PASTE_ROUTE = '/_dsh/mindseye/paste'
const PASTE_VERDICT_TTL_MS = 60000

const MAX_TOKEN_VALUES = [512, 1024, 2048, 4096, 8192, 16384]

let pasteRouteAvailable = true
const pasteVerdicts = {}

function pasteImageFiles(event) {
  const items = event.clipboardData?.items
  if (!items) return []
  const files = []
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file && /^image\//.test(file.type)) files.push(file)
  }
  return files
}

function currentModelLabel() {
  const buttons = document.querySelectorAll('button[aria-label]')
  for (const button of buttons) {
    const label = button.getAttribute('aria-label') || ''
    if (/选择模型|select model|current model/i.test(label)) return label
  }
  return ''
}

function insertText(target, text) {
  const el = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')
    ? target
    : document.activeElement
  if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) return
  el.focus()
  let inserted = false
  try {
    inserted = document.execCommand('insertText', false, text)
  } catch {
    inserted = false
  }
  if (!inserted) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, el.value + text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

function refreshPasteVerdict(label) {
  if (!pasteRouteAvailable || label === '') return
  const cached = pasteVerdicts[label]
  if (cached !== undefined && Date.now() - cached.at < PASTE_VERDICT_TTL_MS) return
  const entry = {
    pending: true,
    takeover: cached ? cached.takeover : false,
    at: cached ? cached.at : 0,
  }
  pasteVerdicts[label] = entry
  fetch(`${PASTE_ROUTE}?model=${encodeURIComponent(label)}`)
    .then((res) => {
      if (res.status === 404) {
        pasteRouteAvailable = false
        entry.pending = false
        return null
      }
      if (!res.ok) throw new Error(`paste verdict ${res.status}`)
      return res.json()
    })
    .then((body) => {
      entry.pending = false
      if (body && body.ok === true && body.value !== undefined) {
        entry.takeover = body.value.takeover === true
        entry.at = Date.now()
      }
    })
    .catch(() => {
      entry.pending = false
    })
}

function onFocusCapture() {
  refreshPasteVerdict(currentModelLabel())
}

function onPasteCapture(event) {
  if (!pasteRouteAvailable) return
  const files = pasteImageFiles(event)
  if (files.length === 0) return
  const label = currentModelLabel()
  const cached = pasteVerdicts[label]
  refreshPasteVerdict(label)
  if (
    cached === undefined
    || cached.at === 0
    || cached.takeover !== true
    || Date.now() - cached.at > PASTE_VERDICT_TTL_MS
  ) {
    return
  }
  event.preventDefault()
  event.stopImmediatePropagation()
  const target = event.target
  Promise.all(files.map((file) =>
    file.arrayBuffer().then((buffer) =>
      fetch(PASTE_ROUTE, { method: 'POST', body: buffer }).then((res) => {
        if (!res.ok) {
          return res.json().catch(() => ({})).then((body) => {
            const error = new Error(body?.error?.message || `paste upload failed (${res.status})`)
            error.status = res.status
            throw error
          })
        }
        return res.json()
      }))))
    .then((results) => {
      const text = results.map((result) => result?.value?.path).filter(Boolean).join(' ')
      if (text) insertText(target, `${text} `)
    })
    .catch((error) => {
      if (error && error.status === 404) pasteRouteAvailable = false
      console.error(`[mindseye] paste-to-path failed: ${error && error.message ? error.message : error}`)
    })
}

function maxTokenOptions(current) {
  const options = [{ value: '', label: '不限制（服务端决定）' }]
  const currentNumber = current === '' ? Number.NaN : Number(current)
  const values = Number.isInteger(currentNumber) && currentNumber > 0 && !MAX_TOKEN_VALUES.includes(currentNumber)
    ? [currentNumber, ...MAX_TOKEN_VALUES]
    : MAX_TOKEN_VALUES
  return options.concat(values.map((value) => ({ value: String(value), label: String(value) })))
}

function installStyle(ctx) {
  ctx.effect(() => {
    const existing = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)
    if (existing !== null) return () => undefined
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-mindseye'
    style.dataset.pluginCss = STYLE_ID
    style.textContent = CSS
    document.head.append(style)
    return () => { style.remove() }
  }, 'dsh-mindseye: settings styles')
}

function Field(props) {
  const { label, hint, children } = props
  return React.createElement('div', { className: 'mindseye-field' }, [
    React.createElement('span', { key: 'label' }, label),
    children,
    hint === undefined
      ? null
      : React.createElement('small', { key: 'hint' }, hint),
  ])
}

function TextInput(props) {
  const { value, onChange, placeholder, disabled, type = 'text', ariaLabel } = props
  return React.createElement('input', {
    type,
    value,
    placeholder,
    disabled,
    spellCheck: false,
    'aria-label': ariaLabel,
    onChange: (event) => onChange(event.target.value),
  })
}

function SelectInput(props) {
  const { value, onChange, disabled, ariaLabel, options } = props
  return React.createElement('select', {
    value,
    disabled,
    'data-empty': value === '' ? 'true' : undefined,
    'aria-label': ariaLabel,
    onChange: (event) => onChange(event.target.value),
  }, options.map((option) =>
    React.createElement('option', {
      key: option.value,
      value: option.value,
      disabled: option.disabled === true,
    }, option.label),
  ))
}

function EyeIcon({ open }) {
  return React.createElement('svg', {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }, open
    ? [
      React.createElement('path', {
        key: 'eye',
        d: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z',
      }),
      React.createElement('circle', { key: 'pupil', cx: 12, cy: 12, r: 3 }),
    ]
    : [
      React.createElement('path', {
        key: 'eye',
        d: 'M9.88 9.88a3 3 0 1 0 4.24 4.24',
      }),
      React.createElement('path', {
        key: 'orbit',
        d: 'M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68',
      }),
      React.createElement('path', {
        key: 'lid',
        d: 'M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61',
      }),
      React.createElement('line', { key: 'slash', x1: 2, y1: 2, x2: 22, y2: 22 }),
    ])
}

function PasswordInput(props) {
  const { value, onChange, placeholder, disabled, ariaLabel } = props
  const [visible, setVisible] = useState(false)
  const label = visible ? '隐藏 API Key' : '显示 API Key'
  return React.createElement('div', { className: 'mindseye-password' }, [
    React.createElement('input', {
      key: 'input',
      type: visible ? 'text' : 'password',
      value,
      placeholder,
      disabled,
      spellCheck: false,
      autoComplete: 'off',
      'aria-label': ariaLabel,
      onChange: (event) => onChange(event.target.value),
    }),
    React.createElement('button', {
      key: 'toggle',
      type: 'button',
      className: 'mindseye-password-toggle',
      disabled,
      'aria-label': label,
      title: label,
      onClick: () => setVisible((current) => !current),
    }, React.createElement(EyeIcon, { open: visible })),
  ])
}

function RouteFields(props) {
  const { value, onChange, disabled } = props
  const patch = (key) => (next) => onChange(updateRoute(value, { [key]: next }))
  return React.createElement('div', { className: 'mindseye-grid' }, [
    React.createElement(Field, {
      key: 'model',
      label: '模型 ID',
    }, React.createElement(TextInput, {
      value: value.model,
      onChange: patch('model'),
      disabled,
      placeholder: '例如 qwen3-vl-plus',
      ariaLabel: '模型 ID',
    })),
    React.createElement(Field, {
      key: 'baseUrl',
      label: 'Base URL',
    }, React.createElement(TextInput, {
      value: value.baseUrl,
      onChange: patch('baseUrl'),
      disabled,
      type: 'url',
      placeholder: 'https://...',
      ariaLabel: 'Base URL',
    })),
    React.createElement(Field, {
      key: 'apiKeyEnv',
      label: 'API Key',
    }, React.createElement(PasswordInput, {
      value: value.apiKeyEnv,
      onChange: patch('apiKeyEnv'),
      disabled,
      placeholder: 'sk-...',
      ariaLabel: 'API Key',
    })),
    React.createElement(Field, {
      key: 'protocol',
      label: '协议',
    }, React.createElement(SelectInput, {
      value: value.protocol,
      onChange: patch('protocol'),
      disabled,
      ariaLabel: '协议',
      options: [
        { value: 'chat-completions', label: 'Chat Completions' },
        { value: 'responses', label: 'Responses' },
      ],
    })),
    React.createElement(Field, {
      key: 'maxTokens',
      label: 'Max Tokens',
    }, React.createElement(SelectInput, {
      value: value.maxTokens,
      onChange: patch('maxTokens'),
      disabled,
      ariaLabel: 'Max Tokens',
      options: maxTokenOptions(value.maxTokens),
    })),
  ])
}

function ImageRouteFields(props) {
  const { value, onChange, disabled } = props
  const patch = (key) => (next) => onChange({ ...value, [key]: next })
  return React.createElement('div', { className: 'mindseye-grid' }, [
    React.createElement(Field, {
      key: 'model',
      label: '模型 ID',
    }, React.createElement(TextInput, {
      value: value.model,
      onChange: patch('model'),
      disabled,
      placeholder: '例如 doubao-seed-2-0-pro-260215',
      ariaLabel: '图片生成模型 ID',
    })),
    React.createElement(Field, {
      key: 'baseUrl',
      label: 'Base URL',
    }, React.createElement(TextInput, {
      value: value.baseUrl,
      onChange: patch('baseUrl'),
      disabled,
      type: 'url',
      placeholder: 'https://...',
      ariaLabel: '图片生成 Base URL',
    })),
    React.createElement(Field, {
      key: 'apiKeyEnv',
      label: 'API Key',
    }, React.createElement(PasswordInput, {
      value: value.apiKeyEnv,
      onChange: patch('apiKeyEnv'),
      disabled,
      placeholder: 'sk-...',
      ariaLabel: '图片生成 API Key',
    })),
  ])
}

function imageRouteHasValues(route) {
  return ['model', 'baseUrl', 'apiKeyEnv']
    .some((key) => typeof route?.[key] === 'string' && route[key].trim() !== '')
}

function SettingsCard() {
  const [open, setOpen] = useState(false)
  const [summary, setSummary] = useState(undefined)
  const [draft, setDraft] = useState(undefined)
  const [baseline, setBaseline] = useState(undefined)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState(undefined)
  const [addedOverrides, setAddedOverrides] = useState([])
  const [pendingAdd, setPendingAdd] = useState(OVERRIDE_KINDS[0])
  const [imageFallbackAdded, setImageFallbackAdded] = useState(false)

  const load = useCallback(async () => {
    if (loading) return
    setLoading(true)
    setError(undefined)
    setStatus('')
    try {
      const response = await fetch(CONFIG_ROUTE)
      const body = await response.json()
      if (!response.ok || !body.ok) {
        setError(body.error?.message ?? '读取配置失败')
        return
      }
      const next = decodeSettings(body.value.config)
      setSummary(body.value)
      setDraft(next)
      setBaseline(next)
      setAddedOverrides(OVERRIDE_KINDS.filter((kind) => routeIsComplete(next.overrides[kind])))
      setImageFallbackAdded(imageRouteHasValues(next.imageFallback))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [loading])

  useEffect(() => {
    if (open && summary === undefined && !loading) void load()
  }, [open, summary, loading, load])

  const dirty = draft !== undefined && baseline !== undefined
    && JSON.stringify(draft) !== JSON.stringify(baseline)
  const writable = summary?.writable !== false
  const defaultError = draft === undefined ? undefined : optionalRouteValidationError(draft.defaultRoute)
  const overrideErrors = {}
  if (draft !== undefined) {
    for (const kind of OVERRIDE_KINDS) {
      const routeError = optionalRouteValidationError(draft.overrides[kind])
      if (routeError !== undefined) overrideErrors[kind] = routeError
    }
  }
  const imagePrimaryError = draft === undefined ? undefined : optionalImageRouteValidationError(draft.imagePrimary)
  const imageFallbackError = draft === undefined || !imageFallbackAdded
    ? undefined
    : optionalImageRouteValidationError(draft.imageFallback)
  const hasValidRoute = draft !== undefined && (
    routeIsComplete(draft.defaultRoute) || imageRouteIsComplete(draft.imagePrimary)
  )
  const validationError = defaultError ?? Object.values(overrideErrors)[0] ?? imagePrimaryError ?? imageFallbackError

  const discard = () => {
    setDraft(baseline)
    setAddedOverrides(OVERRIDE_KINDS.filter((kind) => routeIsComplete(baseline.overrides[kind])))
    setImageFallbackAdded(imageRouteHasValues(baseline.imageFallback))
    setError(undefined)
    setStatus('')
  }

  const addOverride = (kind) => {
    setAddedOverrides((current) => current.includes(kind) ? current : [...current, kind])
    setPendingAdd(OVERRIDE_KINDS.find((item) => item !== kind) ?? OVERRIDE_KINDS[0])
    setStatus('')
    setError(undefined)
  }

  const removeOverride = (kind) => {
    setDraft((current) => current === undefined ? current : {
      ...current,
      overrides: { ...current.overrides, [kind]: emptyRoute() },
    })
    setAddedOverrides((current) => current.filter((item) => item !== kind))
    setStatus('')
    setError(undefined)
  }

  const addImageFallback = () => {
    setImageFallbackAdded(true)
    setStatus('')
    setError(undefined)
  }

  const removeImageFallback = () => {
    setDraft((current) => ({ ...current, imageFallback: emptyImageRoute() }))
    setImageFallbackAdded(false)
    setStatus('')
    setError(undefined)
  }

  const save = async () => {
    if (!dirty || saving || !writable || !hasValidRoute || validationError !== undefined) return
    setSaving(true)
    setError(undefined)
    setStatus('')
    try {
      const encoded = encodeSettings(draft)
      const response = await fetch(CONFIG_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(encoded),
      })
      const body = await response.json()
      if (!response.ok || !body.ok) {
        setError(body.error?.message ?? '保存失败')
        return
      }
      const next = decodeSettings(body.value.config)
      setSummary(body.value)
      setDraft(next)
      setBaseline(next)
      setAddedOverrides(OVERRIDE_KINDS.filter((kind) => routeIsComplete(next.overrides[kind])))
      setImageFallbackAdded(imageRouteHasValues(next.imageFallback))
      setStatus('已保存')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  const overrideSections = draft === undefined
    ? []
    : addedOverrides.map((kind) => {
      const route = draft.overrides[kind] ?? emptyRoute()
      const routeError = overrideErrors[kind]
      return React.createElement('section', { key: kind, className: 'mindseye-section' }, [
        React.createElement('div', { key: 'head', className: 'mindseye-override-head' }, [
          React.createElement('span', { key: 'title' }, OVERRIDE_LABELS[kind]),
          React.createElement('button', {
            key: 'remove',
            type: 'button',
            disabled: !writable,
            onClick: () => removeOverride(kind),
          }, '移除'),
        ]),
        React.createElement('div', { key: 'body', className: 'mindseye-override-body' }, [
          React.createElement('p', { key: 'hint', className: 'mindseye-section-hint' },
            '留空则使用默认视觉路由。'),
          React.createElement(RouteFields, {
            key: 'fields',
            value: route,
            disabled: !writable,
            onChange: (next) => {
              setDraft((current) => ({
                ...current,
                overrides: { ...current.overrides, [kind]: next },
              }))
              setStatus('')
              setError(undefined)
            },
          }),
          routeError === undefined
            ? null
            : React.createElement('p', { key: 'error', className: 'mindseye-error' }, routeError),
        ]),
      ])
    })

  let body = null
  if (open) {
    const availableOverrides = OVERRIDE_KINDS.filter((kind) => !addedOverrides.includes(kind))
    const addTarget = availableOverrides.includes(pendingAdd) ? pendingAdd : availableOverrides[0]
    if (loading || (summary === undefined && error === undefined)) {
      body = React.createElement('div', { key: 'loading', className: 'mindseye-section' },
        React.createElement('p', { className: 'mindseye-section-hint' }, '正在读取设置…'))
    } else if (summary === undefined) {
      body = React.createElement('div', { key: 'error', className: 'mindseye-section' },
        React.createElement('p', { className: 'mindseye-error' }, String(error ?? '配置不可用')))
    } else {
      body = React.createElement('div', { key: 'body', className: 'mindseye-body' }, [
        React.createElement('section', { key: 'takeover', className: 'mindseye-section' }, [
          React.createElement('div', { key: 'title', className: 'mindseye-section-title' }, '模型接管'),
          React.createElement('label', { key: 'toggle', className: 'mindseye-toggle' }, [
            React.createElement('input', {
              key: 'input',
              type: 'checkbox',
              checked: draft.takeover === true,
              disabled: !writable,
              onChange: (event) => {
                setDraft((current) => ({ ...current, takeover: event.target.checked }))
                setStatus('')
                setError(undefined)
              },
            }),
            React.createElement('span', { key: 'label' }, '接管 deepseek-official（显示图片，多模态原生模式）'),
          ]),
          React.createElement('p', { key: 'hint', className: 'mindseye-section-hint' },
            '默认开启；修改后需重启生效。启动失败会自动恢复官方适配器，并降级为路径粘贴。'),
        ]),
        React.createElement('section', { key: 'default', className: 'mindseye-section' }, [
          React.createElement('div', { key: 'title', className: 'mindseye-section-title' }, '通用理解模型'),
          React.createElement('p', { key: 'hint', className: 'mindseye-section-hint' },
            '视觉问答、布局、图表、颜色等语义理解任务都使用这个模型。'),
          React.createElement(RouteFields, {
            key: 'fields',
            value: draft.defaultRoute,
            disabled: !writable,
            onChange: (next) => {
              setDraft((current) => ({ ...current, defaultRoute: next }))
              setStatus('')
              setError(undefined)
            },
          }),
          defaultError === undefined
            ? null
            : React.createElement('p', { key: 'error', className: 'mindseye-error' }, defaultError),
        ]),
        ...overrideSections,
        availableOverrides.length === 0
          ? null
          : React.createElement('div', { key: 'add', className: 'mindseye-add-row' }, [
            React.createElement('select', {
              key: 'kind',
              value: addTarget,
              disabled: !writable,
              'aria-label': '可选类型',
              onChange: (event) => setPendingAdd(event.target.value),
            }, availableOverrides.map((kind) =>
              React.createElement('option', { key: kind, value: kind }, OVERRIDE_LABELS[kind]))),
            React.createElement('button', {
              key: 'add',
              type: 'button',
              disabled: !writable,
              onClick: () => addOverride(addTarget),
            }, '添加'),
          ]),
        React.createElement('section', { key: 'image', className: 'mindseye-section' }, [
          React.createElement('div', { key: 'title', className: 'mindseye-section-title' }, '图片生成'),
          React.createElement('p', { key: 'hint', className: 'mindseye-section-hint' },
            '主模型生成新图片；仅在额度、限流或网络错误时切换到后备模型。'),
          React.createElement('div', { key: 'primary-head', className: 'mindseye-override-head' },
            React.createElement('span', null, '主模型')),
          React.createElement('div', { key: 'primary-body', className: 'mindseye-override-body' }, [
            React.createElement(ImageRouteFields, {
              key: 'fields',
              value: draft.imagePrimary,
              disabled: !writable,
              onChange: (next) => {
                setDraft((current) => ({ ...current, imagePrimary: next }))
                setStatus('')
                setError(undefined)
              },
            }),
            imagePrimaryError === undefined
              ? null
              : React.createElement('p', { key: 'error', className: 'mindseye-error' }, imagePrimaryError),
          ]),
          !imageFallbackAdded
            ? React.createElement('div', { key: 'add', className: 'mindseye-add-row' },
              React.createElement('button', {
                type: 'button',
                disabled: !writable,
                onClick: addImageFallback,
              }, '添加后备模型'))
            : [
              React.createElement('div', { key: 'fallback-head', className: 'mindseye-override-head' }, [
                React.createElement('span', { key: 'title' }, '后备模型'),
                React.createElement('button', {
                  key: 'remove',
                  type: 'button',
                  disabled: !writable,
                  onClick: removeImageFallback,
                }, '移除'),
              ]),
              React.createElement('div', { key: 'fallback-body', className: 'mindseye-override-body' }, [
                React.createElement(ImageRouteFields, {
                  key: 'fields',
                  value: draft.imageFallback,
                  disabled: !writable,
                  onChange: (next) => {
                    setDraft((current) => ({ ...current, imageFallback: next }))
                    setStatus('')
                    setError(undefined)
                  },
                }),
                imageFallbackError === undefined
                  ? null
                  : React.createElement('p', { key: 'error', className: 'mindseye-error' }, imageFallbackError),
              ]),
            ],
        ]),
        !writable
          ? React.createElement('p', { key: 'readonly', className: 'mindseye-error' }, '当前部署的设置为只读')
          : null,
        !hasValidRoute && dirty
          ? React.createElement('p', { key: 'no-route', className: 'mindseye-error' },
            '请至少填写通用理解模型或图片生成主模型')
          : null,
        React.createElement('div', { key: 'footer', className: 'mindseye-footer' }, [
          status === ''
            ? null
            : React.createElement('span', {
              key: 'status',
              className: 'mindseye-footer-status',
              'data-tone': 'success',
            }, status),
          React.createElement('button', {
            key: 'discard',
            type: 'button',
            className: 'mindseye-action mindseye-discard',
            disabled: !dirty || saving,
            onClick: discard,
          }, '放弃修改'),
          React.createElement('button', {
            key: 'save',
            type: 'button',
            className: 'mindseye-action mindseye-save',
            disabled: !dirty || saving || !writable || !hasValidRoute || validationError !== undefined,
            onClick: save,
          }, saving ? '保存中…' : '保存'),
        ]),
      ])
    }
  }

  return React.createElement('li', {
    className: 'mindseye-card',
    'data-open': open ? 'true' : 'false',
  }, [
    React.createElement('button', {
      key: 'head',
      type: 'button',
      className: 'mindseye-header',
      'aria-expanded': open,
      onClick: () => setOpen((current) => !current),
    }, [
      React.createElement('span', { key: 'text', className: 'mindseye-head-text' }, [
        React.createElement('span', { key: 'name', className: 'mindseye-name' }, 'MindsEye'),
        React.createElement('span', { key: 'desc', className: 'mindseye-description' },
          '一个通用理解模型即可使用；文字提取和空间定位可按需覆盖。'),
      ]),
      dirty
        ? React.createElement('span', { key: 'pending', className: 'mindseye-pending' }, '未保存')
        : null,
      React.createElement(IconChevronDownOutline14, {
        key: 'chevron',
        className: 'mindseye-chevron',
      }),
    ]),
    body,
  ])
}

export const inject = ['slots']

export function apply(ctx) {
  installStyle(ctx)
  if (typeof document !== 'undefined') {
    document.addEventListener('paste', onPasteCapture, true)
    document.addEventListener('focusin', onFocusCapture, true)
    ctx.effect(() => () => {
      document.removeEventListener('paste', onPasteCapture, true)
      document.removeEventListener('focusin', onFocusCapture, true)
    }, 'dsh-mindseye: paste bridge')
  }
  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register({
      name: 'settings.plugin.item',
      key: 'mindseye',
      id: 'mindseye',
      order: 30,
      label: () => 'MindsEye',
    }, SettingsCard)
  )
}
