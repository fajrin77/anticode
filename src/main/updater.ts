import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn, execFile } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { UpdateSettings, UpdateState } from '@shared/ipc'

/*
 * anticode's own updater. The builds are personal and unsigned, which rules
 * out Squirrel (macOS refuses to swap an unsigned bundle through it), so this
 * does the three steps itself: find the newest build at a source the user set,
 * download it, checking its sha512 when the source lists one, and, only when
 * the user says so, swap it in through a small helper that waits for the app
 * to quit. A source is a GitHub repository, an electron-builder feed URL, or a
 * local folder such as a project's own `release/`.
 */

export type UpdateSource =
  | { kind: 'github'; repo: string }
  | { kind: 'feed'; url: string }
  | { kind: 'folder'; path: string }

export interface UpdateAsset {
  version: string
  /** A URL, or an absolute path for a folder source. */
  location: string
  name: string
  /** electron-builder's base64 sha512, when the source lists one. */
  sha512: string | null
  notes: string | null
}

export interface Platform {
  os: NodeJS.Platform
  arch: string
}

const FETCH_TIMEOUT_MS = 30_000
/**
 * `anticode-0.0.24-arm64.dmg`, `anticode-0.0.24-arm64-mac.zip`,
 * `anticode Setup 0.0.24.exe`: the version, with a pre-release tag only when
 * it is not one of electron-builder's arch or platform words.
 */
const BUILD_NAME = /[-.\s](\d+\.\d+\.\d+(?:-(?!(?:arm64|x64|ia32|armv7l|universal|mac|win|linux)\b)[\w.]+)?)(?:-[\w-]+)?\.(zip|dmg|exe|AppImage)$/i

/** What the user typed in Settings, understood; null for nothing usable. */
export function parseSource(raw: string): UpdateSource | null {
  const text = raw.trim()
  if (text === '') return null
  const repo = /^(?:github:|https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(text)
  if (repo !== null && !text.startsWith('/') && !/^https?:\/\/(?!github\.com)/.test(text)) {
    return { kind: 'github', repo: repo[1] ?? '' }
  }
  if (/^https?:\/\//.test(text)) return { kind: 'feed', url: text }
  if (text.startsWith('~')) return { kind: 'folder', path: path.join(homedir(), text.slice(1)) }
  if (path.isAbsolute(text)) return { kind: 'folder', path: text }
  return null
}

/** Numeric dotted versions, a pre-release (1.2.0-beta) sorting before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (value: string): [number[], string] => {
    const [core = '', pre = ''] = value.replace(/^v/, '').split('-', 2)
    return [core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre]
  }
  const [left, leftPre] = split(a)
  const [right, rightPre] = split(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  if (leftPre === rightPre) return 0
  if (leftPre === '') return 1
  if (rightPre === '') return -1
  return leftPre < rightPre ? -1 : 1
}

/** The feed file electron-builder writes for each platform. */
export function feedName(platform: Platform): string {
  return platform.os === 'darwin' ? 'latest-mac.yml' : platform.os === 'linux' ? 'latest-linux.yml' : 'latest.yml'
}

/**
 * The installer that fits this machine, by name: a zip or dmg on macOS (for
 * this CPU, or universal), an exe on Windows, an AppImage on Linux. A zip is
 * preferred on macOS, it unpacks without mounting anything.
 */
export function pickAssetName(names: string[], platform: Platform): string | null {
  const fits = (name: string): boolean => {
    const lower = name.toLowerCase()
    if (platform.os === 'darwin') {
      if (!/\.(zip|dmg)$/.test(lower) || lower.endsWith('.blockmap')) return false
      const tagged = /(arm64|x64|universal)/.exec(lower)?.[1]
      return tagged === undefined || tagged === 'universal' || tagged === platform.arch
    }
    if (platform.os === 'win32') return lower.endsWith('.exe') && !lower.includes('uninstall')
    return lower.endsWith('.appimage')
  }
  const matching = names.filter(fits)
  return matching.find((name) => name.toLowerCase().endsWith('.zip')) ?? matching[0] ?? null
}

/**
 * Just enough YAML for electron-builder's feed: top-level `key: value` pairs
 * and the `files:` list of `url`/`sha512`/`size` maps.
 */
export function parseFeed(text: string): { version: string; files: { url: string; sha512: string | null }[]; notes: string | null } {
  const top: Record<string, string> = {}
  const files: { url: string; sha512: string | null }[] = []
  let inFiles = false
  let current: { url: string; sha512: string | null } | null = null
  const unquote = (value: string): string => value.trim().replace(/^['"]|['"]$/g, '')
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const item = /^\s+-\s+(\w+):\s*(.*)$/.exec(line)
    const nested = /^\s+(\w+):\s*(.*)$/.exec(line)
    const field = /^(\w+):\s*(.*)$/.exec(line)
    if (inFiles && item !== null) {
      current = { url: '', sha512: null }
      files.push(current)
      if (item[1] === 'url') current.url = unquote(item[2] ?? '')
      if (item[1] === 'sha512') current.sha512 = unquote(item[2] ?? '')
    } else if (inFiles && nested !== null && current !== null) {
      if (nested[1] === 'url') current.url = unquote(nested[2] ?? '')
      if (nested[1] === 'sha512') current.sha512 = unquote(nested[2] ?? '')
    } else if (field !== null) {
      inFiles = field[1] === 'files'
      current = null
      if (!inFiles) top[field[1] ?? ''] = unquote(field[2] ?? '')
    }
  }
  if (files.length === 0 && top['path'] !== undefined) files.push({ url: top['path'], sha512: top['sha512'] ?? null })
  return { version: top['version'] ?? '', files, notes: top['releaseNotes'] ?? null }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'user-agent': 'anticode-updater', accept: 'application/vnd.github+json, */*' }
  })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.text()
}

