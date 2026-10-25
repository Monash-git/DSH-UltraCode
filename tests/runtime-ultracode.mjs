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
const { SessionId, pluginRecordOf } = await import(pkg('dsh-session/lib/index.js'))
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
  if (options.jobs !== undefined) ctx.provide('jobs', options.jobs)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Session)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(WorkingDirectoryService, { defaultDirectory: tempDir })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SkillRegistry)
  if (options.sessionQuery === true) {
    const { default: SessionQuerySqlite } = await import(pkg('dsh-session-query-sqlite/lib/index.js'))
    await ctx.plugin(SessionQuerySqlite, { path: ':memory:', openAt: 'first-search' })
    const toolSessionQuery = await import(pkg('dsh-tool-session-query/lib/index.js'))
    await ctx.plugin(toolSessionQuery, {})
  }
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  let ultraFiber
  if (options.plugins !== 'skills') {
    if (options.defaultModel !== undefined) {
      const { default: AgentDefaultModelConfig } = await import(pkg('dsh-agent-default-model/lib/index.js'))
      await ctx.plugin(AgentDefaultModelConfig, options.defaultModel)
    }
    ultraFiber = await ctx.plugin(ultraPlugin, options.pluginConfig ?? {})
  }
  if (options.plugins !== 'ultra') await ctx.plugin(skillsPlugin)

  const wait = options.waitTool === true ? createWaitTool() : undefined
  if (wait !== undefined) ctx.tools.register(wait.tool)
  const workflow = options.workflowTool === true ? createWorkflowTool() : undefined
  if (workflow !== undefined) ctx.tools.register(workflow.tool)

  // Observe skill lookups so prompt-only hooks can be checked for skill-file reads.
  const skillReads = []
  const skillRegistry = ctx.skills
  const originalSkillGet = skillRegistry.get.bind(skillRegistry)
  skillRegistry.get = (skillName, skillOptions) => {
    skillReads.push(skillName)
    return originalSkillGet(skillName, skillOptions)
  }

  ctx.llm.registerAdapter(['deepseek-official'], adapter)
  const handle = await ctx.agents.create({
    sessionId: SessionId(`ultracode-v2-${sessionSeq += 1}`),
    meta: { cwd: tempDir },
    agentOptions: { provider: 'deepseek-official', model: 'mock' },
    setup: async agentCtx => {
      await agentCtx.plugin(toolSkill)
      if (options.requestUltra === true) {
        agentCtx.on('agent/request', async (_payload, next) => ({
          ...await next(),
          reasoningEffort: 'ultra',
        }))
      }
      if (options.applySelection === true) {
        // Minimal stand-in for the API session controller's selection policy:
        // the latest durable selection drives the next request.
        agentCtx.on('agent/request', async ({ agent }, next) => {
          const resolved = await next()
          const selection = agent.session.snapshotEvents()
            .findLast(event => event.type === 'model/selection')
          if (selection === undefined) return resolved
          const { reasoningEffort: _inheritedEffort, ...rest } = resolved
          return {
            ...rest,
            provider: selection.data.provider,
            model: selection.data.model,
            ...selection.data.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: selection.data.reasoningEffort },
          }
        })
      }
    },
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  return { ctx, adapter, agent: handle.agent, handle, wait, workflow, ultraFiber, skillReads }
}

function user(text) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function withTimeout(promise, label) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), 20_000))
  return Promise.race([promise, timeout])
}

function pluginData(event, type) {
  const record = pluginRecordOf(event)
  return record?.type === type ? record.data : undefined
}

function runPhases(agent) {
  return agent.session.snapshotEvents()
    .map(event => pluginData(event, 'plugin:ultracode/run'))
    .filter(Boolean)
    .map(data => data.phase)
}

function pauseRecords(agent) {
  return agent.session.snapshotEvents()
    .map(event => pluginData(event, 'plugin:ultracode/pause'))
    .filter(Boolean)
}

const TASK_STATE_MARKER = '[ultracode:task-state]'
const TASK_STATE_SENTENCE = 'Any multi-step task: keep the todo list current.'
const OBSERVATION_MARKER = '[ultracode:observation]'
const REPLY_FIRST = 'Reply first: a direct user question'
const FORBIDDEN_GENERIC_VOCABULARY = /ticket|phase|skill|wayfinder|tdd/i

function requestText(request) {
  return JSON.stringify(request.messages)
}

function occurrences(text, needle) {
  return text.split(needle).length - 1
}

