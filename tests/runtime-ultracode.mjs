import assert from 'node:assert/strict'
import { access, cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const runtimeRoot = process.env.DSH_RUNTIME_ROOT
if (runtimeRoot === undefined || runtimeRoot.trim() === '') {
  console.log('SKIP: set DSH_RUNTIME_ROOT to the extracted DSH app node_modules directory.')
  process.exit(0)
}

const WORKSPACE = fileURLToPath(new URL('../../..', import.meta.url))
const ULTRA_ROOT = join(WORKSPACE, 'packages/dsh-ultracode')
const SKILLS_ROOT = join(WORKSPACE, 'packages/dsh-mattpocock-skills')
for (const root of [ULTRA_ROOT, SKILLS_ROOT]) {
  try {
    await access(join(root, 'lib/index.js'))
  } catch {
    console.error('Build both packages first: npm run build')
    process.exit(1)
  }
}

const RUNTIME = pathToFileURL(runtimeRoot.endsWith('/') || runtimeRoot.endsWith('\\') ? runtimeRoot : `${runtimeRoot}/`)
const ULTRA_COPY = 'dsh-ultracode-runtime-test'
const SKILLS_COPY = 'dsh-mattpocock-skills-runtime-test'
const ULTRA_COPY_ROOT = join(runtimeRoot, ULTRA_COPY)
const SKILLS_COPY_ROOT = join(runtimeRoot, SKILLS_COPY)

async function copyPackage(source, target, extra = []) {
  await rm(target, { recursive: true, force: true })
  await cp(join(source, 'lib'), join(target, 'lib'), { recursive: true })
  for (const file of ['package.json', 'cordis.patch.yml', ...extra]) {
    await cp(join(source, file), join(target, file))
  }
}

await copyPackage(ULTRA_ROOT, ULTRA_COPY_ROOT)
await copyPackage(SKILLS_ROOT, SKILLS_COPY_ROOT, ['skills.manifest.json', 'skills.lock.json'])
await cp(join(SKILLS_ROOT, 'skills'), join(SKILLS_COPY_ROOT, 'skills'), { recursive: true })

const pkg = path => new URL(`@deepseek-ai/${path}`, RUNTIME).href

const { Context } = await import(pkg('cordis/lib/index.js'))
const llm = await import(pkg('dsh-llm/lib/index.js'))
const { SessionId } = await import(pkg('dsh-session/lib/index.js'))
const { default: Session } = await import(pkg('dsh-session/lib/index.js'))
const { default: SystemPrompt } = await import(pkg('dsh-system-prompt/lib/index.js'))
const { default: ToolRuntime, defineTool } = await import(pkg('dsh-tools/lib/index.js'))
const { default: AgentRegistry } = await import(pkg('dsh-agent/lib/index.js'))
const { default: AgentLoop } = await import(pkg('dsh-agent-loop/lib/index.js'))
const { default: SessionProjectionRegistry } = await import(pkg('dsh-session-projection/lib/index.js'))
const { default: SkillRegistry } = await import(pkg('dsh-skill/lib/index.js'))
const { default: CommandRuntime } = await import(pkg('dsh-commands/lib/index.js'))
const { default: WorkingDirectoryService } = await import(pkg('dsh-working-directory/lib/index.js'))
const { default: LocalFileSystem } = await import(pkg('dsh-fs-local/lib/index.js'))
const toolSkill = await import(pkg('dsh-tool-skill/lib/index.js'))
const ultraPlugin = await import(new URL(`${ULTRA_COPY}/lib/index.js`, RUNTIME).href)
const skillsPlugin = await import(new URL(`${SKILLS_COPY}/lib/index.js`, RUNTIME).href)

const { LlmAdapter, LlmRuntime, ToolCallId, createUserMessage } = llm

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, char => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(rawCallId, name, args, text) {
  const callId = ToolCallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  const chunks = []
  let index = 0
  if (text) {
    chunks.push(
      { type: 'block-start', index, blockType: 'text' },
      { type: 'text-delta', index, text },
      { type: 'block-end', index, block: { type: 'text', text } },
    )
    index += 1
  }
  chunks.push(
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id: callId, name, argumentsDelta: argumentsJson.slice(0, 5) },
    { type: 'tool-call-delta', index, id: callId, name, argumentsDelta: argumentsJson.slice(5) },
    { type: 'block-end', index, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

class MockAdapter extends LlmAdapter {
  requests = []
  constructor(script) {
    super()
    this.script = script
  }
  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off' },
          { id: 'low', name: 'Low' },
          { id: 'high', name: 'High' },
          { id: 'max', name: 'Max' },
        ],
        defaultEffort: 'high',
      },
    }
  }
  async *stream(options) {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('MockAdapter: script exhausted')
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

function createWaitTool() {
  let startedResolve
  let releaseResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  const released = new Promise(resolve => { releaseResolve = resolve })
  const tool = defineTool({
    name: 'wait_tool',
    description: 'Wait until the test releases this tool.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true } },
      },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    async execute() {
      startedResolve()
      await released
      return { ok: true }
    },
  })
  return { tool, started, release: () => releaseResolve() }
}

