/** Host-owned reusable SillyTavern preset library. */

import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { exportSillyTavernPresetJson } from './preset-export.ts'
import {
  parseSillyTavernPresetJson,
  type ImportedSillyTavernPreset,
  type SillyTavernPresetExtensionCompatibility,
} from './import/sillytavern-preset.ts'
import type { TavernHelperLibrarySummary } from './import/types.ts'

const FILE_SUFFIX = '.json'

/** One compact entry shown by the preset picker. */
export interface PresetLibrarySummary {
  readonly id: string
  readonly name: string
  readonly promptCount: number
  readonly enabledCount: number
  readonly regexScriptCount: number
  readonly tavernHelper?: TavernHelperLibrarySummary
  readonly updatedAt: number
}

/** One reusable preset loaded as an independent value. */
export interface PresetLibraryEntry extends PresetLibrarySummary {
  readonly preset: ImportedSillyTavernPreset
}

interface StoredMetadata {
  readonly format: 0
  readonly id: string
  readonly name: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly hasSPreset: boolean
  readonly hasTavernHelper: boolean
  readonly extensionCompatibility?: SillyTavernPresetExtensionCompatibility
}

interface StoredPreset extends Record<string, unknown> {
  readonly dsh_agent_rp_library: StoredMetadata
}

