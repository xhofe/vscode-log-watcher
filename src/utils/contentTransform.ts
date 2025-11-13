import { logger } from '../utils'
import preset from './preset'

export type ContentTransformFn = (line: string) => unknown

export interface CompiledContentTransform {
  source: string
  fn?: ContentTransformFn
  error?: string
}

function compileAsExpression(trimmed: string): ContentTransformFn {
  // eslint-disable-next-line no-new-func
  const factory = new Function(`"use strict"; return (${trimmed});`) as () => unknown
  const result = factory()
  if (typeof result !== 'function')
    throw new TypeError('表达式未返回函数')
  return result as ContentTransformFn
}

function compileAsBody(trimmed: string): ContentTransformFn {
  // eslint-disable-next-line no-new-func
  return new Function('line', trimmed) as ContentTransformFn
}

export function compileContentTransform(input: string): CompiledContentTransform {
  const trimmed = input.trim()
  if (!trimmed)
    return { source: '' }

  if (preset[trimmed]) {
    return { source: trimmed, fn: preset[trimmed] }
  }
  try {
    const fn = compileAsExpression(trimmed)
    return { source: trimmed, fn }
  }
  catch (expressionError) {
    logger.error('compileContentTransform', expressionError)
    try {
      const fn = compileAsBody(trimmed)
      return { source: trimmed, fn }
    }
    catch (bodyError) {
      const message = bodyError instanceof Error ? bodyError.message : String(bodyError)
      return { source: trimmed, fn: undefined, error: message }
    }
  }
}

export function applyContentTransform(line: string, compiled: CompiledContentTransform): string {
  const { fn } = compiled
  if (!fn)
    return line

  try {
    const result = fn(line)
    if (typeof result === 'string')
      return result
    if (result === undefined || result === null)
      return line
    return String(result)
  }
  catch {
    return line
  }
}
