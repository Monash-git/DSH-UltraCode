import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { findSkillInvocation, hasUltracodeToken, stripCode } from '../src/detect.js'

function user(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('findSkillInvocation', () => {
  it('recognizes a leading slash skill name', () => {
    expect(findSkillInvocation([user('/wayfinder plan the work')])).toBe('wayfinder')
    expect(findSkillInvocation([user('/tdd')])).toBe('tdd')
  })

  it('ignores skill names that are not on the first line', () => {
    expect(findSkillInvocation([user('please run /wayfinder')])).toBeUndefined()
    expect(findSkillInvocation([user('/wayfinder')])).toBe('wayfinder')
  })
})

describe('hasUltracodeToken', () => {
  it('detects the standalone token case-insensitively', () => {
    expect(hasUltracodeToken([user('ultracode: audit the repo')])).toBe(true)
    expect(hasUltracodeToken([user('please use ULTRAcode for this')])).toBe(true)
    expect(hasUltracodeToken([user('ordinary task')])).toBe(false)
    // Any standalone token arms the mode; /ultra off is the explicit escape.
    expect(hasUltracodeToken([user('no ultracode here')])).toBe(true)
  })

  it('ignores code examples', () => {
    expect(hasUltracodeToken([user('use `ultracode` as an example')])).toBe(false)
    expect(hasUltracodeToken([user('```\nultracode\n```')])).toBe(false)
    expect(stripCode('before `ultracode` after')).not.toContain('ultracode')
  })
})
