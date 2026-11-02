import { randomUUID } from "node:crypto"
import { Context, Plugin, PublicAPI, Query, QueryResponse, Result } from "@wox-launcher/wox-plugin"
import type { CreateWindowOption, CreateWindowResult, PluginWindow } from "./window"

type WindowAPI = PublicAPI & {
  CreateWindow(ctx: Context, option: CreateWindowOption): Promise<CreateWindowResult>
  ShowToastMsg(ctx: Context, option: { Message: string }): Promise<{ Success: boolean; ErrMsg?: string }>
}
type Timer = { id: string; durationLabel: string; note: string; durationMs: number; deadlineUnixMs: number; remainingMs: number; paused: boolean }
let api: WindowAPI
let timers = new Map<string, Timer>()
let windows = new Map<string, PluginWindow>()
let tracked = new Set<string>()
let interval: ReturnType<typeof setInterval>
let ticking = false
let saveQueue = Promise.resolve()
const icon = { ImageType: "relative" as const, ImageData: "images/app.svg" }
const key = (s: string) => `i18n:plugin_timer_${s}`
const hotkey = process.platform === "darwin" ? "cmd+enter" : "ctrl+enter"
const html = `<!doctype html><html><meta charset="utf-8"><style>
html,body{background:transparent} body{margin:0;color:var(--text);font-family:system-ui;display:grid;place-items:center;height:100vh;text-align:center;user-select:none;-webkit-user-select:none}
#time{font-size:22px;font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap} #note{font-size:11px;color:var(--secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:calc(100vw - 24px);margin-top:5px} #note:empty{display:none}
button{position:absolute;top:6px;right:6px;width:24px;height:24px;padding:5px;border:0;border-radius:6px;background:transparent;color:var(--text);opacity:0;pointer-events:none;cursor:pointer} body:hover button,button:focus-visible{opacity:1;pointer-events:auto} button:hover{background:color-mix(in srgb,var(--text) 12%,transparent)} button svg{width:100%;height:100%;display:block}
</style><div><div id="time"></div><div id="note"></div></div><button id="close" type="button" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg></button><script>
woxWindow.onMessage(s=>{document.getElementById('time').textContent=s.time;document.getElementById('note').textContent=s.note;if(s.closeLabel)document.getElementById('close').setAttribute('aria-label',s.closeLabel)})
document.getElementById('close').addEventListener('click',()=>woxWindow.postMessage({action:'close'}))
</script></html>`

export function parseDuration(input: string): { durationMs: number; label: string; note: string } | null {
  let rest = input.trim(),
    durationMs = 0
  const parts: string[] = []
  while (true) {
    const match = /^\s*(\d+)\s*([hms])/i.exec(rest)
    if (!match) break
    const value = Number(match[1]),
      unit = match[2].toLowerCase()
    durationMs += value * ({ h: 3600000, m: 60000, s: 1000 }[unit] || 0)
    parts.push(`${value}${unit}`)
    rest = rest.slice(match[0].length)
  }
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 315360000000) return null
  return { durationMs, label: parts.join(" "), note: rest.trim() }
}
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000)),
    h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    s = total % 60
  return h ? `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s` : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}
const remaining = (t: Timer) => Math.max(0, t.paused ? t.remainingMs : t.deadlineUnixMs - Date.now())
const translation = (ctx: Context, name: string) => api.GetTranslation(ctx, `plugin_timer_${name}`)

