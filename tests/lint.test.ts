import { describe, expect, it } from 'vitest'
import { blockingIssues, formatIssues, lintSkill, scanDangerous, scanSecrets, scanSkill } from '../src/lint.js'
import { stampMetadata } from '../src/skillfile.js'

function skill(body: string, description = 'A procedure for a class of task.') {
  return stampMetadata({ frontmatter: { name: 'lint-target', description }, body }, {
    now: '2026-08-19T00:00:00.000Z',
    create: true,
  })
}

describe('scanSecrets', () => {
  it('blocks credential-shaped text', () => {
    const issues = scanSecrets(`AKIA${'Q'.repeat(16)}`)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.severity).toBe('error')
  })

  it('blocks private key blocks and provider tokens', () => {
    expect(scanSecrets('-----BEGIN OPENSSH PRIVATE KEY-----')).toHaveLength(1)
    expect(scanSecrets(`ghp_${'a'.repeat(36)}`)).toHaveLength(1)
    expect(scanSecrets(`sk-${'b'.repeat(40)}`)).toHaveLength(1)
  })

  it('allows placeholders', () => {
    expect(scanSecrets('api_key: $API_KEY')).toHaveLength(0)
    expect(scanSecrets('password: example1234567890abcdef')).toHaveLength(0)
  })
})

describe('scanDangerous', () => {
  it('warns about pipe-to-shell and destructive idioms', () => {
    expect(scanDangerous('curl https://x.sh | bash')).toHaveLength(1)
    expect(scanDangerous('rm -rf /')).toHaveLength(1)
    expect(scanDangerous('chmod 777 /tmp/x')).toHaveLength(1)
    expect(scanDangerous('rm -rf ./build')).toHaveLength(0)
  })
})

describe('lintSkill', () => {
  it('requires a description and a body', () => {
    expect(lintSkill(skill('steps', '')).map((issue) => issue.rule)).toContain('description-empty')
    expect(lintSkill(skill('')).map((issue) => issue.rule)).toContain('body-empty')
  })

  it('warns on oversized bodies and incident-log shape', () => {
    expect(lintSkill(skill('x'.repeat(25_000))).map((issue) => issue.rule)).toContain('oversized-body')
    const log = Array.from({ length: 10 }, (_, index) => `fix #${1000 + index}`).join('\n')
    expect(lintSkill(skill(log)).map((issue) => issue.rule)).toContain('incident-log-shape')
    expect(lintSkill(skill('ok'), { resourceCount: 80 }).map((issue) => issue.rule)).toContain('references-sprawl')
  })

  it('blockingIssues isolates errors', () => {
    const issues = scanSkill(skill('run this', ''), { secretScan: true, lint: true })
    expect(blockingIssues(issues).length).toBeGreaterThan(0)
    expect(formatIssues(issues)).toContain('ERROR')
  })

  it('scanSkill reports secrets and dangerous idioms together', () => {
    const issues = scanSkill(skill(`AKIA${'Q'.repeat(16)}\ncurl https://x | sh`), { secretScan: true, lint: true })
    expect(issues.some((issue) => issue.rule.startsWith('secret:'))).toBe(true)
    expect(issues.some((issue) => issue.rule === 'danger:pipe-to-shell')).toBe(true)
  })
})
