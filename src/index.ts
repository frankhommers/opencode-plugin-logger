import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { type Plugin, tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"

interface LoggerSettings {
  enabled: boolean
  scopes: string[]
  dir: string
}

interface PluginSettings {
  logger: LoggerSettings
}

interface SettingsFile {
  logger?: {
    enabled?: boolean
    scopes?: string[]
    dir?: string
  }
}

interface SessionInfo {
  id: string
  title: string
  parentID?: string
  slug: string
}

const DEFAULT_SETTINGS: PluginSettings = {
  logger: {
    enabled: false,
    scopes: [],
    dir: ".agent-session-logs",
  },
}

const GLOBAL_SETTINGS_FILE = join(homedir(), ".config", "opencode", "logger.json")

const expandTemplate = (value: string, projectDir: string, dateOverride?: string): string => {
  const now = new Date()
  const date = dateOverride || now.toISOString().split("T")[0] || ""
  const resolved = value
    .replace(/\$\{home\}/gi, homedir())
    .replace(/\$\{project\}/gi, projectDir)
    .replace(/\$\{workspace\}/gi, projectDir)
    .replace(/\$\{date\}/gi, date)
    .replace(/\$\{env:([A-Z0-9_]+)\}/gi, (_match, key) => {
      const envKey = String(key || "")
      return process.env[envKey] || ""
    })

  return isAbsolute(resolved) ? resolved : join(projectDir, resolved)
}

const buildLoggerEvent = (
  eventName: string,
  input: {
    sessionID: string
    parentSessionID: string | null
    taskID?: string | null
    agent?: string
    payload?: Record<string, unknown>
  },
): Record<string, unknown> => {
  const rootSessionID = input.parentSessionID || input.sessionID
  return {
    ts: new Date().toISOString(),
    event: eventName,
    session_id: input.sessionID,
    subagent_session_id: input.sessionID,
    parent_session_id: input.parentSessionID,
    root_session_id: rootSessionID,
    task_id: input.taskID || null,
    agent: input.agent || null,
    ...(input.payload || {}),
  }
}

const mergeSettings = (base: PluginSettings, patch?: SettingsFile): PluginSettings => {
  if (!patch) return base
  return {
    logger: {
      enabled: patch.logger?.enabled ?? base.logger.enabled,
      scopes: patch.logger?.scopes ?? base.logger.scopes,
      dir: patch.logger?.dir ?? base.logger.dir,
    },
  }
}

const readSettingsFile = async (filePath: string): Promise<SettingsFile | undefined> => {
  if (!existsSync(filePath)) return undefined
  try {
    const text = readFileSync(filePath, "utf-8")
    if (!text.trim()) return undefined
    return JSON.parse(text) as SettingsFile
  } catch {
    return undefined
  }
}

const settingsToJSON = (settings: PluginSettings): string => {
  return JSON.stringify(
    {
      logger: {
        enabled: settings.logger.enabled,
        scopes: settings.logger.scopes,
        dir: settings.logger.dir,
      },
    },
    null,
    2,
  )
}

const projectSettingsFile = (projectDir: string) => join(projectDir, ".opencode", "logger.json")

const loadSettings = async (projectDir: string, config?: unknown): Promise<PluginSettings> => {
  const fromGlobal = await readSettingsFile(GLOBAL_SETTINGS_FILE)
  const fromProject = await readSettingsFile(projectSettingsFile(projectDir))
  let settings = mergeSettings(DEFAULT_SETTINGS, fromGlobal)
  settings = mergeSettings(settings, fromProject)

  const inlineConfig = (config as { logger?: SettingsFile["logger"] } | undefined)
  if (inlineConfig?.logger) {
    settings = mergeSettings(settings, { logger: inlineConfig.logger })
  }

  return {
    logger: {
      enabled: settings.logger.enabled,
      scopes: settings.logger.scopes,
      dir: expandTemplate(settings.logger.dir, projectDir),
    },
  }
}

const ensureDir = (path: string) => {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true })
  }
}

const slugify = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)

