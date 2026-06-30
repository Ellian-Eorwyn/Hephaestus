import { createHighlighter, type Highlighter } from 'shiki'

// Curated set covering the languages mapped in the main FileService.
const LANGS = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'python',
  'ruby',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'csharp',
  'bash',
  'yaml',
  'toml',
  'html',
  'css',
  'scss',
  'sql',
  'swift',
  'kotlin',
  'php',
  'xml'
] as const

export const DARK_THEME = 'vesper'
export const LIGHT_THEME = 'github-light'

let instance: Promise<Highlighter> | null = null

export function getHighlighter(): Promise<Highlighter> {
  if (!instance) {
    instance = createHighlighter({
      themes: [DARK_THEME, LIGHT_THEME],
      langs: LANGS as unknown as string[]
    })
  }
  return instance
}

export function normalizeLang(lang?: string): string {
  if (!lang) return 'text'
  return (LANGS as readonly string[]).includes(lang) ? lang : 'text'
}