function createWorkflowTool() {
  const calls = []
  const tool = defineTool({
    name: 'workflow',
    description: 'Fake DSH workflow tool used to observe a substantive workflow call.',
    parameters: {
      script: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true } },
      },
      render: () => [{ type: 'text', text: 'workflow complete' }],
    },
    async execute(args) {
      calls.push(args)
      return { ok: true }
    },
  })
  return { tool, calls }
}

let sessionSeq = 0
const tempDir = await mkdtemp(join(tmpdir(), 'dsh-ultracode-v2-'))

async function createHarness(script, options = {}) {
  const adapter = new MockAdapter(script)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Session)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(WorkingDirectoryService, { defaultDirectory: tempDir })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.plugins !== 'skills') await ctx.plugin(ultraPlugin, options.pluginConfig ?? {})
  if (options.plugins !== 'ultra') await ctx.plugin(skillsPlugin)

  const wait = options.waitTool === true ? createWaitTool() : undefined
  if (wait !== undefined) ctx.tools.register(wait.tool)
  const workflow = options.workflowTool === true ? createWorkflowTool() : undefined
  if (workflow !== undefined) ctx.tools.register(workflow.tool)

  ctx.llm.registerAdapter(['deepseek-official'], adapter)
  const handle = await ctx.agents.create({
    sessionId: SessionId(`ultracode-v2-${sessionSeq += 1}`),
    agentOptions: { provider: 'deepseek-official', model: 'mock' },
    setup: async agentCtx => {
      await agentCtx.plugin(toolSkill)
      if (options.requestUltra === true) {
        agentCtx.on('agent/request', async (_payload, next) => ({
          ...await next(),
          reasoningEffort: 'ultra',
        }))
      }
    },
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  return { ctx, adapter, agent: handle.agent, handle, wait, workflow }
}

function user(text) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function withTimeout(promise, label) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), 20_000))
  return Promise.race([promise, timeout])
}

function runPhases(agent) {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'autopilot/run')
    .map(event => event.data.phase)
}

function assertCacheStable(firstRequest, secondRequest, events) {
  assert.equal(firstRequest.provider, secondRequest.provider, 'provider must stay stable')
  assert.equal(firstRequest.model, secondRequest.model, 'model must stay stable')
  assert.equal(firstRequest.reasoningEffort, secondRequest.reasoningEffort, 'effort must stay stable')
  assert.deepEqual(firstRequest.tools, secondRequest.tools, 'tool declarations must be byte-stable')
  assert.equal(
    JSON.stringify(firstRequest.messages[0]),
    JSON.stringify(secondRequest.messages[0]),
    'the leading system message must stay byte-stable',
  )
  assert.deepEqual(
    secondRequest.messages.slice(0, firstRequest.messages.length),
    firstRequest.messages,
    'the first request messages must be a strict prefix of the second request',
  )
  assert.ok(secondRequest.messages.length > firstRequest.messages.length, 'the second request must append only')
  assert.ok(
    events.filter(event => event.type === 'system/message').length <= 1,
    'the plugin must not append a system message during continuation',
  )
  assert.ok(
    events
      .filter(event => event.type === 'request/header')
      .every(event => event.data.reason !== 'series' && event.data.startsSeries !== true),
    'the plugin must not start a new request series',
  )
}

