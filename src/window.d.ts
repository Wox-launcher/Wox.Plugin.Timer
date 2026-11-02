import { Context } from "@wox-launcher/wox-plugin"

export interface PluginWindow {
  readonly ID: string
  Content: { PostMessage(ctx: Context, option: { Data: unknown }): Promise<{ Success: boolean; ErrMsg?: string }> }
  Show(ctx: Context, option: object): Promise<{ Success: boolean; ErrMsg?: string }>
  Close(ctx: Context, option: object): Promise<{ Success: boolean; ErrMsg?: string }>
  SetOptions(ctx: Context, option: { Width?: number; Height?: number }): Promise<{ Success: boolean; ErrMsg?: string }>
}
export interface CreateWindowOption {
  Content: { Type: "html"; Data: string }
  Window?: { Width?: number; Height?: number; Movable?: boolean; Closable?: boolean; Topmost?: boolean; HideChrome?: boolean; DragContent?: boolean }
  OnEvent?: (ctx: Context, event: { Type: string; WindowID: string; ErrMsg?: string; Data?: unknown }) => Promise<void>
}
export interface CreateWindowResult {
  Success: boolean
  ErrMsg?: string
  Window?: PluginWindow
}
