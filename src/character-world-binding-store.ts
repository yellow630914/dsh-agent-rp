/** Persistent relationships between reusable characters and World Info assets. */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const CHARACTER_ID_PATTERN = /^card-[a-f0-9]{32}$/u
const WORLD_INFO_ID_PATTERN = /^world-info-[a-f0-9]{32}$/u
const MAX_BOUND_WORLD_INFOS = 16

/** Why one reusable world is attached to a character. */
export type CharacterWorldBindingProvenance = 'embedded-import' | 'user-bound'

/** One world reference in a character's reusable default composition. */
export interface CharacterWorldReference {
  readonly worldInfoId: string
  readonly provenance: CharacterWorldBindingProvenance
}

/** Durable default world composition for one reusable character. */
export interface CharacterWorldBinding {
  readonly format: 0
  readonly characterId: string
  readonly primary: CharacterWorldReference | null
  readonly additional: readonly CharacterWorldReference[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** Raised when an editor tries to replace a binding revision that is no longer current. */
export class CharacterWorldBindingConflictError extends Error {}

function characterId(value: unknown): string {
  if (typeof value !== 'string' || !CHARACTER_ID_PATTERN.test(value)) throw new Error('角色世界绑定的角色编号无效')
  return value
}

function worldReference(value: unknown, label: string): CharacterWorldReference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label}不是对象`)
  const record = value as Record<string, unknown>
  if (typeof record.worldInfoId !== 'string' || !WORLD_INFO_ID_PATTERN.test(record.worldInfoId)
    || (record.provenance !== 'embedded-import' && record.provenance !== 'user-bound')
    || Object.keys(record).some(key => key !== 'worldInfoId' && key !== 'provenance')) {
    throw new Error(`${label}字段无效`)
  }
  return { worldInfoId: record.worldInfoId, provenance: record.provenance }
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label}无效`)
  return value
}

function parseBinding(value: unknown): CharacterWorldBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('角色世界绑定不是对象')
  const record = value as Record<string, unknown>
  if (record.format !== 0 || !Array.isArray(record.additional)
    || Object.keys(record).some(key => ![
      'format', 'characterId', 'primary', 'additional', 'createdAt', 'updatedAt',
    ].includes(key))) {
    throw new Error('角色世界绑定字段无效')
  }
  const primary = record.primary === null ? null : worldReference(record.primary, '主世界绑定')
  const additional = record.additional.map((entry, index) => worldReference(entry, `附加世界绑定 ${index + 1}`))
  const ids = [...(primary === null ? [] : [primary.worldInfoId]), ...additional.map(entry => entry.worldInfoId)]
  if (new Set(ids).size !== ids.length) throw new Error('角色世界绑定不能重复')
  if (ids.length > MAX_BOUND_WORLD_INFOS) throw new Error(`角色最多可以绑定 ${MAX_BOUND_WORLD_INFOS} 本世界书`)
  return {
    format: 0,
    characterId: characterId(record.characterId),
    primary,
    additional,
    createdAt: timestamp(record.createdAt, '角色世界绑定创建时间'),
    updatedAt: timestamp(record.updatedAt, '角色世界绑定更新时间'),
  }
}

/** Filesystem-backed relationship store independent from both asset libraries. */
export class CharacterWorldBindingStore {
  readonly root: string

  constructor(options: { readonly root?: string } = {}) {
    this.root = resolve(options.root ?? dshHomePath('agent-rp', 'character-world-bindings'))
  }

  /** Read one migrated character composition, or return undefined before migration. */
  get(id: string): CharacterWorldBinding | undefined {
    const path = this.path(id)
    if (!existsSync(path)) return undefined
    try {
      const binding = parseBinding(JSON.parse(readFileSync(path, 'utf8')))
      if (binding.characterId !== id) throw new Error('角色世界绑定与文件名不一致')
      return binding
    } catch (error: unknown) {
      throw new Error(`无法读取角色世界绑定 ${JSON.stringify(path)}`, { cause: error })
    }
  }

  /** Record the deterministic result of splitting one imported card. */
  bindEmbedded(character: string, worldInfoId?: string): CharacterWorldBinding {
    const id = characterId(character)
    if (worldInfoId !== undefined && !WORLD_INFO_ID_PATTERN.test(worldInfoId)) throw new Error('内置世界书编号无效')
    const existing = this.get(id)
    const primary = worldInfoId === undefined
      ? null
      : { worldInfoId, provenance: 'embedded-import' as const }
    if (existing !== undefined) {
      const same = existing.primary?.worldInfoId === primary?.worldInfoId
        && existing.primary?.provenance === primary?.provenance
      if (!same || existing.additional.length !== 0) throw new Error('角色已经具有不同的世界绑定')
      return existing
    }
    const now = Date.now()
    const binding: CharacterWorldBinding = {
      format: 0,
      characterId: id,
      primary,
      additional: [],
      createdAt: now,
      updatedAt: now,
    }
    this.write(binding)
    return binding
  }