/** The newest build the source offers for this machine, or null when it has none. */
export async function findLatest(source: UpdateSource, platform: Platform): Promise<UpdateAsset | null> {
  if (source.kind === 'github') {
    // Every release is read and the highest version wins, rather than asking
    // GitHub for "latest": that endpoint skips releases marked as pre-release
    // and ignores the order they were tagged in, so a newer build can sit
    // invisible while the app keeps offering the one it already has.
    const releases = JSON.parse(await fetchText(`https://api.github.com/repos/${source.repo}/releases?per_page=30`)) as {
      tag_name?: string
      draft?: boolean
      body?: string
      assets?: { name: string; browser_download_url: string }[]
    }[]
    let best: UpdateAsset | null = null
    for (const release of releases) {
      if (release.draft === true || typeof release.tag_name !== 'string') continue
      const tag = release.tag_name.replace(/^v/, '')
      const assets = release.assets ?? []
      // The feed the build itself wrote names the file for this platform and
      // carries its checksum, so the version reported and the binary offered
      // always describe the same build, a release that still holds an older
      // installer beside the new one can no longer hand out the wrong one.
      const feedAsset = assets.find((entry) => entry.name === feedName(platform))
      let chosen: { version: string; asset: { name: string; browser_download_url: string }; sha512: string | null } | null = null
      /** GitHub normalises spaces and some punctuation to dots in asset names,
       * while the feed keeps them as the builder wrote them, so the match
       * ignores everything that is not a letter, digit, or dot-delimited
       * version, "anticode-Setup-0.0.32.exe", "anticode.Setup.0.0.32.exe",
       * and "anticode Setup 0.0.32.exe" are one and the same installer. */
      const loose = (value: string): string => value.toLowerCase().replace(/[-_. ]+/g, '.')
      if (feedAsset !== undefined) {
        try {
          const feed = parseFeed(await fetchText(feedAsset.browser_download_url))
          const picked = pickAssetName(feed.files.map((file) => path.basename(file.url)), platform)
          const file = feed.files.find((entry) => path.basename(entry.url) === picked)
          let upload = file === undefined ? undefined : assets.find((entry) => entry.name === path.basename(file.url))
          if (file !== undefined && upload === undefined) {
            const wanted = loose(path.basename(file.url))
            upload = assets.find((entry) => loose(entry.name) === wanted)
          }
          if (feed.version !== '' && file !== undefined && upload !== undefined) {
            chosen = { version: feed.version, asset: upload, sha512: file.sha512 }
          }
        } catch { /* A release with no readable feed falls back to asset names. */ }
      }
      if (chosen === null) {
        // Only assets whose own name carries this tag's version: a stale build
        // in the same release is skipped rather than picked by list order.
        const named = assets.filter((entry) => BUILD_NAME.exec(entry.name)?.[1] === tag)
        const picked = pickAssetName(named.map((entry) => entry.name), platform)
        const upload = named.find((entry) => entry.name === picked)
        if (upload !== undefined) chosen = { version: tag, asset: upload, sha512: null }
      }
      if (chosen === null) continue
      if (best !== null && compareVersions(chosen.version, best.version) <= 0) continue
      best = { version: chosen.version, location: chosen.asset.browser_download_url, name: chosen.asset.name, sha512: chosen.sha512, notes: release.body ?? null }
    }
    return best
  }

  if (source.kind === 'feed') {
    const feedUrl = /\.(ya?ml)$/i.test(new URL(source.url).pathname)
      ? source.url
      : new URL(feedName(platform), source.url.endsWith('/') ? source.url : `${source.url}/`).toString()
    const feed = parseFeed(await fetchText(feedUrl))
    const name = pickAssetName(feed.files.map((file) => file.url), platform)
    const file = feed.files.find((entry) => entry.url === name)
    if (file === undefined || feed.version === '') return null
    return { version: feed.version, location: new URL(file.url, feedUrl).toString(), name: path.basename(file.url), sha512: file.sha512, notes: feed.notes }
  }

  // A folder: electron-builder names builds `<product>-<version>-<arch>.<ext>`.
  const names = await readdir(source.path)
  let best: UpdateAsset | null = null
  const versions = new Map<string, string[]>()
  for (const name of names) {
    const version = BUILD_NAME.exec(name)?.[1]
    if (version !== undefined) versions.set(version, [...(versions.get(version) ?? []), name])
  }
  for (const [version, candidates] of versions) {
    const name = pickAssetName(candidates, platform)
    if (name === null || (best !== null && compareVersions(version, best.version) <= 0)) continue
    best = { version, location: path.join(source.path, name), name, sha512: null, notes: null }
  }
  if (best !== null && names.includes(feedName(platform))) {
    try {
      const feed = parseFeed(await readFile(path.join(source.path, feedName(platform)), 'utf8'))
      if (feed.version === best.version) best.sha512 = feed.files.find((file) => file.url === best?.name)?.sha512 ?? null
    } catch { /* No checksum to check against. */ }
  }
  return best
}

