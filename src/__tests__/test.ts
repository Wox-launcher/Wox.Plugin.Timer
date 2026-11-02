/* eslint-disable @typescript-eslint/no-explicit-any */
import { Context, PublicAPI, Query } from "@wox-launcher/wox-plugin"
import { formatRemaining, parseDuration, plugin } from "../index"

const ctx = {} as Context
const query = (search: string) => ({ Search: search }) as Query

test("parses durations and notes", () => {
  expect(parseDuration("1h15m tea")).toEqual({ durationMs: 4500000, label: "1h 15m", note: "tea" })
  expect(parseDuration("1m备注")?.note).toBe("备注")
  expect(parseDuration("0m")).toBeNull()
  expect(parseDuration("999999999999999999h")).toBeNull()
  expect(formatRemaining(3723000)).toBe("1h 02m 03s")
})

test("starts, pauses, resumes and closes a pinned timer", async () => {
  jest.useFakeTimers().setSystemTime(1700000000000)
  let unload: (c: Context) => Promise<void> = async () => {}
  let onEvent: (c: Context, e: { Type: string; WindowID: string; Data?: unknown }) => Promise<void> = async () => {}
  const window = {
    ID: "window",
    Show: jest.fn().mockResolvedValue({ Success: true }),
    Close: jest.fn().mockResolvedValue({ Success: true }),
    SetOptions: jest.fn().mockResolvedValue({ Success: true }),
    Content: { PostMessage: jest.fn().mockResolvedValue({ Success: true }) }
  }
  const api = {
    GetSetting: jest.fn().mockResolvedValue(""),
    SetSetting: jest.fn().mockResolvedValue({ Success: true }),
    GetTranslation: jest.fn(async (_c, k) => k),
    GetThemeColors: jest.fn().mockResolvedValue({ Text: "#111111", SecondaryText: "#555555" }),
    ShowToastMsg: jest.fn().mockResolvedValue({ Success: true }),
    CreateWindow: jest.fn(async (_c, o) => {
      onEvent = o.OnEvent
      return { Success: true, Window: window }
    }),
    OnMRURestore: jest.fn(),
    RegisterPluginTool: jest.fn(),
    OnUnload: jest.fn(async (_c, cb) => {
      unload = cb
    }),
    UpdateResult: jest.fn().mockResolvedValue(true),
    RefreshQuery: jest.fn(),
    Log: jest.fn()
  }
  await plugin.init(ctx, { PluginDirectory: "", API: api as unknown as PublicAPI })
  const start = ((await plugin.query(ctx, query("5m tea"))) as { Results: any[] }).Results[0].Actions[0]
  await start.Action(ctx, {})
  expect(window.Show).toHaveBeenCalled()
  expect(api.CreateWindow.mock.calls[0][1].Window).toMatchObject({ Width: 128, Height: 76, HideChrome: true, DragContent: true, Movable: true })
  expect(api.CreateWindow.mock.calls[0][1].Content.Data).toContain("user-select:none")
  expect(api.CreateWindow.mock.calls[0][1].Content.Data).toContain("html,body{background:transparent}")
  expect(api.CreateWindow.mock.calls[0][1].Content.Data).toContain("--text:#111111;--secondary:#555555")
  expect(api.CreateWindow.mock.calls[0][1].Content.Data).toContain("body:hover button")
  expect(window.SetOptions).not.toHaveBeenCalled()
  let row = ((await plugin.query(ctx, query(""))) as { Results: any[] }).Results[0]
  await row.Actions[0].Action(ctx, {})
  jest.advanceTimersByTime(10000)
  row = ((await plugin.query(ctx, query(""))) as { Results: any[] }).Results[0]
  expect(row.Title).toBe("05:00")
  await row.Actions[0].Action(ctx, {})
  await onEvent(ctx, { Type: "message", WindowID: "window", Data: { action: "close" } })
  expect(window.Close).toHaveBeenCalled()
  row = ((await plugin.query(ctx, query(""))) as { Results: any[] }).Results[0]
  expect(row.Tails).toHaveLength(1)
  await row.Actions[3].Action(ctx, {})
  expect(JSON.parse(api.SetSetting.mock.calls[api.SetSetting.mock.calls.length - 1][1].Value)).toEqual([])
  await unload(ctx)
  jest.useRealTimers()
})
