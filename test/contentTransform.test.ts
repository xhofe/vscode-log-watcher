import { describe, expect, it } from 'vitest'
import { applyContentTransform, compileContentTransform } from '../src/utils/contentTransform'

describe('compileContentTransform', () => {
  it('returns defaults for empty source', () => {
    const compiled = compileContentTransform('')
    expect(compiled.source).toBe('')
    expect(compiled.fn).toBeUndefined()
    expect(compiled.error).toBeUndefined()
    expect(applyContentTransform('line', compiled)).toBe('line')
  })

  it('supports arrow function expression', () => {
    const compiled = compileContentTransform('line => line.trim().toUpperCase()')
    expect(compiled.error).toBeUndefined()
    expect(applyContentTransform('  test  ', compiled)).toBe('TEST')
  })

  it('supports function body', () => {
    const compiled = compileContentTransform('return line.slice(0, 3)')
    expect(compiled.error).toBeUndefined()
    expect(applyContentTransform('abcdef', compiled)).toBe('abc')
  })

  it('coerces non-string return values', () => {
    const compiled = compileContentTransform('line => ({ value: line.length })')
    expect(applyContentTransform('abcd', compiled)).toBe('[object Object]')
  })

  it('handles thrown errors gracefully', () => {
    const compiled = compileContentTransform('() => { throw new Error("boom") }')
    expect(applyContentTransform('input', compiled)).toBe('input')
  })

  it('reports compilation errors', () => {
    const compiled = compileContentTransform('line => {')
    expect(compiled.fn).toBeUndefined()
    expect(compiled.error).toBeDefined()
    expect(applyContentTransform('input', compiled)).toBe('input')
  })

  it('test fls', () => {
    const compiled = compileContentTransform(`(text) => {
    const obj = JSON.parse(text)
    return obj._level_ + ' ' + obj._datetime_ + ' ' + obj._msg_
}`)
    expect(compiled.error).toBeUndefined()
    expect(applyContentTransform('{"_level_":"info","_datetime_":"2025-11-11T13:43:27.920554+0800","_msg_":"[FRPC] success to shutdown app"}', compiled)).toBe('info 2025-11-11T13:43:27.920554+0800 [FRPC] success to shutdown app')
  })
})