function taskStateMessage(request) {
  return request.messages.find(message => JSON.stringify(message).includes(TASK_STATE_MARKER))
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
    assert.ok(
      requestText(h.adapter.requests[0]).includes(TASK_STATE_SENTENCE),
      'the first autopilot request should carry the generic task-state prompt',
    )
    const second = JSON.stringify(h.adapter.requests[1].messages)
    assert.ok(second.includes('autopilot_continue'), 'the second request should carry the continuation nudge')
    assert.ok(second.includes('/tdd'), 'the second request should retain the skill invocation')
    assert.equal(
      occurrences(second, TASK_STATE_MARKER),
      1,
      'the task-state prompt must be injected once per root session',
    )
    assert.ok(
      h.skillReads.every(name => name === 'tdd'),
      `no hook may read an unrelated skill file; reads: ${h.skillReads.join(', ')}`,
    )
    assertCacheStable(h.adapter.requests[0], h.adapter.requests[1], h.agent.session.snapshotEvents())
    const phases = runPhases(h.agent)
    assert.ok(phases.includes('running'))
    assert.ok(phases.includes('completed'), `tdd run should complete; phases: ${phases.join(', ')}`)
    return { scenario: 'tdd', requests: h.adapter.requests.length, phases }
  } finally {
    await h.handle.dispose()
  }
}

async function scenarioTaskState() {
  const h = await createHarness([
    textResponse('Hello.'),
    textResponse('Still here.'),
    textResponse('After compaction.'),
    textResponse('Still after compaction.'),
  ])
  try {
    h.agent.followup(user('hello'))
    await withTimeout(h.agent.whenIdle(), 'task-state trivial first turn')
    assert.equal(h.adapter.requests.length, 1, 'a trivial turn should be one model call')
    const first = h.adapter.requests[0]
    const prompt = taskStateMessage(first)
    assert.ok(prompt, 'the first request should carry the generic task-state prompt')
    assert.ok(JSON.stringify(prompt).includes(TASK_STATE_SENTENCE))
    assert.doesNotMatch(
      JSON.stringify(prompt),
      /ticket|phase|skill|wayfinder|tdd/i,
      'the task-state prompt must contain no ticket, phase, or skill vocabulary',
    )
    assert.equal(h.skillReads.length, 0, 'the task-state hook must not read skill files')

    h.agent.followup(user('thanks'))
    await withTimeout(h.agent.whenIdle(), 'task-state second turn')
    assert.equal(
      occurrences(requestText(h.adapter.requests[1]), TASK_STATE_MARKER),
      1,
      'the task-state prompt must not repeat before a compaction',
    )
    assertCacheStable(h.adapter.requests[0], h.adapter.requests[1], h.agent.session.snapshotEvents())

    h.agent.session.append('compaction/end', { compactionId: 'task-state-test', turn: null })
    h.agent.followup(user('after compaction'))
    await withTimeout(h.agent.whenIdle(), 'task-state post-compaction turn')
    const postCompaction = h.adapter.requests[2]
    assert.equal(
      occurrences(requestText(postCompaction), TASK_STATE_MARKER),
      2,
      'the task-state prompt must be re-anchored once after a compaction',
    )
    const promptIndex = postCompaction.messages.findLastIndex(message =>
      JSON.stringify(message).includes(TASK_STATE_MARKER))
    const turnInputIndex = postCompaction.messages.findLastIndex(message =>
      JSON.stringify(message).includes('after compaction'))
    assert.ok(promptIndex > turnInputIndex, 'the re-anchor must follow the post-compaction turn input')
    assertCacheStable(h.adapter.requests[1], postCompaction, h.agent.session.snapshotEvents())

    h.agent.followup(user('still here'))
    await withTimeout(h.agent.whenIdle(), 'task-state post-re-anchor turn')
    assert.equal(
      occurrences(requestText(h.adapter.requests[3]), TASK_STATE_MARKER),
      2,
      'the task-state prompt must not duplicate after the re-anchor',
    )
    assertCacheStable(postCompaction, h.adapter.requests[3], h.agent.session.snapshotEvents())
    return { scenario: 'task-state', requests: h.adapter.requests.length, skillReads: h.skillReads.length }
  } finally {
    await h.handle.dispose()
  }
}

