import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

interface PatchRow {
  id?: string
  name?: string
  group?: boolean
  isolate?: Record<string, unknown>
  config?: Record<string, unknown> | PatchRow[]
  insert?: PatchRow[]
  disabled?: boolean
}

interface PatchEntry extends PatchRow {
  insert?: PatchRow[]
}

function loadPatch(): PatchEntry[] {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const parsed: unknown = parse(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'))
  if (!Array.isArray(parsed)) throw new TypeError('cordis.patch.yml must parse to a patch list')
  return parsed as PatchEntry[]
}

describe('desktop composition patch', () => {
  it('mounts the plugin itself', () => {
    const inserted = loadPatch().flatMap(entry => entry.insert ?? [])

    expect(inserted).toContainEqual(expect.objectContaining({
      id: 'dsh-ultracode',
      name: 'dsh-ultracode',
    }))
  })

  it('mounts an isolated lazy session-query group for the five history tools', () => {
    const inserted = loadPatch().flatMap(entry => entry.insert ?? [])
    const group = inserted.find(row => row.id === 'ultracode-session-query')

    expect(group).toMatchObject({
      name: 'cordis:group',
      group: true,
      isolate: { sessionQuery: true },
    })
    const rows = Array.isArray(group?.config) ? group.config : []
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'ultracode-session-query-sqlite',
      name: '@deepseek-ai/dsh-session-query-sqlite',
      config: { path: ':memory:', openAt: 'first-search' },
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'ultracode-tool-session-query',
      name: '@deepseek-ai/dsh-tool-session-query',
    }))
  })

  it('leaves the shared base session-query configuration untouched', () => {
    const entries = loadPatch()

    expect(entries.some(entry => entry.id === 'session-query-sqlite')).toBe(false)
  })
})
