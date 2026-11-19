import { describe, expect, test } from 'bun:test'
import { agentIn, commandsOf } from '../src/hub/agents'
import { DEFAULT_CONFIG } from '../src/hub/config'

const agents = DEFAULT_CONFIG.otherAgents

describe('reading a command line for another agent', () => {
  test('commands of a line: lists, pipelines, subshells, quotes', () => {
    expect(commandsOf(`cd /x && FOO=1 hermes chat -q "a; b" | tee out; echo 'c && d'`)).toEqual([
      ['cd', '/x'], ['FOO=1', 'hermes', 'chat', '-q', 'a; b'], ['tee', 'out'], ['echo', 'c && d'],
    ])
    expect(commandsOf('echo $(codex exec "x")')).toEqual([['echo'], ['codex', 'exec', 'x']])
  })

  test.each([
    ['hermes chat -q "fix the login bug"', 'hermes'],
    ['nohup hermes chat -q "fix it" > /tmp/h.log 2>&1 &', 'hermes'],
    ['cd repo && ~/.local/bin/hermes chat -q "x"', 'hermes'],
    ['HERMES_HOME=~/.hermes timeout 600 hermes chat', 'hermes'],
    ['bash -lc "hermes chat -q \'review this\'"', 'hermes'],
    ["eval 'codex exec \"do it\"'", 'codex'],
    ["tmux new-session -d -s bg 'hermes chat -q x'", 'hermes'],
    ['npx @openai/codex@latest exec "x"', 'codex'],
    ['uv run hermes chat', 'hermes'],
    ['echo "$(gemini -p summarise)"', 'gemini'],
    ['/opt/homebrew/bin/opencode run "x"', 'opencode'],
  ])('runs an agent: %s', (line, agent) => {
    expect(agentIn(line, agents)).toBe(agent)
  })

  test.each([
    'git commit -m "hermes support"',
    'echo "ask hermes later"',
    'grep -rn hermes src/',
    'cat ~/.hermes/config.yaml',
    'npm test',
    'ls -la | head',
    'docker compose up -d',
  ])('runs no agent: %s', line => {
    expect(agentIn(line, agents)).toBeUndefined()
  })

  test('an empty list allows them all', () => {
    expect(agentIn('hermes chat', [])).toBeUndefined()
  })
})