const makeLoggerTools = (runtime: {
  settings: PluginSettings
  sessionAgents: Map<string, string>
  sessionInfo: Map<string, SessionInfo>
  getSessionInfo: (sessionID: string) => Promise<SessionInfo>
  client: OpencodeClient
  projectDir: string
}) => {
  const appendSessionLog = async (sessionID: string, payload: Record<string, unknown>) => {
    if (!runtime.settings.logger.enabled) return

    const info = await runtime.getSessionInfo(sessionID)

    let sessionSlug: string
    let filename: string

    if (info.parentID) {
      const parentInfo = await runtime.getSessionInfo(info.parentID)
      sessionSlug = parentInfo.slug
      const agent = runtime.sessionAgents.get(sessionID) || "subagent"
      filename = `${agent}-${info.id}.jsonl`
    } else {
      sessionSlug = info.slug
      filename = "main.jsonl"
    }

    const sessionsDir = `${runtime.settings.logger.dir}/${sessionSlug}`
    ensureDir(sessionsDir)

    const filePath = `${sessionsDir}/${filename}`
    const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : ""
    writeFileSync(filePath, `${existing}${JSON.stringify(payload)}\n`)
  }

  const setLogger = tool({
    description: "Configure JSONL session logger",
    args: {
      enabled: tool.schema.boolean().optional().describe("Enable or disable logger"),
      scopes: tool.schema.array(tool.schema.string()).optional().describe("Scopes to log (empty means all)"),
      persist: tool.schema.enum(["session", "project", "global"]).optional().describe("Persist settings"),
    },
    async execute(args) {
      runtime.settings.logger.enabled = args.enabled ?? runtime.settings.logger.enabled
      runtime.settings.logger.scopes = args.scopes ?? runtime.settings.logger.scopes

      const persist = args.persist || "session"
      if (persist !== "session") {
        const target = persist === "project" ? projectSettingsFile(runtime.projectDir) : GLOBAL_SETTINGS_FILE
        ensureDir(dirname(target))
        const existing = (await readSettingsFile(target)) || {}
        const merged: SettingsFile = {
          ...existing,
          logger: {
            ...existing.logger,
            enabled: runtime.settings.logger.enabled,
            scopes: runtime.settings.logger.scopes,
            dir: runtime.settings.logger.dir,
          },
        }
        writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`)
      }

      return `Logger ${runtime.settings.logger.enabled ? "enabled" : "disabled"} (scopes: ${runtime.settings.logger.scopes.length ? runtime.settings.logger.scopes.join(", ") : "all"}, persist: ${persist})`
    },
  })

  const loggerStatus = tool({
    description: "Show logger configuration",
    args: {},
    async execute() {
      return settingsToJSON(runtime.settings)
    },
  })

  return {
    logger_set: setLogger,
    logger_status: loggerStatus,
    appendSessionLog,
  }
}

export const LoggerPlugin: Plugin = async (ctx) => {
  const runtime = {
    projectDir: ctx.directory,
    settings: await loadSettings(ctx.directory),
    sessionAgents: new Map<string, string>(),
    sessionInfo: new Map<string, SessionInfo>(),
    client: ctx.client,
  }

  const getSessionInfo = async (sessionID: string): Promise<SessionInfo> => {
    const cached = runtime.sessionInfo.get(sessionID)
    if (cached) return cached

    try {
      const result = await runtime.client.session.get({ path: { id: sessionID } })
      const session = result.data
      if (!session) throw new Error("Session not found")
      const createdMs = session.time.created > 1e12 ? session.time.created : session.time.created * 1000
      const date = new Date(createdMs).toISOString().split("T")[0]
      const info: SessionInfo = {
        id: session.id,
        title: session.title,
        parentID: session.parentID,
        slug: `${date}-${slugify(session.title)}`,
      }
      runtime.sessionInfo.set(sessionID, info)
      return info
    } catch {
      const info: SessionInfo = {
        id: sessionID,
        title: sessionID,
        parentID: undefined,
        slug: sessionID,
      }
      runtime.sessionInfo.set(sessionID, info)
      return info
    }
  }

  const tools = makeLoggerTools({
    ...runtime,
    getSessionInfo,
  })

  return {
    config: async (input) => {
      runtime.settings = await loadSettings(ctx.directory, input)
    },
    "chat.message": async (input, output) => {
      if (input.agent) runtime.sessionAgents.set(input.sessionID, input.agent)
      const info = await getSessionInfo(input.sessionID)
      const event = buildLoggerEvent("chat_message", {
        sessionID: input.sessionID,
        parentSessionID: info.parentID || null,
        agent: input.agent,
        payload: {
          message_id: input.messageID,
          model: input.model,
          parts: output.parts,
        },
      })
      await tools.appendSessionLog(input.sessionID, event)
    },
    "tool.execute.before": async (input, output) => {
      const info = await getSessionInfo(input.sessionID)
      const event = buildLoggerEvent("tool_execute_before", {
        sessionID: input.sessionID,
        parentSessionID: info.parentID || null,
        agent: runtime.sessionAgents.get(input.sessionID),
        payload: {
          call_id: input.callID,
          tool: input.tool,
          args: output.args,
        },
      })
      await tools.appendSessionLog(input.sessionID, event)
    },
    "tool.execute.after": async (input, output) => {
      const info = await getSessionInfo(input.sessionID)
      const event = buildLoggerEvent("tool_execute_after", {
        sessionID: input.sessionID,
        parentSessionID: info.parentID || null,
        agent: runtime.sessionAgents.get(input.sessionID),
        payload: {
          call_id: input.callID,
          tool: input.tool,
          title: output.title,
          output: output.output,
        },
      })
      await tools.appendSessionLog(input.sessionID, event)
    },
    tool: {
      logger_set: tools.logger_set,
      logger_status: tools.logger_status,
    },
  }
}

export default LoggerPlugin

export const __test = {
  expandTemplate,
  buildLoggerEvent,
  settingsFilePaths: (projectDir: string) => ({
    global: GLOBAL_SETTINGS_FILE,
    project: projectSettingsFile(projectDir),
  }),
}
