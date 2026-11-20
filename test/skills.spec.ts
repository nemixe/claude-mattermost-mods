import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { routerContext } from '../src/hub/prompts'
import { frontmatter, workerSkills } from '../src/hub/skills'

function skill(dir: string, name: string, head: string) {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), `---\n${head}\n---\n\n# ${name}\n`)
}

describe("the skills a workspace's workers have", () => {
  test('frontmatter: plain, quoted and folded values', () => {
    expect(frontmatter('---\nname: a\ndescription: "Quoted: text"\n---\nbody')).toEqual({ name: 'a', description: 'Quoted: text' })
    expect(frontmatter('---\nname: b\ndescription: >\n  Folded over\n  two lines\nuser-invocable: true\n---\n')).toEqual({ name: 'b', description: 'Folded over two lines', 'user-invocable': 'true' })
    expect(frontmatter('# no frontmatter')).toEqual({})
  })

  test("the machine's and the workspace's, the workspace's winning; never ones only a person may start", () => {
    const root = mkdtempSync(join(tmpdir(), 'mmhub-skills-'))
    const config = join(root, 'config')
    const ws = join(root, 'ws')
    skill(join(config, 'skills'), 'gws-access', 'name: gws-access\ndescription: Open Google Sheets, Docs and Drive as the bot\'s Google account.')
    skill(join(config, 'skills'), 'deploy', 'name: deploy\ndescription: The machine-wide deploy.')
    skill(join(config, 'skills'), 'handoff', 'name: handoff\ndescription: Only by hand.\ndisable-model-invocation: true')
    mkdirSync(join(config, 'skills', 'empty'))
    skill(join(ws, '.claude', 'skills'), 'deploy', 'name: deploy\ndescription: This workspace\'s deploy.')
    expect(workerSkills({ dir: ws }, config)).toEqual([
      { name: 'deploy', description: "This workspace's deploy." },
      { name: 'gws-access', description: "Open Google Sheets, Docs and Drive as the bot's Google account." },
    ])
    expect(workerSkills({ dir: join(root, 'none') }, join(root, 'none'))).toEqual([])
  })

  test("a router's context says what workers can do, with their skills", () => {
    const w = { name: 'demo', dir: '/ws/demo', description: '', repos: [] } as unknown as Parameters<typeof routerContext>[0]
    const ctx = routerContext(w, {
      threadId: 'T1', permalink: 'http://mm/pl/T1', workers: [], persona: 'p', reports: 'router',
      skills: [{ name: 'gws-access', description: "Open Google Sheets as the bot's Google account." }],
    })
    expect(ctx).toContain('What workers can do that you can\'t: you only read Mattermost and the files here, with no logins.')
    expect(ctx).toContain('Never decide from your own try that a link, file or service is out of reach')
    expect(ctx).toContain("- gws-access: Open Google Sheets as the bot's Google account.")
    expect(routerContext(w, { threadId: 'T1', permalink: '', workers: [], persona: 'p', reports: 'router' })).toContain('Skills workers have (the bot\'s accounts and access come with them):\n- (none)')
  })
})
