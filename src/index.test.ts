import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { __test, LoggerPlugin } from "./index"

const writeProjectSettings = async (projectDir: string) => {
  mkdirSync(join(projectDir, ".opencode"), { recursive: true })
  writeFileSync(
    `${projectDir}/.opencode/logger.json`,
    `${JSON.stringify(
      {
        logger: { enabled: true, scopes: ["*"] },
      },
      null,
      2,
    )}\n`,
  )
}

describe("logger event context", () => {
  test("builds consistent session fields for subagent-safe logs", () => {
    const event = __test.buildLoggerEvent("tool_execute_before", {
      sessionID: "ses_123",
      parentSessionID: null,
      taskID: "task_77",
      agent: "codex",
      payload: { tool: "read" },
    })

    expect(event.session_id).toBe("ses_123")
    expect(event.subagent_session_id).toBe("ses_123")
    expect(event.parent_session_id).toBeNull()
    expect(event.root_session_id).toBe("ses_123")
    expect(event.task_id).toBe("task_77")
    expect(event.agent).toBe("codex")
    expect(event.tool).toBe("read")
  })
})

describe("path placeholders", () => {
  test("expands ${project} and ${date}", () => {
    const resolved = __test.expandTemplate("${project}/logs/${date}", "/tmp/repo", "2026-02-20")
    expect(resolved).toBe("/tmp/repo/logs/2026-02-20")
  })
})

describe("config naming", () => {
  test("uses logger.json config filenames", () => {
    const paths = __test.settingsFilePaths("/tmp/repo")
    expect(paths.global).toBe(`${process.env.HOME}/.config/opencode/logger.json`)
    expect(paths.project).toBe("/tmp/repo/.opencode/logger.json")
  })
})