async function scenarioTdd() {
  const h = await createHarness([
    textResponse('I will stop here.'),
    toolCallResponse('call-tdd', 'complete_run', { summary: 'tdd autopilot complete' }, 'Completing the run.'),
  ])
  try {
    h.agent.followup(user('/tdd'))
    await withTimeout(h.agent.whenIdle(), 'tdd scenario')
    assert.equal(h.adapter.requests.length, 2, 'the model should be asked twice')
    const second = JSON.stringify(h.adapter.requests[1].messages)
    assert.ok(second.includes('autopilot_continue'), 'the second request should carry the continuation nudge')
    assert.ok(second.includes('/tdd'), 'the second request should retain the skill invocation')
    assertCacheStable(h.adapter.requests[0], h.adapter.requests[1], h.agent.session.snapshotEvents())
    const phases = runPhases(h.agent)
    assert.ok(phases.includes('running'))
    assert.ok(phases.includes('completed'), `tdd run should complete; phases: ${phases.join(', ')}`)
    return { scenario: 'tdd', requests: h.adapter.requests.length, phases }
  } finally {
    await h.handle.dispose()
  }
}

async function scenarioUltra() {
  const h = await createHarness([
    textResponse('Ultra report.'),
    textResponse('Ultra follow-up.'),
  ], { requestUltra: true })
  try {
    ;(h.agent.session).append('model/selection', {
      provider: 'deepseek-official',
      model: 'mock',
      reasoningEffort: 'ultra',
    })
    h.agent.followup(user('audit the repository'))
    await withTimeout(h.agent.whenIdle(), 'ultra first turn')
    assert.equal(h.adapter.requests.length, 1, 'Ultra must not force a continuation')
    assert.equal(h.adapter.requests[0].reasoningEffort, 'max', 'the wire effort must be max')
    const first = JSON.stringify(h.adapter.requests[0].messages)
    assert.ok(first.includes('[ultracode:standing]'), 'the first request should carry the standing playbook')
    assert.ok(first.includes('audit the repository'), 'the first request should carry the task')
    assert.equal(runPhases(h.agent).length, 0, 'selector Ultra must not create an autopilot run')

    h.agent.followup(user('continue the audit'))
    await withTimeout(h.agent.whenIdle(), 'ultra second turn')
    assert.equal(h.adapter.requests.length, 2, 'the second turn should be a normal turn')
    const second = JSON.stringify(h.adapter.requests[1].messages)
    assert.ok(second.includes('[ultracode:reminder:2]'), 'the second turn should carry the compact reminder')
    assert.ok(!second.includes('autopilot_continue'), 'Ultra must not append an autopilot nudge')
    assertCacheStable(h.adapter.requests[0], h.adapter.requests[1], h.agent.session.snapshotEvents())
    return { scenario: 'ultra', requests: h.adapter.requests.length, phases: runPhases(h.agent) }
  } finally {
    await h.handle.dispose()
  }
}

async function scenarioSteer() {
  const h = await createHarness([
    toolCallResponse('call-wait', 'wait_tool', {}, 'Waiting.'),
    toolCallResponse('call-complete', 'complete_run', { summary: 'steer complete' }, 'Completing.'),
  ], { waitTool: true })
  try {
    h.agent.followup(user('/tdd'))
    await withTimeout(h.wait.started, 'wait tool start')
    h.agent.steer(user('adjust direction'))
    h.wait.release()
    await withTimeout(h.agent.whenIdle(), 'steer scenario')
    assert.equal(h.adapter.requests.length, 2, 'steering should stay inside the turn')
    const second = JSON.stringify(h.adapter.requests[1].messages)
    assert.ok(second.includes('adjust direction'), 'the steered message must reach the next model call')
    assert.ok(!second.includes('autopilot_continue'), 'no autopilot nudge may preempt the steer')
    assertCacheStable(h.adapter.requests[0], h.adapter.requests[1], h.agent.session.snapshotEvents())
    return { scenario: 'steer', requests: h.adapter.requests.length }
  } finally {
    await h.handle.dispose()
  }
}

