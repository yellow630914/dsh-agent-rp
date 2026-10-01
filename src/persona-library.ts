/** File-backed reusable player Persona library. */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { parseResourceTags } from './resource-tags.ts'
import type { PersonaLibraryEntry, PersonaLibrarySaveRequest } from './persona-library-protocol.ts'

const ID_PATTERN = /^persona-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

interface StoredPersona extends PersonaLibraryEntry {
  readonly format: 0
  readonly createdAt: number
}

/** Filesystem location override used by focused checks and portable deployments. */
export interface PersonaLibraryOptions {
  readonly root?: string
}

function cleanName(value: string): string {
  const result = value.trim()
  if (result === '' || result.length > 120) throw new Error('Persona 名称应为 1 至 120 个字符')
  return result
}

function cleanDescription(value: string): string {
  const result = value.trim()
  if (result.length > 12_000) throw new Error('Persona 描述不能超过 12000 个字符')
  return result
}

function parseStored(value: unknown): StoredPersona {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Persona 文件不是对象')
  const record = value as Record<string, unknown>
  if (record.format !== 0 || typeof record.id !== 'string' || !ID_PATTERN.test(record.id)
    || typeof record.name !== 'string' || cleanName(record.name) !== record.name
    || typeof record.description !== 'string' || cleanDescription(record.description) !== record.description
    || typeof record.createdAt !== 'number' || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
    || typeof record.updatedAt !== 'number' || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < record.createdAt) {
    throw new Error('Persona 文件字段无效')
  }
  // Labels were added after the first personas were written, so a file without
  // them stays valid; a malformed set is refused like any other bad field.
  return { ...record, tags: parseResourceTags(record.tags, '分类') } as unknown as StoredPersona
}

/** Small local library whose entries can be snapshotted into independent Sessions. */
export class PersonaLibrary {
  readonly root: string

  constructor(options: PersonaLibraryOptions = {}) {
    this.root = resolve(options.root ?? dshHomePath('agent-rp', 'personas'))
  }

  /** List valid Persona entries newest first. */
  list(): readonly PersonaLibraryEntry[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root)
      .filter(filename => filename.endsWith('.json'))
      .map(filename => this.readFile(join(this.root, filename)))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name))
      .map(({ id, name, description, updatedAt, tags }) => ({ id, name, description, updatedAt, tags }))
  }

  /** Read one Persona by opaque id. */
  get(id: string): PersonaLibraryEntry {
    const stored = this.readFile(this.path(id))
    return {
      id: stored.id,
      name: stored.name,
      description: stored.description,
      updatedAt: stored.updatedAt,
      tags: stored.tags,
    }
  }

  /** Create or update one Persona and return its normalized value. */
  save(request: PersonaLibrarySaveRequest): PersonaLibraryEntry {
    const name = cleanName(request.name)
    const description = cleanDescription(request.description)
    const id = request.id ?? `persona-${randomUUID()}`
    const path = this.path(id)
    const existing = existsSync(path) ? this.readFile(path) : undefined
    if (request.id !== undefined && existing === undefined) throw new Error(`Persona 库中没有 ${JSON.stringify(id)}`)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const now = Date.now()
    const stored: StoredPersona = {
      format: 0,
      id,
      name,
      description,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      // Omitted labels keep whatever the entry already had, so an edit that only
      // changes the description cannot silently clear them.
      tags: request.tags === undefined ? (existing?.tags ?? []) : parseResourceTags(request.tags, '分类'),
    }
    const staging = join(this.root, `.${id}.${process.pid}.${randomUUID()}.tmp`)
    try {
      writeFileSync(staging, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(staging, path)
    } catch (error: unknown) {
      rmSync(staging, { force: true })
      throw error
    }
    return this.get(id)
  }

  /** Remove one reusable Persona without changing Sessions that already copied it. */
  remove(id: string): PersonaLibraryEntry {
    const entry = this.get(id)
    rmSync(this.path(id))
    return entry
  }

  private path(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error('Persona id 无效')
    return join(this.root, `${id}.json`)
  }

  private readFile(path: string): StoredPersona {
    try {
      return parseStored(JSON.parse(readFileSync(path, 'utf8')))
    } catch (error: unknown) {
      throw new Error(`无法读取 Persona 文件 ${JSON.stringify(path)}`, { cause: error })
    }
  }
}
