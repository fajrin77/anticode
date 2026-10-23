// Builds the mac package and publishes it as a GitHub Release, which is what
// the in-app updater reads. Usage: npm run publish:mac [-- --skip-build]
// Needs a logged-in `gh` (gh auth login). Never reads or stores credentials.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const REPO = 'fajrin77/anticode'
const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` }

function run(command, args, { allowFail = false } = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', env })
  if (result.status !== 0 && !allowFail) {
    console.error(`Failed: ${command} ${args.join(' ')}`)
    process.exit(result.status ?? 1)
  }
  return result.status === 0
}

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const tag = `v${version}`

const dirty = spawnSync('git', ['status', '--porcelain'], { env, encoding: 'utf8' }).stdout.trim()
if (dirty !== '') {
  console.error('Working tree is not clean. Commit first so the release matches the tag.')
  process.exit(1)
}

if (!process.argv.includes('--skip-build')) run('npm', ['run', 'pack:mac'])

const files = [
  `release/anticode-${version}-arm64-mac.zip`,
  `release/anticode-${version}-arm64-mac.zip.blockmap`,
  `release/anticode-${version}-arm64.dmg`,
  `release/anticode-${version}-arm64.dmg.blockmap`,
  'release/latest-mac.yml'
]
const missing = files.filter((file) => !existsSync(file))
if (missing.length > 0) {
  console.error(`Missing build output: ${missing.join(', ')}`)
  process.exit(1)
}
if (!readFileSync('release/latest-mac.yml', 'utf8').includes(`version: ${version}`)) {
  console.error(`release/latest-mac.yml is not for ${version}; rebuild without --skip-build.`)
  process.exit(1)
}

// Tag and commit first, so the release points at pushed code.
run('git', ['push', 'origin', 'HEAD'])
if (spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { env }).status !== 0) run('git', ['tag', tag])
run('git', ['push', 'origin', tag])

const exists = spawnSync('gh', ['release', 'view', tag, '--repo', REPO], { env, stdio: 'ignore' }).status === 0
if (exists) {
  run('gh', ['release', 'upload', tag, ...files, '--clobber', '--repo', REPO])
} else {
  run('gh', ['release', 'create', tag, ...files, '--repo', REPO, '--title', `anticode ${version}`, '--notes', `Release ${version}`])
}
console.log(`Published https://github.com/${REPO}/releases/tag/${tag}`)