describe("session-aware logger", () => {
  test("writes main session events into session main.jsonl", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "logger-plugin-"))
    await writeProjectSettings(projectDir)
    const plugin = await LoggerPlugin({
      directory: projectDir,
      client: {
        session: {
          get: async () => ({
            data: {
              id: "ses_main",
              title: "Fix Auth Bug",
              parentID: undefined,
              time: { created: Date.parse("2026-02-21T00:00:00Z") / 1000 },
            },
          }),
        },
      },
    } as never)

    await (plugin as any)["chat.message"](
      {
        sessionID: "ses_main",
        agent: "main",
        messageID: "msg_1",
        model: { providerID: "openai", modelID: "gpt-5" },
      },
      {
        parts: [],
      },
    )

    const logPath = `${projectDir}/.opencode/logs/sessions/2026-02-21-fix-auth-bug/main.jsonl`
    expect(existsSync(logPath)).toBe(true)
    const text = readFileSync(logPath, "utf-8")
    expect(text).toContain('"event":"chat_message"')
  })

  test("writes subagent events into parent session directory", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "logger-plugin-"))
    await writeProjectSettings(projectDir)
    const plugin = await LoggerPlugin({
      directory: projectDir,
      client: {
        session: {
          get: async ({ path }: { path: { id: string } }) => ({
            data:
              path.id === "ses_sub"
                ? {
                    id: "ses_sub",
                    title: "Explore auth",
                    parentID: "ses_main",
                    time: { created: Date.parse("2026-02-21T00:00:00Z") / 1000 },
                  }
                : {
                    id: "ses_main",
                    title: "Fix Auth Bug",
                    parentID: undefined,
                    time: { created: Date.parse("2026-02-21T00:00:00Z") / 1000 },
                  },
          }),
        },
      },
    } as never)

    await (plugin as any)["chat.message"](
      {
        sessionID: "ses_sub",
        agent: "explore",
        messageID: "msg_sub",
        model: { providerID: "openai", modelID: "gpt-5" },
      },
      {
        parts: [],
      },
    )

    const logPath = `${projectDir}/.opencode/logs/sessions/2026-02-21-fix-auth-bug/explore-ses_sub.jsonl`
    expect(existsSync(logPath)).toBe(true)
    const text = readFileSync(logPath, "utf-8")
    expect(text).toContain('"session_id":"ses_sub"')
  })

  test("chat.message resolves parent_session_id from session API", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "logger-plugin-"))
    await writeProjectSettings(projectDir)
    const plugin = await LoggerPlugin({
      directory: projectDir,
      client: {
        session: {
          get: async ({ path }: { path: { id: string } }) => ({
            data:
              path.id === "ses_sub"
                ? {
                    id: "ses_sub",
                    title: "Explore auth",
                    parentID: "ses_main",
                    time: { created: Date.parse("2026-02-21T00:00:00Z") / 1000 },
                  }
                : {
                    id: "ses_main",
                    title: "Fix Auth Bug",
                    parentID: undefined,
                    time: { created: Date.parse("2026-02-21T00:00:00Z") / 1000 },
                  },
          }),
        },
      },
    } as never)

    await (plugin as any)["chat.message"](
      {
        sessionID: "ses_sub",
        agent: "explore",
        messageID: "msg_sub",
        model: { providerID: "openai", modelID: "gpt-5" },
      },
      {
        parts: [],
      },
    )

    const logPath = `${projectDir}/.opencode/logs/sessions/2026-02-21-fix-auth-bug/explore-ses_sub.jsonl`
    const text = readFileSync(logPath, "utf-8")
    const event = JSON.parse(text.trim()) as { parent_session_id: string | null }
    expect(event.parent_session_id).toBe("ses_main")
  })

  test("tool.execute.before resolves parent_session_id from session API", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "logger-plugin-"))
    await writeProjectSettings(projectDir)
    const plugin = await LoggerPlugin({
      directory: projectDir,
      client: {
        session: {
          get: async ({ path }: { path: { id: string } }) => ({
            data:
              path.id === "ses_sub"
                ? {
                    id: "ses_sub",
                    title: "Explore auth",
                    parentID: "ses_main",
                    time: { created: Date.parse("2026-02-21T00:00:00Z") / 1000 },
                  }
                : {
                    id: "ses_main",
                    title: "Fix Auth Bug",
                    parentID: undefined,
                    time: { created: Date.parse("2026-02-21T00:00:00Z") / 1000 },
                  },
          }),
        },
      },
    } as never)

    await (plugin as any)["tool.execute.before"](
      {
        sessionID: "ses_sub",
        callID: "call_1",
        tool: "logger_set",
      },
      {
        args: { enabled: true },
      },
    )

    const logPath = `${projectDir}/.opencode/logs/sessions/2026-02-21-fix-auth-bug/subagent-ses_sub.jsonl`
    const text = readFileSync(logPath, "utf-8")
    const event = JSON.parse(text.trim()) as { parent_session_id: string | null }
    expect(event.parent_session_id).toBe("ses_main")
  })

  test("tool.execute.after resolves parent_session_id from session API", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "logger-plugin-"))
    await writeProjectSettings(projectDir)
    const plugin = await LoggerPlugin({
      directory: projectDir,
      client: {
        session: {
          get: async ({ path }: { path: { id: string } }) => ({
            data:
              path.id === "ses_sub"
                ? {
                    id: "ses_sub",
                    title: "Explore auth",
                    parentID: "ses_main",
                    time: { created: Date.parse("2026-02-21T00:00:00Z") / 1000 },
                  }
                : {
                    id: "ses_main",
                    title: "Fix Auth Bug",
                    parentID: undefined,
                    time: { created: Date.parse("2026-02-21T00:00:00Z") / 1000 },
                  },
          }),
        },
      },
    } as never)

    await (plugin as any)["tool.execute.after"](
      {
        sessionID: "ses_sub",
        callID: "call_2",
        tool: "logger_status",
      },
      {
        metadata: {},
        title: "done",
        output: "ok",
      },
    )

    const logPath = `${projectDir}/.opencode/logs/sessions/2026-02-21-fix-auth-bug/subagent-ses_sub.jsonl`
    const text = readFileSync(logPath, "utf-8")
    const event = JSON.parse(text.trim()) as { parent_session_id: string | null }
    expect(event.parent_session_id).toBe("ses_main")
  })
})