// Serialize snapshots so a slower earlier write cannot replace a newer timer state.
function save(ctx: Context): Promise<void> {
  const value = JSON.stringify([...timers.values()])
  saveQueue = saveQueue
    .catch(() => {})
    .then(async () => {
      const result = await api.SetSetting(ctx, { Key: "activeTimers", Value: value, IsLocal: true })
      if (!result.Success) throw new Error(result.ErrMsg)
    })
  return saveQueue
}
async function closeWindow(ctx: Context, id: string): Promise<void> {
  const window = windows.get(id)
  windows.delete(id)
  if (window) await window.Close(ctx, {})
}
async function updateWindow(ctx: Context, t: Timer): Promise<void> {
  const window = windows.get(t.id)
  if (!window) return
  const paused = t.paused ? await translation(ctx, "status_paused") : ""
  await window.Content.PostMessage(ctx, { Data: { time: formatRemaining(remaining(t)), note: [t.note, paused].filter(Boolean).join(" · ") } })
}
async function pin(ctx: Context, t: Timer): Promise<void> {
  if (windows.has(t.id)) {
    await closeWindow(ctx, t.id)
    return
  }
  const colors = await api.GetThemeColors(ctx, {})
  // Only insert validated CSS colors into plugin-authored HTML.
  const cssColor = (value: string, fallback: string) => (/^#[0-9a-f]{6}$/i.test(value) ? value : fallback)
  const themedHTML = html.replace("<style>", `<style>:root{--text:${cssColor(colors.Text, "#ffffff")};--secondary:${cssColor(colors.SecondaryText, "#cbd1df")}}`)
  const created = await api.CreateWindow(ctx, {
    Window: {
      Width: Math.min(220, Math.max(128, formatRemaining(remaining(t)).length * 13 + 32, Array.from(t.note).length * 11 + 24)),
      Height: 76,
      Movable: true,
      Closable: true,
      HideChrome: true,
      DragContent: true,
      Topmost: true
    },
    Content: { Type: "html", Data: themedHTML },
    OnEvent: async (eventCtx, event) => {
      if (event.Type === "closed" && windows.get(t.id)?.ID === event.WindowID) {
        windows.delete(t.id)
        await updateRow(eventCtx, t.id)
      }
      if (event.Type === "message" && typeof event.Data === "object" && event.Data !== null && "action" in event.Data && event.Data.action === "close" && windows.get(t.id)?.ID === event.WindowID) {
        await closeWindow(eventCtx, t.id)
        await updateRow(eventCtx, t.id)
      }
      if (event.Type === "error") await api.Log(eventCtx, "Error", `Timer window: ${event.ErrMsg}`)
    }
  })
  if (!created.Success || !created.Window) throw new Error(created.ErrMsg || "Could not create timer window")
  if (!timers.has(t.id)) {
    await created.Window.Close(ctx, {})
    return
  }
  windows.set(t.id, created.Window)
  await created.Window.Content.PostMessage(ctx, { Data: { closeLabel: await translation(ctx, "action_unpin_from_desktop"), time: formatRemaining(remaining(t)), note: t.note } })
  await updateWindow(ctx, t)
  const shown = await created.Window.Show(ctx, {})
  if (!shown.Success) {
    await closeWindow(ctx, t.id)
    throw new Error(shown.ErrMsg)
  }
}
async function start(ctx: Context, durationMs: number, label: string, note: string, pinned: boolean): Promise<Timer> {
  const t: Timer = { id: randomUUID(), durationLabel: label, note, durationMs, deadlineUnixMs: Date.now() + durationMs, remainingMs: durationMs, paused: false }
  timers.set(t.id, t)
  await save(ctx)
  await api.ShowToastMsg(ctx, { Message: `${await translation(ctx, "started")} ${note || label}` })
  if (pinned) await pin(ctx, t)
  return t
}
async function startResult(ctx: Context, durationMs: number, label: string, note: string): Promise<Result> {
  const data = { durationMs: String(durationMs), durationLabel: label, note }
  return {
    Title: `${await translation(ctx, "start_title")} ${label}`,
    SubTitle: note || key("start_subtitle"),
    Icon: icon,
    Score: 2000000,
    IdentityKey: `timer:start:${durationMs}:${note}`,
    Actions: [
      {
        Name: key("action_start_pinned"),
        IsDefault: true,
        ContextData: data,
        Action: async c => {
          await start(c, durationMs, label, note, true)
        }
      },
      {
        Name: key("action_start_background"),
        Hotkey: hotkey,
        ContextData: data,
        Action: async c => {
          await start(c, durationMs, label, note, false)
        }
      }
    ]
  }
}
async function timerResult(ctx: Context, t: Timer): Promise<Result> {
  const data = { timerId: t.id, durationMs: String(t.durationMs), durationLabel: t.durationLabel, note: t.note }
  const subtitle = [t.note || t.durationLabel, t.paused ? await translation(ctx, "status_paused") : ""].filter(Boolean).join(" · ")
  return {
    Id: t.id,
    IdentityKey: `timer:${t.id}`,
    Title: formatRemaining(remaining(t)),
    SubTitle: subtitle,
    Icon: icon,
    Score: 1000000 - Math.floor(remaining(t) / 1000),
    Tails: [{ Type: "text", Text: t.durationLabel }, ...(windows.has(t.id) ? [{ Type: "text" as const, Text: await translation(ctx, "status_pinned") }] : [])],
    Actions: [
      {
        Name: key(t.paused ? "action_resume" : "action_pause"),
        IsDefault: true,
        PreventHideAfterAction: true,
        ContextData: data,
        Action: async c => {
          if (t.paused) {
            t.deadlineUnixMs = Date.now() + t.remainingMs
            t.paused = false
          } else {
            t.remainingMs = remaining(t)
            t.paused = true
          }
          await save(c)
          await updateWindow(c, t)
          await updateRow(c, t.id)
        }
      },
      {
        Name: key(windows.has(t.id) ? "action_unpin_from_desktop" : "action_pin_on_desktop"),
        Hotkey: hotkey,
        PreventHideAfterAction: true,
        ContextData: data,
        Action: async c => {
          await pin(c, t)
          await updateRow(c, t.id)
        }
      },
      {
        Type: "form",
        Name: key("action_edit_note"),
        PreventHideAfterAction: true,
        ContextData: data,
        Form: [{ Type: "textbox", Value: { Key: "note", Label: key("edit_note_label"), DefaultValue: t.note, Tooltip: key("edit_note_hint") }, DisabledInPlatforms: [], IsPlatformSpecific: false }],
        OnSubmit: async (c, action) => {
          t.note = (action.Values.note || "").trim()
          await save(c)
          await updateWindow(c, t)
          await api.RefreshQuery(c, { PreserveSelectedIndex: true })
        }
      },
      {
        Name: key("action_delete"),
        PreventHideAfterAction: true,
        ContextData: data,
        Action: async c => {
          timers.delete(t.id)
          await closeWindow(c, t.id)
          await save(c)
          await api.RefreshQuery(c, { PreserveSelectedIndex: true })
        }
      }
    ]
  }
}
async function updateRow(ctx: Context, id: string, timeOnly = false): Promise<void> {
  const t = timers.get(id)
  if (!t || !tracked.has(id)) return
  if (timeOnly) {
    await api.UpdateResult(ctx, { Id: id, Title: formatRemaining(remaining(t)) })
    return
  }
  const result = await timerResult(ctx, t)
  await api.UpdateResult(ctx, { Id: id, Title: result.Title, SubTitle: result.SubTitle, Icon: result.Icon, Tails: result.Tails, Actions: result.Actions })
}
async function tick(ctx: Context): Promise<void> {
  for (const t of [...timers.values()]) {
    if (!t.paused && remaining(t) <= 0) {
      timers.delete(t.id)
      await closeWindow(ctx, t.id)
      await save(ctx)
      await api.ShowToastMsg(ctx, { Message: `${await translation(ctx, "finished")} ${t.note || t.durationLabel}` })
      if (tracked.delete(t.id)) await api.RefreshQuery(ctx, { PreserveSelectedIndex: true })
    } else {
      await updateWindow(ctx, t)
      await updateRow(ctx, t.id, true)
    }
  }
}
export const plugin: Plugin = {
  init: async (ctx, params) => {
    api = params.API as WindowAPI
    timers = new Map()
    windows = new Map()
    tracked = new Set()
    const raw = await api.GetSetting(ctx, "activeTimers")
    if (raw) {
      try {
        const stored: Timer[] = JSON.parse(raw)
        for (const t of stored) if (t.id && t.durationMs > 0) timers.set(t.id, t)
      } catch (error) {
        await api.Log(ctx, "Error", `Failed to load timers: ${String(error)}`)
      }
    }
    await api.OnMRURestore(ctx, async (c, mru) => {
      const data = mru.ContextData,
        t = timers.get(data.timerId)
      if (t) {
        tracked.add(t.id)
        return timerResult(c, t)
      }
      const duration = Number(data.durationMs)
      return Number.isSafeInteger(duration) && duration > 0 ? startResult(c, duration, data.durationLabel, data.note || "") : null
    })
    await api.RegisterPluginTool(ctx, {
      Tool: {
        Name: "start_timer",
        Description: "Start a countdown timer in the background",
        InputSchema: {
          type: "object",
          properties: { duration_seconds: { type: "integer", minimum: 1, maximum: 315360000 }, note: { type: "string" } },
          required: ["duration_seconds"],
          additionalProperties: false
        },
        OutputSchema: { type: "object", properties: { timer_id: { type: "string" } }, required: ["timer_id"] },
        Annotations: { ReadOnly: false, Destructive: false, Idempotent: false, RequiresUI: false }
      },
      Handler: async (c, option) => {
        const seconds = Number(option.Arguments.duration_seconds),
          note = String(option.Arguments.note || "")
        const t: Timer = { id: randomUUID(), durationLabel: `${seconds}s`, note, durationMs: seconds * 1000, deadlineUnixMs: Date.now() + seconds * 1000, remainingMs: seconds * 1000, paused: false }
        timers.set(t.id, t)
        await save(c)
        return { Output: { timer_id: t.id } }
      }
    })
    await tick(ctx)
    interval = setInterval(() => {
      if (ticking) return
      ticking = true
      void tick(ctx)
        .catch(error => api.Log(ctx, "Error", `Timer tick: ${String(error)}`))
        .finally(() => {
          ticking = false
        })
    }, 1000)
    await api.OnUnload(ctx, async c => {
      clearInterval(interval)
      for (const id of windows.keys()) await closeWindow(c, id)
    })
  },
  query: async (ctx: Context, query: Query): Promise<QueryResponse> => {
    tracked = new Set()
    const results: Result[] = [],
      parsed = parseDuration(query.Search)
    if (parsed) results.push(await startResult(ctx, parsed.durationMs, parsed.label, parsed.note))
    for (const t of [...timers.values()].sort((a, b) => remaining(a) - remaining(b))) {
      tracked.add(t.id)
      results.push(await timerResult(ctx, t))
    }
    if (!results.length) results.push({ Title: key("no_timers"), SubTitle: key("no_timers_subtitle"), Icon: icon, Score: 1 })
    return { Results: results }
  }
}