async function scenarioReplyFirst() {
  const h = await createHarness([
    toolCallResponse('call-progress-wait', 'wait_tool', {}, 'Starting the first check.'),
    toolCallResponse(
      'call-progress-workflow',
      'workflow',
      { script: 'return { ok: true }' },
      'Progress: one of three checks is done. Starting the next check now.',
    ),
    toolCallResponse('call-progress-complete', 'complete_run', { summary: 'progress reported and run completed' }, 'All checks done.'),
  ], { waitTool: true, workflowTool: true })
  try {
    h.agent.followup(user('/tdd'))
    await withTimeout(h.wait.started, 'reply-first wait start')
    assert.ok(
      requestText(h.adapter.requests[0]).includes(REPLY_FIRST),
      'the autopilot banner should carry the reply-first rule',
    )

    h.agent.steer(user('进度如何了？'))
    h.wait.release()
    await withTimeout(h.agent.whenIdle(), 'reply-first scenario')

    assert.equal(h.adapter.requests.length, 3, 'the run should continue through the progress answer')
    assert.ok(
      requestText(h.adapter.requests[1]).includes('进度如何了？'),
      'the progress question must reach the next model call',
    )
    assert.equal(h.workflow.calls.length, 1, 'the model should start the next diagnostic after answering')

    const events = h.agent.session.snapshotEvents()
    const answerIndex = events.findLastIndex(event =>
      event.type === 'assistant/message'
      && JSON.stringify(event.data).includes('Progress: one of three checks is done.'))
    const diagnosticIndex = events.findLastIndex(event =>
      event.type === 'tool/call' && event.data.name === 'workflow')
    assert.ok(answerIndex >= 0, 'the assistant should answer the progress question with text')
    assert.ok(answerIndex < diagnosticIndex, 'assistant text must precede the next diagnostic')

    const phases = runPhases(h.agent)
    assert.ok(phases.includes('completed'), `asking for progress must not stop the run; phases: ${phases.join(', ')}`)
    assert.ok(!phases.includes('waiting_user'), 'a progress question is not a requirement question')
    assertCacheStable(h.adapter.requests[0], h.adapter.requests[1], h.agent.session.snapshotEvents())
    return { scenario: 'reply-first', requests: h.adapter.requests.length, phases }
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
    assert.ok(first.includes(REPLY_FIRST), 'the Ultra playbook should carry reply-first')
    assert.ok(first.includes(TASK_STATE_SENTENCE), 'the first Ultra request should carry the task-state prompt')
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

async function scenarioBlankCarry() {
  const h = await createHarness([
    textResponse('Hello.'),
    textResponse('Existing session.'),
  ], {
    defaultModel: {
      provider: 'deepseek-official',
      model: 'mock',
      reasoningEffort: 'ultra',
    },
    applySelection: true,
  })
  try {
    const selection = h.agent.session.snapshotEvents().findLast(event => event.type === 'model/selection')
    assert.equal(selection?.data.reasoningEffort, 'ultra', 'a blank session should carry the Ultra default')
    h.agent.followup(user('hello'))
    await withTimeout(h.agent.whenIdle(), 'blank carry scenario')
    assert.equal(h.adapter.requests.length, 1, 'a blank session should run one normal turn')
    assert.equal(h.adapter.requests[0].reasoningEffort, 'max', 'the carried Ultra must map to max on the wire')
    assert.ok(
      JSON.stringify(h.adapter.requests[0].messages).includes('[ultracode:standing]'),
      'the carried Ultra should arm the standing playbook',
    )

    const existing = await h.ctx.agents.create({
      sessionId: SessionId('existing-session-seeded'),
      seed: [
        { type: 'turn/start', data: { turn: 1 }, seq: 0, time: 0 },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 1, time: 0 },
      ],
      agentOptions: { provider: 'deepseek-official', model: 'mock' },
      setup: async agentCtx => { await agentCtx.plugin(toolSkill) },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    const existingEvents = existing.agent.session.snapshotEvents()
    assert.ok(
      !existingEvents.some(event => event.type === 'model/selection'),
      'an existing session must not be mutated by the Ultra default',
    )
    existing.agent.followup(user('continue'))
    await withTimeout(existing.agent.whenIdle(), 'existing session scenario')
    assert.ok(
      !JSON.stringify(h.adapter.requests.at(-1)?.messages).includes('[ultracode:standing]'),
      'an existing session without a selection must not arm Ultra',
    )
    await existing.dispose()
    return { scenario: 'blank-carry', requests: h.adapter.requests.length }
  } finally {
    await h.handle.dispose()
  }
}

async function scenarioReload() {
  const h = await createHarness([
    toolCallResponse('call-wait', 'wait_tool', {}, 'Waiting.'),
    textResponse('I will stop here.'),
    toolCallResponse('call-complete', 'complete_run', { summary: 'reload complete' }, 'Completing.'),
  ], { waitTool: true })
  try {
    h.agent.session.append('model/selection', {
      provider: 'deepseek-official',
      model: 'mock',
      reasoningEffort: 'ultra',
    })
    h.agent.followup(user('/tdd'))
    await withTimeout(h.wait.started, 'reload wait start')
    const selectionsBefore = h.agent.session.snapshotEvents()
      .filter(event => event.type === 'model/selection')

    await h.ultraFiber.dispose()

    const afterUnload = h.agent.session.snapshotEvents()
    assert.ok(!runPhases(h.agent).includes('cancelled'), 'unload must not cancel a live run')
    assert.ok(!pauseRecords(h.agent).some(data => data.paused === true), 'unload must not pause the session')
    assert.deepEqual(
      afterUnload.filter(event => event.type === 'model/selection'),
      selectionsBefore,
      'unload must not rewrite the model selection',
    )

    h.ultraFiber = await h.ctx.plugin(ultraPlugin, {})
    await new Promise(resolve => setTimeout(resolve, 10))
    const status = await h.ctx.commands.execute(h.agent, '/autopilot status', [], new AbortController().signal)
    assert.ok(
      status?.result.text?.includes('running'),
      `the reloaded plugin should restore the live run; got ${status?.result.text}`,
    )

    h.wait.release()
    await withTimeout(h.agent.whenIdle(), 'reload settle')
    assert.equal(h.adapter.requests.length, 3, 'the reloaded plugin should continue the same turn once more')
    assert.ok(JSON.stringify(h.adapter.requests[2].messages).includes('autopilot_continue'),
      'the reloaded plugin should resume the run without a new user turn')
    assert.ok(runPhases(h.agent).includes('completed'), 'the restored run should complete')
    assertCacheStable(h.adapter.requests[0], h.adapter.requests[1], h.agent.session.snapshotEvents())
    return { scenario: 'reload', requests: h.adapter.requests.length, phases: runPhases(h.agent) }
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
    const pauseEvents = pauseRecords(h.agent)
    assert.ok(pauseEvents.some(data => data.paused === true), 'the session should be paused')
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
    const cleared = pauseRecords(h.agent).at(-1)
    assert.equal(cleared?.paused, false, 'resume should clear the durable pause')
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
    assert.ok(!pauseRecords(h.agent).some(data => data.paused === true), 'a question is not the play-button pause')

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
    assert.ok(pauseRecords(h.agent).some(data => data.paused === true))

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

async function scenarioStatusObservation() {
  const jobs = {
    list(caller) {
      return [{
        id: 'workflow-test-1',
        kind: 'workflow',
        label: 'verify build',
        owner: caller,
        status: 'running',
        progress: '2/3',
        startedAt: 1,
      }]
    },
  }
  const h = await createHarness([
    toolCallResponse('call-status-wait', 'wait_tool', {}, 'Checking the current work before continuing.'),
    toolCallResponse('call-status-read', 'session_status', {}, 'Answering the progress question from session status.'),
    toolCallResponse(
      'call-status-blocked',
      'complete_run',
      { summary: 'progress answered from status', blocked: 'diagnostic demo complete' },
      'Progress: two of three checks are done; one background job is running; the session is not paused.',
    ),
  ], { waitTool: true, jobs })
  try {
    h.agent.followup(user('/tdd'))
    await withTimeout(h.wait.started, 'status scenario wait start')

    const first = h.adapter.requests[0]
    const firstText = requestText(first)
    const observation = first.messages.find(message =>
      JSON.stringify(message).includes(OBSERVATION_MARKER))
    assert.ok(observation, 'the first root request should carry the safe-observation prompt')
    assert.ok(JSON.stringify(observation).includes('session_status'))
    assert.ok(JSON.stringify(observation).includes('session_search'))
    assert.ok(JSON.stringify(observation).includes('session_event_read'))
    assert.ok(JSON.stringify(observation).includes('.zstd'))
    assert.ok(JSON.stringify(observation).includes('partial'))
    assert.doesNotMatch(
      JSON.stringify(observation),
      FORBIDDEN_GENERIC_VOCABULARY,
      'the observation prompt must contain no ticket, phase, or skill vocabulary',
    )
    assert.ok(
      first.tools.some(tool => tool.name === 'session_status'),
      'the first request should advertise the session_status tool',
    )

    ;(h.agent.session).append('todo/write', {
      todos: [
        { content: 'Inspect the request path', status: 'completed' },
        { content: 'Add the regression test', status: 'in_progress' },
      ],
    })
    h.agent.steer(user('进度如何了？'))
    h.wait.release()
    await withTimeout(h.agent.whenIdle(), 'status scenario settle')

    assert.equal(h.adapter.requests.length, 3, 'the progress answer should take one status step')
    assert.ok(
      requestText(h.adapter.requests[1]).includes('进度如何了？'),
      'the progress question must reach the next model call',
    )
    const third = requestText(h.adapter.requests[2])
    assert.ok(third.includes('session status: '), 'the status report should reach the model')
    assert.match(third, /turn: \d+/)
    assert.match(third, /step: \d+/)
    assert.ok(third.includes('run: running'), 'the report should carry the current run state')
    assert.ok(third.includes('todos: 1 completed, 1 open'), 'the report should carry the todo summary')
    assert.ok(third.includes('updated '), 'the report should carry the todo last-updated time')
    assert.ok(third.includes('jobs: 1 active'), 'the report should carry active owned jobs')
    assert.ok(third.includes('workflow-test-1'), 'the report should name the owned job')
    assert.ok(third.includes('pause: not paused'), 'the report should carry the pause state')

    const calls = h.agent.session.snapshotEvents()
      .filter(event => event.type === 'tool/call')
      .map(event => event.data.name)
    assert.deepEqual(calls, ['wait_tool', 'session_status', 'complete_run'])
    const argumentsText = JSON.stringify(h.agent.session.snapshotEvents()
      .filter(event => event.type === 'tool/call')
      .map(event => event.data.arguments))
    assert.ok(!argumentsText.includes('node_modules'), 'no diagnostic may list node_modules')
    assert.ok(!argumentsText.includes('profiles'), 'no diagnostic may list profile directories')
    assert.ok(
      !firstText.includes('zstdDecompress'),
      'the observation contract must not introduce ad-hoc archive decompression',
    )
    assertCacheStable(h.adapter.requests[0], h.adapter.requests[1], h.agent.session.snapshotEvents())
    const phases = runPhases(h.agent)
    assert.ok(phases.includes('exhausted'), `the blocked demo run should settle; phases: ${phases.join(', ')}`)
    return { scenario: 'status-observation', requests: h.adapter.requests.length, phases }
  } finally {
    await h.handle.dispose()
  }
}

async function scenarioSessionQueryComposition() {
  const h = await createHarness([
    textResponse('Session-query composition is ready.'),
  ], { sessionQuery: true })
  try {
    const names = h.ctx.tools.schemas().map(tool => tool.name)
    for (const expected of [
      'session_search',
      'session_event_search',
      'session_trace',
      'session_event_trace',
      'session_event_read',
    ]) {
      assert.ok(names.includes(expected), `the composed profile should advertise ${expected}`)
    }

    h.agent.followup(user('compose the session history tools'))
    await withTimeout(h.agent.whenIdle(), 'session-query composition turn')
    const target = h.agent.session.snapshotEvents().find(event =>
      event.type === 'user/message'
      && JSON.stringify(event.data).includes('compose the session history tools'))
    assert.ok(target, 'the composed run should record the prompt event')
    const result = await h.ctx.tools.execute({
      name: 'session_event_read',
      arguments: { session_id: String(h.agent.session.id), seq: target.seq },
      callId: ToolCallId('session-query-composition-1'),
      signal: new AbortController().signal,
      agent: h.agent,
    })
    assert.equal(
      result.isError,
      false,
      `session_event_read should read authorized history; got ${JSON.stringify(result)}`,
    )
    const rendered = result.content
      .map(block => block.type === 'text' ? block.text : '')
      .join('\n')
    assert.ok(
      rendered.includes('compose the session history tools'),
      `session_event_read should return the live session event; got: ${rendered}`,
    )
    return { scenario: 'session-query-composition', tools: names.length, eventRead: true }
  } finally {
    await h.handle.dispose()
  }
}

const results = []
for (const scenario of [
  scenarioTdd,
  scenarioTaskState,
  scenarioReplyFirst,
  scenarioStatusObservation,
  scenarioSessionQueryComposition,
  scenarioUltra,
  scenarioBlankCarry,
  scenarioUltraWorkflow,
  scenarioReload,
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
