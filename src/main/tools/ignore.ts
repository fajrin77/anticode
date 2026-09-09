/**
 * Entries that are build output, dependency caches, or VCS internals. Scanning
 * or listing them floods the model's context with noise it never asked for.
 * Ambiguous names (`build`, `out`) are deliberately NOT here — some projects
 * keep real sources in them.
 */
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  '.cache',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'target',
  '.gradle',
  '.idea',
  '.vscode',
  'Pods',
  'DerivedData'
])

const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

export function isIgnoredEntry(name: string, isDirectory: boolean): boolean {
  return isDirectory ? IGNORED_DIRECTORIES.has(name) : IGNORED_FILES.has(name)
}