export async function sha512Of(file: string): Promise<string> {
  const hash = createHash('sha512')
  await pipeline(createReadStream(file), hash)
  return hash.digest('base64')
}

/** Brings the build into `directory`, reporting progress from 0 to 1. */
export async function download(asset: UpdateAsset, directory: string, onProgress: (fraction: number) => void): Promise<string> {
  await mkdir(directory, { recursive: true })
  const target = path.join(directory, asset.name)
  await rm(target, { force: true })
  if (!/^https?:\/\//.test(asset.location)) {
    await copyFile(asset.location, target)
    onProgress(1)
  } else {
    const response = await fetch(asset.location, { headers: { 'user-agent': 'anticode-updater' } })
    if (!response.ok || response.body === null) throw new Error(`The download answered ${response.status}`)
    const total = Number(response.headers.get('content-length') ?? 0)
    let received = 0
    const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
    body.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (total > 0) onProgress(Math.min(1, received / total))
    })
    await pipeline(body, createWriteStream(target))
    onProgress(1)
  }
  if (asset.sha512 !== null && (await sha512Of(target)) !== asset.sha512) {
    await rm(target, { force: true })
    throw new Error('The download does not match its checksum; it was discarded')
  }
  return target
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 120_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  })
}

async function findApp(directory: string): Promise<string> {
  const found = (await readdir(directory)).find((name) => name.endsWith('.app'))
  if (found === undefined) throw new Error('The update has no app inside it')
  return path.join(directory, found)
}

