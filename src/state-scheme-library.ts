/** Host-owned library of authored native state schemes and their panel templates. */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  parseRoleplayStateScheme,
  roleplayStateSchemeResourceId,
  type RoleplayStateSchemeSnapshot,
  type RoleplayStateSchemeSource,
} from './roleplay-state-scheme.ts'
import {
  parseRoleplayStateTemplateValue,
  type RoleplayStateTemplate,
} from './roleplay-state-template.ts'
import type {
  StateSchemeLibraryEntry,
  StateSchemeLibrarySaveRequest,
  StateSchemeLibrarySummary,
} from './state-scheme-library-protocol.ts'

const ID_PATTERN = /^scheme-[a-f0-9]{32}$/u
const STATE_ID_PATTERN = /^state:[\p{L}\p{N}](?:[\p{L}\p{N}._:/-]{0,126}[\p{L}\p{N}])?$/u

interface StoredStateScheme {
  readonly format: 0
  readonly id: string
  readonly name: string
  readonly stateId: string
  readonly initial: JsonValue
  readonly rules: string
  readonly template: RoleplayStateTemplate
  readonly revision: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** Filesystem location override used by focused checks and portable deployments. */
export interface StateSchemeLibraryOptions {
  readonly root?: string
}

function jsonObject(value: unknown, label: string): Record<string, JsonValue> {
  const snapshot = snapshotJsonValue(value as JsonValue)
  if (snapshot === undefined || typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new Error(`${label}必须是 JSON 对象`)
  }
  return snapshot as Record<string, JsonValue>
}

function summary(value: StoredStateScheme): StateSchemeLibrarySummary {
  return {
    id: value.id,
    name: value.name,
    stateId: value.stateId,
    fieldCount: Object.keys(value.initial as Record<string, JsonValue>).length,
    templateFormat: value.template.format,
    revision: value.revision,
    updatedAt: value.updatedAt,
  }
}

function stored(value: unknown): StoredStateScheme {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('状态方案库文件不是对象')
  const record = value as Record<string, unknown>
  if (record.format !== 0 || typeof record.id !== 'string' || !ID_PATTERN.test(record.id)
    || typeof record.name !== 'string' || record.name.trim() === '' || record.name.length > 120
    || typeof record.stateId !== 'string' || !STATE_ID_PATTERN.test(record.stateId)
    || typeof record.rules !== 'string' || record.rules.length > 24_000
    || !Number.isSafeInteger(record.revision) || Number(record.revision) < 1
    || !Number.isSafeInteger(record.createdAt) || Number(record.createdAt) < 0
    || !Number.isSafeInteger(record.updatedAt) || Number(record.updatedAt) < 0) {
    throw new Error('状态方案库文件字段无效')
  }
  return {
    format: 0,
    id: record.id,
    name: record.name,
    stateId: record.stateId,
    initial: jsonObject(record.initial, '状态方案初始值'),
    rules: record.rules,
    template: parseRoleplayStateTemplateValue(record.template, '状态栏模板'),
    revision: Number(record.revision),
    createdAt: Number(record.createdAt),
    updatedAt: Number(record.updatedAt),
  }
}

function entry(value: StoredStateScheme): StateSchemeLibraryEntry {
  return {
    ...summary(value),
    initial: structuredClone(value.initial),
    rules: value.rules,
    template: { ...value.template },
  }
}

/** Authored scheme store whose files stay independent from every Session snapshot. */
export class StateSchemeLibrary implements RoleplayStateSchemeSource {
  readonly root: string

  constructor(options: StateSchemeLibraryOptions = {}) {
    this.root = resolve(options.root ?? dshHomePath('agent-rp', 'state-schemes'))
  }

