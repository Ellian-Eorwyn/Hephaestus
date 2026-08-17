import type { ThinkingLevel } from '@shared/types'
import type { useStore } from '../store/store'
import { THINKING_ORDER } from './thinking'

/** The store snapshot handed to a command (carries every action a command may call). */
type StoreState = ReturnType<typeof useStore.getState>

export interface SlashContext {
  /** Everything after the command name (already trimmed of the leading space). */
  args: string
  /** The current run, or null when no live session exists. */
  runId: string | null
  /** False for a view-only harness (no RPC launcher). */
  canSend: boolean
  store: StoreState
}

export interface SlashCommand {
  name: string
  description: string
  /** Shown after the name in autocomplete. `<x>` = required arg, `[x]` = optional. */
  argHint?: string
  run: (ctx: SlashContext) => void | Promise<void>
}

/**
 * Client-side slash commands. Each maps to an existing store action / RPC command,
 * so adding a new one is a single entry here. pi-forge's own built-in menus are
 * terminal-only (they never cross the RPC channel), so the useful ones are
 * re-implemented natively below rather than forwarded.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'model',
    description: 'Switch the active model',
    argHint: '[name]',
    run: async (ctx) => {
      const arg = ctx.args.trim().toLowerCase()
      if (arg) {
        if (!ctx.store.availableModels.length) await ctx.store.loadAvailableModels()
        const models = ctx.store.availableModels
        const hit =
          models.find((m) => m.modelId.toLowerCase() === arg || m.label.toLowerCase() === arg) ??
          models.find(
            (m) => m.modelId.toLowerCase().includes(arg) || m.label.toLowerCase().includes(arg)
          )
        if (hit) {
          await ctx.store.setModel(hit.provider, hit.modelId, hit.label)
          return
        }
      }
      ctx.store.openCommandMenu({ kind: 'model' })
    }
  },
  {
    name: 'think',
    description: 'Set the thinking level',
    argHint: '[off|low|medium|high|…]',
    run: async (ctx) => {
      const arg = ctx.args.trim().toLowerCase()
      const lvl = THINKING_ORDER.find((l) => l === arg)
      if (lvl) {
        await ctx.store.setThinkingLevel(lvl as ThinkingLevel)
        return
      }
      ctx.store.openCommandMenu({ kind: 'think' })
    }
  },
  {
    name: 'compact',
    description: 'Compact the conversation context',
    argHint: '[instructions]',
    run: (ctx) => ctx.store.compactSession(ctx.args.trim() || undefined)
  },
  {
    name: 'new',
    description: 'Start a new chat in this project',
    run: (ctx) => {
      if (ctx.store.selectedCwd) void ctx.store.startNewChat(ctx.store.selectedCwd)
    }
  },
  {
    name: 'resume',
    description: 'Open a past session in this project',
    run: (ctx) => ctx.store.openCommandMenu({ kind: 'session' })
  },
  {
    name: 'tree',
    description: 'Browse sessions in this project',
    run: (ctx) => ctx.store.openCommandMenu({ kind: 'session' })
  },
  {
    name: 'fork',
    description: 'Fork the conversation from an earlier point',
    run: (ctx) => ctx.store.openCommandMenu({ kind: 'fork' })
  },
  {
    name: 'name',
    description: 'Rename this session',
    argHint: '<name>',
    run: (ctx) => {
      const n = ctx.args.trim()
      if (n) void ctx.store.renameSession(n)
    }
  },
  {
    name: 'clone',
    description: 'Clone this session into a new branch',
    run: (ctx) => ctx.store.cloneSession()
  }
]

/** Parse `/name args…`. Returns null when the text isn't a slash command. */
export function parseSlashCommand(
  text: string
): { name: string; args: string; cmd?: SlashCommand } | null {
  if (!text.startsWith('/')) return null
  const m = text.slice(1).match(/^(\S*)\s?([\s\S]*)$/)
  const name = (m?.[1] ?? '').toLowerCase()
  const args = m?.[2] ?? ''
  return { name, args, cmd: SLASH_COMMANDS.find((c) => c.name === name) }
}

/** Client commands whose name starts with the typed prefix (for autocomplete). */
export function matchSlashCommands(prefix: string): SlashCommand[] {
  const q = prefix.toLowerCase()
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q))
}