/**
 * The script that swaps the app once it has quit: the old bundle is moved
 * aside, the new one copied in, and the old one put back if the copy fails.
 */
export function macSwapScript(pid: number, staged: string, target: string): string {
  const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
  return [
    '#!/bin/sh',
    `while kill -0 ${pid} 2>/dev/null; do sleep 0.3; done`,
    `rm -rf ${quote(`${target}.old`)}`,
    `if mv ${quote(target)} ${quote(`${target}.old`)} && ditto ${quote(staged)} ${quote(target)}; then`,
    `  rm -rf ${quote(`${target}.old`)}`,
    'else',
    `  rm -rf ${quote(target)}; mv ${quote(`${target}.old`)} ${quote(target)}`,
    'fi',
    `xattr -dr com.apple.quarantine ${quote(target)} 2>/dev/null`,
    `open ${quote(target)}`,
    `rm -rf ${quote(staged)}`,
    ''
  ].join('\n')
}

/**
 * Prepares the downloaded build and starts the helper that swaps it in after
 * the app quits. The caller quits right after; nothing here restarts itself.
 */
export async function install(file: string, exePath: string, workDirectory: string, platform: Platform, pid: number): Promise<void> {
  if (platform.os === 'darwin') {
    const target = path.resolve(exePath, '../../..')
    if (!target.endsWith('.app')) throw new Error('This copy of anticode is not an app bundle, so it cannot replace itself')
    await access(path.dirname(target), constants.W_OK).catch(() => {
      throw new Error(`anticode cannot write to ${path.dirname(target)}; move the app somewhere it can, such as /Applications`)
    })
    const unpacked = path.join(workDirectory, 'unpacked')
    // Node's own rm chokes with ENOTEMPTY on the macOS bundles that carry
    // extended attributes and resource forks, so the system rm is used for
    // the recursive delete; a failed retry is still an error worth reporting.
    await run('rm', ['-rf', unpacked])
    await mkdir(unpacked, { recursive: true })
    if (file.toLowerCase().endsWith('.zip')) {
      await run('ditto', ['-x', '-k', file, unpacked])
    } else {
      const mount = path.join(workDirectory, 'mount')
      await mkdir(mount, { recursive: true })
      await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, file])
      try {
        await run('ditto', [await findApp(mount), path.join(unpacked, path.basename(target))])
      } finally {
        await run('hdiutil', ['detach', mount, '-force']).catch(() => undefined)
      }
    }
    const staged = await findApp(unpacked)
    const script = path.join(workDirectory, 'swap.sh')
    await writeFile(script, macSwapScript(pid, staged, target), { mode: 0o755 })
    spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  if (platform.os === 'win32') {
    // The NSIS installer replaces the app itself; --force-run starts it after.
    spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  const appImage = process.env['APPIMAGE']
  if (appImage === undefined) throw new Error('Only the AppImage build can replace itself on Linux')
  const script = path.join(workDirectory, 'swap.sh')
  const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
  await writeFile(
    script,
    `#!/bin/sh\nwhile kill -0 ${pid} 2>/dev/null; do sleep 0.3; done\ncp ${quote(file)} ${quote(appImage)} && chmod +x ${quote(appImage)}\n${quote(appImage)} &\n`,
    { mode: 0o755 }
  )
  spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref()
}

/** Whether a file exists and is not empty, for a build downloaded earlier. */
export async function present(file: string): Promise<boolean> {
  return (await stat(file).catch(() => null))?.isFile() === true
}

export type { UpdateSettings, UpdateState }
