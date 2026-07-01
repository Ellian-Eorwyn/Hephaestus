// One-click install presets for known pi/forge harnesses. Shared by the main
// process (to run installs + compute status) and the renderer (to render cards).
// Paths use `~` and are expanded in the main process via expandHome().

export type HarnessPresetId = 'pi-forge' | 'pi-vault' | 'pi'

export interface HarnessPreset {
  id: HarnessPresetId
  label: string
  description: string
  /** Install root under the home dir (e.g. `~/.pi-forge`). Empty for global-only installs. */
  homeDir: string
  /** The agent dir to register once installed. */
  agentDir: string
  /** Human-readable prerequisites shown as chips in the UI. */
  prerequisites: string[]
  /** Shell command run via `bash -lc` to install fresh. */
  installCommand: string
  /** Shell command run via `bash -lc` to update an existing install. */
  updateCommand: string
}

export const HARNESS_PRESETS: HarnessPreset[] = [
  {
    id: 'pi-forge',
    label: 'Pi Forge',
    description: 'Research & document-processing harness. Clones, builds, and configures into ~/.pi-forge.',
    homeDir: '~/.pi-forge',
    agentDir: '~/.pi-forge/agent',
    prerequisites: ['git', 'node ≥ 22.19'],
    installCommand: 'curl -fsSL https://raw.githubusercontent.com/Ellian-Eorwyn/pi-forge/main/install.sh | bash',
    updateCommand: 'pi-forge-update'
  },
  {
    id: 'pi-vault',
    label: 'Pi Vault',
    description: 'Obsidian-vault agent. Clones, builds Node + a Python venv, and configures into ~/.pi-vault.',
    homeDir: '~/.pi-vault',
    agentDir: '~/.pi-vault/agent',
    prerequisites: ['git', 'node ≥ 22.19', 'python ≥ 3.11'],
    installCommand: 'curl -fsSL https://raw.githubusercontent.com/Ellian-Eorwyn/pi-vault/main/install.sh | bash',
    updateCommand: 'pi-vault-update'
  },
  {
    id: 'pi',
    label: 'Fresh Pi',
    description: 'The upstream pi CLI. Official installer bootstraps Node 22 if missing; agent dir is created on first run.',
    homeDir: '~/.pi',
    agentDir: '~/.pi/agent',
    prerequisites: ['curl'],
    installCommand: 'curl -fsSL https://pi.dev/install.sh | sh',
    updateCommand: 'pi update --self'
  }
]

export function getPreset(id: string): HarnessPreset | undefined {
  return HARNESS_PRESETS.find((p) => p.id === id)
}
