/* eslint-disable @typescript-eslint/no-explicit-any */
import { Context, PublicAPI, Query, WindowEvent } from "@wox-launcher/wox-plugin"
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
  let onEvent: (c: Context, e: WindowEvent) => Promise<void> = async () => {}
  const window = {
    ID: "window",
    Show: jest.fn().mockResolvedValue({ Success: true }),
    Close: jest.fn().mockResolvedValue({ Success: true }),
    SetOptions: jest.fn().mockResolvedValue({ Success: true }),
    Content: { Update: jest.fn().mockResolvedValue({ Success: true }) }
  }
  const api = {
    GetSetting: jest.fn().mockResolvedValue(""),
    SetSetting: jest.fn().mockResolvedValue({ Success: true }),
    GetTranslation: jest.fn(async (_c, k) => k),
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
  const options = api.CreateWindow.mock.calls[0][1]
  expect(options.Window).toMatchObject({ Width: 128, Height: 76, Movable: true, Closable: true, HideChrome: true, DragContent: true })
  expect(options.Content.Type).toBe("woxview")
  const tree = JSON.parse(options.Content.Data)
  expect(tree.version).toBe(1)
  expect(tree.root.props.style.backgroundColor).toBe("$background")
  expect(tree.root.children[0].children.map((node: any) => node.props.text)).toEqual(["05:00", "tea"])
  expect(tree.root.children[0].children.map((node: any) => node.props.style.color)).toEqual(["$text", "$textSecondary"])
  expect(tree.root.props.onHoverChange).toEqual({ $handler: "hover" })
  expect(tree.root.children).toHaveLength(1)
  const hover = async (inside: boolean) => onEvent(ctx, { Type: "woxview_event", WindowID: "window", Data: { Handler: "hover", Args: [inside] } })
  await hover(true)
  let latestTree = JSON.parse(window.Content.Update.mock.calls[window.Content.Update.mock.calls.length - 1][1].Data)
  expect(latestTree.root.children[1].props.onPress).toEqual({ $handler: "close" })
  await hover(false)
  latestTree = JSON.parse(window.Content.Update.mock.calls[window.Content.Update.mock.calls.length - 1][1].Data)
  expect(latestTree.root.children).toHaveLength(1)
  expect(window.SetOptions).not.toHaveBeenCalled()
  await jest.advanceTimersByTimeAsync(1000)
  const updatedTree = JSON.parse(window.Content.Update.mock.calls[window.Content.Update.mock.calls.length - 1][1].Data)
  expect(updatedTree.root.children[0].children[0].props.text).toBe("04:59")
  expect(updatedTree.root.props.style.backgroundColor).toBe("$background")
  let row = ((await plugin.query(ctx, query(""))) as { Results: any[] }).Results[0]
  await row.Actions[0].Action(ctx, {})
  const pausedTree = JSON.parse(window.Content.Update.mock.calls[window.Content.Update.mock.calls.length - 1][1].Data)
  expect(pausedTree.root.children[0].children[1].props.text).toBe("tea · plugin_timer_status_paused")
  jest.advanceTimersByTime(10000)
  row = ((await plugin.query(ctx, query(""))) as { Results: any[] }).Results[0]
  expect(row.Title).toBe("04:59")
  await row.Actions[0].Action(ctx, {})
  await row.Actions[2].OnSubmit(ctx, { Values: { note: "tea <&>" } })
  expect(JSON.parse(window.Content.Update.mock.calls[window.Content.Update.mock.calls.length - 1][1].Data).root.children[0].children[1].props.text).toBe("tea <&>")
  await hover(true)
  await onEvent(ctx, { Type: "woxview_event", WindowID: "other", Data: { Handler: "close" } })
  expect(window.Close).not.toHaveBeenCalled()
  await onEvent(ctx, { Type: "woxview_event", WindowID: "window", Data: { Handler: "close" } })
  expect(window.Close).toHaveBeenCalled()
  row = ((await plugin.query(ctx, query(""))) as { Results: any[] }).Results[0]
  expect(row.Tails).toHaveLength(1)
  await row.Actions[3].Action(ctx, {})
  expect(JSON.parse(api.SetSetting.mock.calls[api.SetSetting.mock.calls.length - 1][1].Value)).toEqual([])
  await unload(ctx)
  jest.useRealTimers()
})