async function scenarioPauseResume() {
  const h = await createHarness([
    toolCallResponse('call-wait', 'wait_tool', {}, 'Waiting.'),
    textResponse('Resumed.'),
  ], { waitTool: true })
  try {
    h.agent.followup(user('do a task'))
    await withTimeout(h.wait.started, 'pause wait start')
    const pause = await h.ctx.commands.execute(h.agent, '/pause', [], new AbortController().signal)
    assert.ok(pause, 'the pause command should be registered')
    h.wait.release()
    await withTimeout(h.agent.whenIdle(), 'pause settle')
    const pauseEvents = h.agent.session.snapshotEvents().filter(event => event.type === 'ultracode/pause')
    assert.ok(pauseEvents.some(event => event.data.paused === true), 'the session should be paused')
    assert.ok(!runPhases(h.agent).length, 'the normal turn should not create a run')

    const resume = await h.ctx.commands.execute(h.agent, '/resume', [], new AbortController().signal)
    assert.ok(resume, 'the resume command should be registered')
    await withTimeout(h.agent.whenIdle(), 'resume settle')
    assert.equal(h.adapter.requests.length, 2, 'resume should start one new turn')
    assert.ok(
      JSON.stringify(h.adapter.requests[1].messages).includes('ultracode_resume'),
      'a normal paused session should receive the generic resume prompt',
    )
    assertCacheStable(h.adapter.requests[0], h.adapter.requests[1], h.agent.session.snapshotEvents())
    const cleared = h.agent.session.snapshotEvents()
      .filter(event => event.type === 'ultracode/pause')
      .at(-1)
    assert.equal(cleared?.data.paused, false, 'resume should clear the durable pause')
    return { scenario: 'pause-resume', requests: h.adapter.requests.length }
  } finally {
    await h.handle.dispose()
  }
}

async function scenarioUltraWorkflow() {
  const h = await createHarness([
    toolCallResponse('call-workflow', 'workflow', { script: 'return { ok: true }' }, 'Planning.'),
    textResponse('Workflow report.'),
  ], { requestUltra: true, workflowTool: true })
  try {
    ;(h.agent.session).append('model/selection', {
      provider: 'deepseek-official',
      model: 'mock',
      reasoningEffort: 'ultra',
    })
    h.agent.followup(user('audit the repository'))
    await withTimeout(h.agent.whenIdle(), 'ultra workflow scenario')
    assert.equal(h.workflow.calls.length, 1, 'the substantive task should call the workflow tool')
    assert.equal(h.adapter.requests.length, 2, 'a workflow tool call should continue the same turn')
    assert.ok(JSON.stringify(h.adapter.requests[0].messages).includes('[ultracode:standing]'))
    assert.equal(runPhases(h.agent).length, 0, 'Ultra must not create an autopilot run')
    assertCacheStable(h.adapter.requests[0], h.adapter.requests[1], h.agent.session.snapshotEvents())
    return { scenario: 'ultra-workflow', requests: h.adapter.requests.length, workflowCalls: h.workflow.calls.length }
  } finally {
    await h.handle.dispose()
  }
}

async function scenarioQuestion() {
  const h = await createHarness([
    textResponse('Which file should I change?'),
    toolCallResponse('call-question', 'complete_run', { summary: 'question answered' }, 'Completing.'),
  ])
  try {
    h.agent.followup(user('/tdd'))
    await withTimeout(h.agent.whenIdle(), 'question first stop')
    assert.ok(runPhases(h.agent).includes('waiting_user'), 'the run should wait for the user')
    assert.ok(!h.agent.session.snapshotEvents().some(event => event.type === 'ultracode/pause' && event.data.paused === true), 'a question is not the play-button pause')

    h.agent.followup(user('Change src/example.ts'))
    await withTimeout(h.agent.whenIdle(), 'question answer')
    assert.ok(runPhases(h.agent).includes('completed'), 'the answer should resume and complete the run')
    return { scenario: 'question', requests: h.adapter.requests.length, phases: runPhases(h.agent) }
  } finally {
    await h.handle.dispose()
  }
}