  /** Atomically replace one character's reusable world composition after an optimistic revision check. */
  replaceUserBinding(
    character: string,
    revision: number,
    primaryWorldInfoId: string | null,
    additionalWorldInfoIds: readonly string[],
  ): CharacterWorldBinding {
    const id = characterId(character)
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('角色世界绑定版本无效')
    if (primaryWorldInfoId !== null && !WORLD_INFO_ID_PATTERN.test(primaryWorldInfoId)) {
      throw new Error('主世界书编号无效')
    }
    if (!Array.isArray(additionalWorldInfoIds)
      || additionalWorldInfoIds.some(worldInfoId => !WORLD_INFO_ID_PATTERN.test(worldInfoId))) {
      throw new Error('附加世界书编号无效')
    }
    const worldInfoIds = [
      ...(primaryWorldInfoId === null ? [] : [primaryWorldInfoId]),
      ...additionalWorldInfoIds,
    ]
    if (worldInfoIds.length > MAX_BOUND_WORLD_INFOS) {
      throw new Error(`角色最多可以绑定 ${MAX_BOUND_WORLD_INFOS} 本世界书`)
    }
    if (new Set(worldInfoIds).size !== worldInfoIds.length) throw new Error('角色世界绑定不能重复')
    const existing = this.get(id)
    if (existing === undefined) throw new Error('角色还没有可编辑的世界绑定')
    if (existing.updatedAt !== revision) {
      throw new CharacterWorldBindingConflictError('角色世界组合已在别处改变，请刷新后重试')
    }
    const now = Math.max(Date.now(), existing.updatedAt + 1)
    const reference = (worldInfoId: string): CharacterWorldReference => ({
      worldInfoId,
      provenance: 'user-bound',
    })
    const binding: CharacterWorldBinding = {
      format: 0,
      characterId: id,
      primary: primaryWorldInfoId === null ? null : reference(primaryWorldInfoId),
      additional: additionalWorldInfoIds.map(reference),
      createdAt: existing.createdAt,
      updatedAt: now,
    }
    this.write(binding)
    return binding
  }

  /** List characters whose reusable composition still references one world. */
  referencingCharacters(worldInfoId: string): readonly string[] {
    if (!WORLD_INFO_ID_PATTERN.test(worldInfoId)) throw new Error('世界书编号无效')
    if (!existsSync(this.root)) return []
    return readdirSync(this.root)
      .filter(filename => /^card-[a-f0-9]{32}\.json$/u.test(filename))
      .map(filename => this.get(filename.slice(0, -'.json'.length))!)
      .filter(binding => binding.primary?.worldInfoId === worldInfoId
        || binding.additional.some(reference => reference.worldInfoId === worldInfoId))
      .map(binding => binding.characterId)
      .sort()
  }

  /**
   * Point every binding at a world's new identity after its content changed.
   *
   * World ids are the sha256 of their content, so editing a world necessarily
   * mints a new id. Provenance is carried over unchanged: an embedded-import
   * world stays embedded-import after an edit — what changed is the text, not
   * where the world came from.
   * @param previous - the id being retired.
   * @param next - the id its content now lives under.
   * @returns the characters whose bindings were rewritten.
   */
  replaceWorldInfoId(previous: string, next: string): readonly string[] {
    if (!WORLD_INFO_ID_PATTERN.test(previous) || !WORLD_INFO_ID_PATTERN.test(next)) {
      throw new Error('世界书编号无效')
    }
    if (previous === next) return []
    const swap = (reference: CharacterWorldReference): CharacterWorldReference =>
      reference.worldInfoId === previous ? { ...reference, worldInfoId: next } : reference
    const rewritten: string[] = []
    for (const identity of this.referencingCharacters(previous)) {
      const binding = this.get(identity)
      if (binding === undefined) continue
      const primary = binding.primary === null ? null : swap(binding.primary)
      const additional = binding.additional.map(swap)
      // A character bound to both the old and the new id would end up with a
      // duplicate, which parseBinding rejects on the next read. Refuse loudly
      // rather than write a file that cannot be loaded again.
      const ids = [...(primary === null ? [] : [primary.worldInfoId]), ...additional.map(item => item.worldInfoId)]
      if (new Set(ids).size !== ids.length) {
        throw new Error(`角色 ${identity} 同时绑定了这本世界书的新旧版本，无法改写`)
      }
      this.write({
        ...binding,
        primary,
        additional,
        updatedAt: Math.max(Date.now(), binding.updatedAt + 1),
      })
      rewritten.push(identity)
    }
    return rewritten
  }

  /** Remove a deleted character's relationship without deleting reusable worlds. */
  removeCharacter(id: string): void {
    const path = this.path(id)
    if (existsSync(path)) unlinkSync(path)
  }

  private path(id: string): string {
    return join(this.root, `${characterId(id)}.json`)
  }

  private write(binding: CharacterWorldBinding): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const target = this.path(binding.characterId)
    const staging = join(this.root, `.${binding.characterId}.${process.pid}.${randomUUID()}.tmp`)
    try {
      writeFileSync(staging, `${JSON.stringify(binding, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(staging, target)
    } finally {
      rmSync(staging, { force: true })
    }
  }
}
