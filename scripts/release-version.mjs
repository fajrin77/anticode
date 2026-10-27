import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Builders normalize numeric components; keep public display/file versions. */
export function normalizeReleaseArtifacts(version, directory = 'release') {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a numeric dotted release version')
  const normalized = version.split('.').map(Number).join('.')
  const feed = path.join(directory, 'latest-mac.yml')
  let yaml = readFileSync(feed, 'utf8')
  const actual = /^version:\s*([^\r\n]+)$/m.exec(yaml)?.[1]?.trim()
  if (actual !== version && actual !== normalized) throw new Error(`Build feed ${actual} does not match ${version}`)
  const suffixes = ['-arm64-mac.zip', '-arm64-mac.zip.blockmap', '-arm64.dmg', '-arm64.dmg.blockmap']
  // Resolve every source before changing files, preventing partial renames.
  const sources = suffixes.map(suffix => {
    const target = path.join(directory, `anticode-${version}${suffix}`)
    const source = actual === normalized && normalized !== version
      ? path.join(directory, `anticode-${normalized}${suffix}`) : target
    if (!existsSync(source)) throw new Error(`Missing build output: ${source}`)
    return { source, target }
  })
  for (const { source, target } of sources) if (source !== target) renameSync(source, target)
  yaml = yaml.replace(/^version:.*$/m, `version: ${version}`)
    .replaceAll(`anticode-${normalized}-arm64`, `anticode-${version}-arm64`)
  writeFileSync(feed, yaml)
}
