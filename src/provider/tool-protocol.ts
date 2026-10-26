/**
 * The schema half of the DSH tool protocol.
 *
 * Narrowed deliberately: the AGY adapter needs the whole structured-prompt
 * protocol (envelope rendering, argument matching, response parsing), while the
 * ZCode bridge only needs to put a DSH tool schema on an MCP wire. So this file
 * carries exactly two things — the shared size limits and the schema
 * whitelist that decides which JSON Schema keywords are allowed through — and
 * nothing about prompts.
 *
 * The whitelist exists because MCP servers receive a client-supplied schema
 * verbatim: an unrestricted one is both a smuggling channel (`__proto__` keys
 * reach an object merge inside the host) and an unbounded token cost. Copied
 * from `dsh-agy-cli/src/provider/tool-protocol.ts`, which is the reference
 * implementation of this gate.
 */

/** Upper bounds for the provider-side structured tool protocol. */
export const TOOL_PROTOCOL_LIMITS = Object.freeze({
  // The byte budgets below are the real guards: a desktop profile with many
  // bundles installed hands one adapter the union of every plugin's tools (56 on
  // a stock DSH 0.2.0-rc.2 profile), which 32 rejected outright. The count is a
  // backstop only — it was 64 when a stock profile carried 56-59 tools, but this
  // machine's 18-bundle profile projects 73, so 64 silently dropped the four
  // `schedule_*` tools with nothing in the log. Raised to 256 with the byte
  // ceilings (64 KiB schema / 96 KiB contract) left as the effective limit; the
  // projection now also logs every name it drops, so a future overflow is
  // visible instead of silent.
  maxTools: 256,
  maxToolNameLength: 128,
  maxDescriptionLength: 4_096,
  maxSchemaDepth: 10,
  maxSchemaBytes: 64 * 1024,
  maxArgumentsBytes: 64 * 1024,
  maxMessageLength: 64 * 1024,
  maxResultBytes: 128 * 1024,
})

export const TOOL_PROTOCOL_SCHEMA_INVALID_CODE = 'TOOL_PROTOCOL_SCHEMA_INVALID' as const
export const TOOL_PROTOCOL_SCHEMA_LIMIT_CODE = 'TOOL_PROTOCOL_SCHEMA_LIMIT' as const

export type ToolProtocolErrorCode =
  | typeof TOOL_PROTOCOL_SCHEMA_INVALID_CODE
  | typeof TOOL_PROTOCOL_SCHEMA_LIMIT_CODE

/** Stable error that never embeds raw prompts, arguments, schemas, or paths. */
export class ToolProtocolError extends Error {
  readonly code: ToolProtocolErrorCode
  readonly detail: string | undefined

  constructor(code: ToolProtocolErrorCode, detail?: string) {
    const prefix: Record<ToolProtocolErrorCode, string> = {
      [TOOL_PROTOCOL_SCHEMA_INVALID_CODE]: 'DSH tool schema is invalid or uses an unsupported keyword',
      [TOOL_PROTOCOL_SCHEMA_LIMIT_CODE]: 'DSH tool schema exceeds the bounded protocol limit',
    }
    super(detail === undefined ? prefix[code] : `${prefix[code]} (${detail})`)
    this.name = 'ToolProtocolError'
    this.code = code
    this.detail = detail
  }
}

type JsonRecord = Record<string, unknown>

const SAFE_TYPES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'])
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const SUPPORTED_SCHEMA_KEYS = new Set([
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'default',
  'description',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'items',
  'maxItems',
  'maxLength',
  'maximum',
  'minItems',
  'minLength',
  'minimum',
  'multipleOf',
  'not',
  'oneOf',
  'pattern',
  'properties',
  'required',
  'title',
  'type',
  'uniqueItems',
])

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeObjectKey(value: string): boolean {
  return !DANGEROUS_KEYS.has(value)
}

function requireBoundedInteger(value: unknown, label: string, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, `${label} is out of range`)
  }
  return value as number
}