async function scenarioAutopilotPause() {
  const h = await createHarness([
    toolCallResponse('call-wait', 'wait_tool', {}, 'Waiting.'),
    toolCallResponse('call-complete', 'complete_run', { summary: 'pause resume complete' }, 'Completing.'),
  ], { waitTool: true })
  try {
    h.agent.followup(user('/tdd'))
    await withTimeout(h.wait.started, 'autopilot pause wait start')
    const paused = await h.ctx.commands.execute(h.agent, '/pause', [], new AbortController().signal)
    assert.ok(paused, 'the pause command should be registered')
    h.wait.release()
    await withTimeout(h.agent.whenIdle(), 'autopilot pause settle')
    assert.ok(runPhases(h.agent).includes('paused_user'), 'the run should be paused_user')
    assert.ok(h.agent.session.snapshotEvents().some(event => event.type === 'ultracode/pause' && event.data.paused === true))

    const resumed = await h.ctx.commands.execute(h.agent, '/resume', [], new AbortController().signal)
    assert.ok(resumed, 'the resume command should be registered')
    await withTimeout(h.agent.whenIdle(), 'autopilot resume settle')
    assert.ok(runPhases(h.agent).includes('completed'), 'the resumed run should complete')
    assert.ok(JSON.stringify(h.adapter.requests.at(-1)?.messages).includes('autopilot_continue'))
    return { scenario: 'autopilot-pause', requests: h.adapter.requests.length, phases: runPhases(h.agent) }
  } finally {
    await h.handle.dispose()
  }
}

async function scenarioRoundCap() {
  const h = await createHarness([
    textResponse('I will stop here.'),
    textResponse('I will stop again.'),
    textResponse('Final report.'),
  ], { pluginConfig: { maxRounds: 2 } })
  try {
    h.agent.followup(user('/tdd'))
    await withTimeout(h.agent.whenIdle(), 'round cap scenario')
    assert.equal(h.adapter.requests.length, 3, 'the round cap should allow one continuation and one wrap-up')
    assert.ok(runPhases(h.agent).includes('exhausted'))
    assert.ok(JSON.stringify(h.adapter.requests[2].messages).includes('autopilot_wrap_up'))
    return { scenario: 'round-cap', requests: h.adapter.requests.length, phases: runPhases(h.agent) }
  } finally {
    await h.handle.dispose()
  }
}

async function scenarioIndependentInstall() {
  const skillsOnly = await createHarness([], { plugins: 'skills' })
  try {
    const cwd = await skillsOnly.ctx.workingDirectory.ensure(skillsOnly.agent, new AbortController().signal)
    const skill = await skillsOnly.ctx.skills.get('tdd', { cwd, scope: skillsOnly.agent })
    assert.ok(skill, 'the skills package should provide tdd without ultracode')
    const info = await skillsOnly.ctx.llm.resolveModelInfo('deepseek-official', 'mock')
    assert.ok(!info.reasoning?.efforts.some(effort => effort.id === 'ultra'), 'skills-only must not offer Ultra')
  } finally {
    await skillsOnly.handle.dispose()
  }

  const ultraOnly = await createHarness([], { plugins: 'ultra' })
  try {
    const info = await ultraOnly.ctx.llm.resolveModelInfo('deepseek-official', 'mock')
    assert.ok(info.reasoning?.efforts.some(effort => effort.id === 'ultra'), 'ultracode-only should offer Ultra')
    const cwd = await ultraOnly.ctx.workingDirectory.ensure(ultraOnly.agent, new AbortController().signal)
    const skill = await ultraOnly.ctx.skills.get('tdd', { cwd, scope: ultraOnly.agent })
    assert.equal(skill, undefined, 'ultracode-only must not provide the adapted skills')
    return { scenario: 'independent-install', skillsOnly: true, ultraOnly: true }
  } finally {
    await ultraOnly.handle.dispose()
  }
}

const results = []
for (const scenario of [
  scenarioTdd,
  scenarioUltra,
  scenarioUltraWorkflow,
  scenarioSteer,
  scenarioPauseResume,
  scenarioAutopilotPause,
  scenarioQuestion,
  scenarioRoundCap,
  scenarioIndependentInstall,
]) {
  results.push(await scenario())
}
console.log(JSON.stringify({ ok: true, results }, null, 2))