  /** List valid schemes, newest first. */
  list(): readonly StateSchemeLibrarySummary[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root).filter(filename => filename.endsWith('.json')).flatMap((filename) => {
      // One unreadable file must not hide every other authored scheme.
      try {
        return [summary(this.readFile(join(this.root, filename)))]
      } catch {
        return []
      }
    }).sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name))
  }

  /** Read one exact scheme as a detached value. */
  get(id: string): StateSchemeLibraryEntry {
    this.assertId(id)
    const path = join(this.root, `${id}.json`)
    if (!existsSync(path)) throw new Error(`状态方案库中没有 ${JSON.stringify(id)}`)
    return entry(this.readFile(path))
  }

  /** Resolve one library scheme into the exact snapshot frozen into a Session. */
  read(id: string): RoleplayStateSchemeSnapshot | undefined {
    let value: StateSchemeLibraryEntry
    try {
      value = this.get(id)
    } catch {
      return undefined
    }
    return parseRoleplayStateScheme({
      format: 0,
      id: roleplayStateSchemeResourceId(value.id),
      name: value.name,
      stateId: value.stateId,
      initial: value.initial,
      rules: value.rules,
    })
  }

  /** Read the display-only template for one library scheme. */
  template(id: string): RoleplayStateTemplate | undefined {
    try {
      return this.get(id).template
    } catch {
      return undefined
    }
  }

  /** Create or replace one authored scheme under an explicit revision check. */
  save(request: StateSchemeLibrarySaveRequest): StateSchemeLibraryEntry {
    if (request.format !== 0 || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
      throw new Error('状态方案保存请求无效')
    }
    const name = request.name.trim()
    if (name === '' || name.length > 120) throw new Error('状态方案名称无效')
    if (typeof request.stateId !== 'string' || !STATE_ID_PATTERN.test(request.stateId)) {
      throw new Error('状态命名空间必须形如 state:xxx')
    }
    if (typeof request.rules !== 'string' || request.rules.length > 24_000) throw new Error('状态结算规则无效')
    const initial = jsonObject(request.initial, '状态方案初始值')
    const template = parseRoleplayStateTemplateValue(request.template, '状态栏模板')
    const now = Date.now()
    const existing = request.id === undefined ? undefined : this.read0(request.id)
    if (existing === undefined && request.expectedRevision !== 0) {
      throw new Error('状态方案已被删除，无法按旧版本保存')
    }
    if (existing !== undefined && existing.revision !== request.expectedRevision) {
      throw new Error(`状态方案已经变化：界面版本 ${String(request.expectedRevision)}，当前版本 ${String(existing.revision)}`)
    }
    const id = existing?.id ?? `scheme-${randomUUID().replaceAll('-', '')}`
    this.assertId(id)
    const value: StoredStateScheme = {
      format: 0,
      id,
      name,
      stateId: request.stateId,
      initial,
      rules: request.rules,
      template,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    const encoded = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error('状态方案超过 1 MiB')
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const staging = join(this.root, `.${id}.${process.pid}.${randomUUID()}.tmp`)
    try {
      writeFileSync(staging, encoded, { encoding: 'utf8', mode: 0o600 })
      renameSync(staging, join(this.root, `${id}.json`))
    } catch (error: unknown) {
      rmSync(staging, { force: true })
      throw error
    }
    return this.get(id)
  }

  /** Remove one reusable scheme without touching any Session snapshot. */
  delete(id: string): void {
    this.assertId(id)
    const path = join(this.root, `${id}.json`)
    if (!existsSync(path)) throw new Error(`状态方案库中没有 ${JSON.stringify(id)}`)
    rmSync(path)
  }

  private read0(id: string): StoredStateScheme | undefined {
    this.assertId(id)
    const path = join(this.root, `${id}.json`)
    return existsSync(path) ? this.readFile(path) : undefined
  }

  private assertId(id: string): void {
    if (!ID_PATTERN.test(id)) throw new Error('状态方案库 id 无效')
  }

  private readFile(path: string): StoredStateScheme {
    try {
      return stored(JSON.parse(readFileSync(path, 'utf8')))
    } catch (error: unknown) {
      throw new Error('状态方案库文件无法读取', { cause: error })
    }
  }
}