/** Filesystem location override used by focused checks and portable deployments. */
export interface PresetLibraryOptions {
  readonly root?: string
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function metadata(value: unknown): StoredMetadata {
  const source = record(value, 'preset library metadata')
  if (source.format !== 0 || typeof source.id !== 'string' || !/^[a-z0-9-]{8,80}$/u.test(source.id)
    || typeof source.name !== 'string' || source.name.trim() === ''
    || typeof source.createdAt !== 'number' || !Number.isSafeInteger(source.createdAt) || source.createdAt < 0
    || typeof source.updatedAt !== 'number' || !Number.isSafeInteger(source.updatedAt) || source.updatedAt < 0
    || typeof source.hasSPreset !== 'boolean' || typeof source.hasTavernHelper !== 'boolean') {
    throw new Error('preset library metadata has invalid fields')
  }
  if (source.extensionCompatibility !== undefined) validateExtensionCompatibility(source.extensionCompatibility)
  return source as unknown as StoredMetadata
}

function validateExtensionCompatibility(value: unknown): void {
  const compatibility = record(value, 'preset extension compatibility')
  const booleans = ['macroNestEnabled', 'chatSquashEnabled', 'regexBindingEnabled', 'regexBindingMatchesPresetScripts']
  const counts = [
    'tavernHelperScriptCount', 'enabledTavernHelperScriptCount', 'tavernHelperVariableCount', 'tavernHelperIgnoredFieldCount',
  ]
  if (booleans.some(key => compatibility[key] !== undefined && typeof compatibility[key] !== 'boolean')
    || counts.some(key => compatibility[key] !== undefined
      && (typeof compatibility[key] !== 'number' || !Number.isSafeInteger(compatibility[key]) || compatibility[key] < 0))
    || (compatibility.tavernHelperFormat !== undefined
      && compatibility.tavernHelperFormat !== 'object' && compatibility.tavernHelperFormat !== 'entries')) {
    throw new Error('preset extension compatibility has invalid fields')
  }
}

function tavernHelperSummary(preset: ImportedSillyTavernPreset): TavernHelperLibrarySummary | undefined {
  const compatibility = preset.extensionCompatibility
  const scripts = preset.tavernHelperScripts ?? []
  const expectedScriptCount = compatibility?.tavernHelperScriptCount
  if (!preset.extensionSummary.hasTavernHelper && expectedScriptCount === undefined && scripts.length === 0) return undefined
  return {
    ...(compatibility?.tavernHelperFormat === undefined ? {} : { format: compatibility.tavernHelperFormat }),
    scriptCount: scripts.length,
    enabledScriptCount: scripts.filter(script => script.enabled).length,
    ...(expectedScriptCount === undefined ? {} : { expectedScriptCount }),
    ...(compatibility?.tavernHelperVariableCount === undefined
      ? {} : { variableCount: compatibility.tavernHelperVariableCount }),
    ...(compatibility?.tavernHelperIgnoredFieldCount === undefined
      ? {} : { ignoredFieldCount: compatibility.tavernHelperIgnoredFieldCount }),
  }
}

function normalizedName(value: string): string {
  const name = value.trim()
  if (name === '') throw new Error('预设名称不能为空')
  if (name.length > 160) throw new Error('预设名称不能超过 160 个字符')
  return name
}

function summary(id: string, name: string, preset: ImportedSillyTavernPreset, updatedAt: number): PresetLibrarySummary {
  const enabled = new Set(preset.order.filter(item => item.enabled).map(item => item.identifier))
  const helper = tavernHelperSummary(preset)
  return {
    id,
    name,
    promptCount: preset.prompts.length,
    enabledCount: preset.prompts.filter(item => enabled.has(item.identifier)).length,
    regexScriptCount: preset.regexScripts.length,
    ...(helper === undefined ? {} : { tavernHelper: helper }),
    updatedAt,
  }
}

function importedId(preset: ImportedSillyTavernPreset): string {
  const digest = createHash('sha256').update(JSON.stringify({
    name: preset.name,
    prompts: preset.prompts,
    order: preset.order,
    generation: preset.generation,
    continuation: preset.continuation,
    formats: preset.formats,
    regexScripts: preset.regexScripts,
    tavernHelperScripts: preset.tavernHelperScripts,
    tavernHelperVariables: preset.tavernHelperVariables,
    extensionSummary: preset.extensionSummary,
    extensionCompatibility: preset.extensionCompatibility,
  })).digest('hex')
  return `import-${digest.slice(0, 24)}`
}

function storedDocument(
  id: string,
  name: string,
  preset: ImportedSillyTavernPreset,
  createdAt: number,
  updatedAt: number,
): string {
  const document = JSON.parse(exportSillyTavernPresetJson(preset)) as Record<string, unknown>
  document.dsh_agent_rp_library = {
    format: 0,
    id,
    name,
    createdAt,
    updatedAt,
    hasSPreset: preset.extensionSummary.hasSPreset,
    hasTavernHelper: preset.extensionSummary.hasTavernHelper,
    ...(preset.extensionCompatibility === undefined ? {} : { extensionCompatibility: preset.extensionCompatibility }),
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/** Small file-backed library; every returned preset is detached from stored state. */
export class PresetLibrary {
  readonly root: string

  constructor(options: PresetLibraryOptions = {}) {
    this.root = resolve(options.root ?? dshHomePath('agent-rp', 'presets'))
  }

  /** List valid library entries, newest first. */
  list(): readonly PresetLibrarySummary[] {
    if (!existsSync(this.root)) return []
    const entries: PresetLibrarySummary[] = []
    for (const filename of readdirSync(this.root)) {
      if (!filename.endsWith(FILE_SUFFIX)) continue
      const entry = this.readFile(join(this.root, filename))
      entries.push(summary(entry.id, entry.name, entry.preset, entry.updatedAt))
    }
    return entries.sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name))
  }

  /** Read one preset by its opaque library id. */
  get(id: string): PresetLibraryEntry {
    this.assertId(id)
    const path = join(this.root, `${id}${FILE_SUFFIX}`)
    if (!existsSync(path)) throw new Error(`预设库中没有 ${JSON.stringify(id)}`)
    return this.readFile(path)
  }

  /** Import one file-derived default, deduplicating byte-equivalent normalized behavior. */
  import(preset: ImportedSillyTavernPreset, name = preset.name): PresetLibraryEntry {
    const id = importedId(preset)
    const path = join(this.root, `${id}${FILE_SUFFIX}`)
    if (existsSync(path)) return this.readFile(path)
    return this.writeNew(id, normalizedName(name), preset)
  }

  /** Save current session configuration as a separately named reusable preset. */
  save(name: string, preset: ImportedSillyTavernPreset): PresetLibraryEntry {
    return this.writeNew(`saved-${randomUUID()}`, normalizedName(name), { ...preset, name: normalizedName(name) })
  }

  /** Remove one reusable copy without touching any session snapshot. */
  delete(id: string): void {
    this.assertId(id)
    const path = join(this.root, `${id}${FILE_SUFFIX}`)
    if (!existsSync(path)) throw new Error(`预设库中没有 ${JSON.stringify(id)}`)
    rmSync(path)
  }

  /**
   * Replace one stored preset's content in place.
   *
   * `save` is "save as" — it mints a new id — which is right for promoting a
   * Session's configuration into the library, and wrong for editing the library
   * entry itself. This keeps the id, the name and `createdAt`, so every Session
   * that points at this preset keeps pointing at it.
   * @param id - the preset being edited.
   * @param preset - complete replacement content.
   * @returns the stored entry under its unchanged identity.
   */
  replace(id: string, preset: ImportedSillyTavernPreset): PresetLibraryEntry {
    this.assertId(id)
    const path = join(this.root, `${id}${FILE_SUFFIX}`)
    if (!existsSync(path)) throw new Error(`预设库中没有 ${JSON.stringify(id)}`)
    const document = record(JSON.parse(readFileSync(path, 'utf8')), 'preset library file') as StoredPreset
    const meta = metadata(document.dsh_agent_rp_library)
    const staging = join(this.root, `.${id}.${process.pid}.${randomUUID()}.tmp`)
    try {
      writeFileSync(staging, storedDocument(id, meta.name, { ...preset, name: meta.name }, meta.createdAt, Date.now()), {
        encoding: 'utf8', mode: 0o600,
      })
      renameSync(staging, path)
    } catch (error: unknown) {
      rmSync(staging, { force: true })
      throw error
    }
    return this.readFile(path)
  }

  /** Change the library-facing name without altering any existing Session copy. */
  rename(id: string, name: string): PresetLibraryEntry {
    this.assertId(id)
    const path = join(this.root, `${id}${FILE_SUFFIX}`)
    if (!existsSync(path)) throw new Error(`预设库中没有 ${JSON.stringify(id)}`)
    const entry = this.readFile(path)
    const document = record(JSON.parse(readFileSync(path, 'utf8')), 'preset library file') as StoredPreset
    const meta = metadata(document.dsh_agent_rp_library)
    const nextName = normalizedName(name)
    const staging = join(this.root, `.${id}.${process.pid}.${randomUUID()}.tmp`)
    try {
      writeFileSync(staging, storedDocument(id, nextName, entry.preset, meta.createdAt, Date.now()), {
        encoding: 'utf8', mode: 0o600,
      })
      renameSync(staging, path)
    } catch (error: unknown) {
      rmSync(staging, { force: true })
      throw error
    }
    return this.readFile(path)
  }

  private assertId(id: string): void {
    if (!/^[a-z0-9-]{8,80}$/u.test(id)) throw new Error('预设库 id 无效')
  }

  private readFile(path: string): PresetLibraryEntry {
    let value: unknown
    try {
      value = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error: unknown) {
      throw new Error(`无法读取预设库文件 ${JSON.stringify(path)}`, { cause: error })
    }
    const document = record(value, 'preset library file') as StoredPreset
    const meta = metadata(document.dsh_agent_rp_library)
    const parsed = parseSillyTavernPresetJson(JSON.stringify(document), `${meta.name}.json`)
    const preset: ImportedSillyTavernPreset = {
      ...parsed,
      extensionSummary: {
        ...parsed.extensionSummary,
        hasSPreset: meta.hasSPreset,
        hasTavernHelper: meta.hasTavernHelper,
      },
      ...(meta.extensionCompatibility === undefined ? {} : { extensionCompatibility: meta.extensionCompatibility }),
    }
    return { ...summary(meta.id, meta.name, preset, meta.updatedAt), preset }
  }

  private writeNew(id: string, name: string, preset: ImportedSillyTavernPreset): PresetLibraryEntry {
    this.assertId(id)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const path = join(this.root, `${id}${FILE_SUFFIX}`)
    if (existsSync(path)) throw new Error(`预设库 id ${JSON.stringify(id)} 已存在`)
    const now = Date.now()
    const staging = join(this.root, `.${id}.${process.pid}.${randomUUID()}.tmp`)
    try {
      writeFileSync(staging, storedDocument(id, name, preset, now, now), { encoding: 'utf8', mode: 0o600 })
      renameSync(staging, path)
    } catch (error: unknown) {
      rmSync(staging, { force: true })
      throw error
    }
    return this.readFile(path)
  }
}
