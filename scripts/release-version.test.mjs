import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeReleaseArtifacts } from './release-version.mjs'

test('normalizes build artifacts to padded public versions, preserving hashes and contents', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'anticode-release-test-'))
  try {
    for (const suffix of ['-arm64-mac.zip', '-arm64-mac.zip.blockmap', '-arm64.dmg', '-arm64.dmg.blockmap']) {
      writeFileSync(path.join(dir, `anticode-0.1.8${suffix}`), 'unchanged')
    }
    writeFileSync(path.join(dir, 'latest-mac.yml'), 'version: 0.1.8\npath: anticode-0.1.8-arm64-mac.zip\nsha512: unchanged-hash\n')
    normalizeReleaseArtifacts('0.1.08', dir)
    normalizeReleaseArtifacts('0.1.08', dir)
    assert.ok(existsSync(path.join(dir, 'anticode-0.1.08-arm64.dmg')))
    assert.equal(readFileSync(path.join(dir, 'anticode-0.1.08-arm64-mac.zip'), 'utf8'), 'unchanged')
    assert.match(readFileSync(path.join(dir, 'latest-mac.yml'), 'utf8'), /version: 0\.1\.08\npath: anticode-0\.1\.08-arm64-mac.zip\nsha512: unchanged-hash/)
    assert.throws(() => normalizeReleaseArtifacts('0.1.09', dir), /does not match/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