function cloneJson(value: unknown): unknown {
  try {
    return structuredClone(value)
  } catch {
    throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, 'value is not lossless JSON')
  }
}

function schemaArray(value: unknown, depth: number, path: string): unknown[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, `${path} must be a bounded array`)
  }
  return value.map((entry, index) => sanitizeSchemaNode(entry, depth + 1, `${path}[${index}]`))
}

function sanitizeSchemaNode(value: unknown, depth: number, path: string): JsonRecord {
  if (!isRecord(value)) {
    throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, `${path} must be an object`)
  }
  if (depth > TOOL_PROTOCOL_LIMITS.maxSchemaDepth) {
    throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_LIMIT_CODE, 'schema depth')
  }

  const output: JsonRecord = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!isSafeObjectKey(key)) {
      throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, 'unsafe object key')
    }
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) {
      throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, `unsupported keyword ${key}`)
    }
    switch (key) {
      case 'type': {
        if (typeof entry === 'string') {
          if (!SAFE_TYPES.has(entry)) throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, 'type')
          output[key] = entry
        } else if (Array.isArray(entry) && entry.length > 0 && entry.length <= SAFE_TYPES.size
          && entry.every(type => typeof type === 'string' && SAFE_TYPES.has(type))) {
          output[key] = [...entry]
        } else {
          throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, 'type')
        }
        break
      }
      case 'properties': {
        if (!isRecord(entry) || Object.keys(entry).length > 128) {
          throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, 'properties')
        }
        const properties: JsonRecord = {}
        for (const [property, propertySchema] of Object.entries(entry)) {
          if (property.length === 0 || property.length > 128 || !isSafeObjectKey(property)) {
            throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, 'property name')
          }
          properties[property] = sanitizeSchemaNode(propertySchema, depth + 1, `${path}.${property}`)
        }
        output[key] = properties
        break
      }
      case 'required': {
        if (!Array.isArray(entry) || entry.length > 128 || entry.some(item =>
          typeof item !== 'string' || !isSafeObjectKey(item))) {
          throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, 'required')
        }
        output[key] = [...new Set(entry)].sort()
        break
      }
      case 'additionalProperties': {
        if (typeof entry === 'boolean') output[key] = entry
        else output[key] = sanitizeSchemaNode(entry, depth + 1, `${path}.additionalProperties`)
        break
      }
      case 'items':
      case 'not': {
        output[key] = sanitizeSchemaNode(entry, depth + 1, `${path}.${key}`)
        break
      }
      case 'oneOf':
      case 'anyOf':
      case 'allOf': {
        output[key] = schemaArray(entry, depth, `${path}.${key}`)
        break
      }
      case 'enum': {
        if (!Array.isArray(entry) || entry.length === 0 || entry.length > 128) {
          throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, 'enum')
        }
        output[key] = entry.map(item => cloneJson(item))
        break
      }
      case 'const':
      case 'default': {
        output[key] = cloneJson(entry)
        break
      }
      case 'description':
      case 'format':
      case 'pattern':
      case 'title': {
        if (typeof entry !== 'string' || entry.length > TOOL_PROTOCOL_LIMITS.maxDescriptionLength) {
          throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, key)
        }
        if (key === 'pattern') {
          try {
            new RegExp(entry)
          } catch {
            throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, 'pattern')
          }
        }
        output[key] = entry
        break
      }
      default: {
        const number = requireBoundedInteger(entry, key, Number.MAX_SAFE_INTEGER)
        if (number !== undefined) output[key] = number
        else if (typeof entry === 'number' && Number.isFinite(entry)) output[key] = entry
        else if (typeof entry === 'boolean' && key === 'uniqueItems') output[key] = entry
        else throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, key)
      }
    }
  }
  return output
}

/**
 * Whitelist one JSON Schema down to the keywords the DSH tool protocol
 * supports. Shared with the MCP tool projection so one gate decides what a
 * model ever sees, instead of two policies drifting apart.
 */
export function sanitizeSchema(value: unknown, depth: number, label: string): unknown {
  return sanitizeSchemaNode(value, depth, label)
}
