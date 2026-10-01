/** Host-owned standalone World Info sources used by direct imports. */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { MAX_WORLD_INFO_JSON_BYTES, parseWorldInfoJsonBytes } from './import/world-info.ts'
import type { ImportedWorldInfo } from './import/types.ts'
import type { WorldInfoLibraryUpload } from './world-info-library-protocol.ts'
import type { CharacterWorldBindingStore } from './character-world-binding-store.ts'
import { mergeResourceTags, parseResourceTags } from './resource-tags.ts'

const ID_PATTERN = /^world-info-[a-f0-9]{32}$/u

/** Parsed Host-only source behind one opaque import id. */
export interface ResolvedWorldInfoUpload {
  readonly upload: WorldInfoLibraryUpload
  readonly worldInfo: ImportedWorldInfo
}

/** Original retained World Info source suitable for lossless transfer. */
export interface WorldInfoLibraryAsset extends ResolvedWorldInfoUpload {
  readonly filename: string
  readonly data: Uint8Array
}

/** Content-addressed store for original World Info JSON bytes. */
export class WorldInfoLibrary {
  readonly root: string
  private readonly bindings: CharacterWorldBindingStore | undefined

  constructor(options: {
    readonly root?: string
    readonly bindings?: CharacterWorldBindingStore
  } = {}) {
    this.root = resolve(options.root ?? dshHomePath('agent-rp', 'world-info-imports'))
    this.bindings = options.bindings
  }

  /** Validate and retain one browser-selected World Info JSON file. */
  importFile(input: { readonly data: Uint8Array; readonly filename: string }): WorldInfoLibraryUpload {
    const name = basename(input.filename.trim()).slice(0, 240)
    if (name === '' || !/\.json$/iu.test(name)) throw new Error('请选择 SillyTavern World Info JSON 文件')
    if (input.data.byteLength === 0) throw new Error('世界书文件为空')
    if (input.data.byteLength > MAX_WORLD_INFO_JSON_BYTES) throw new Error('世界书文件过大')
    const worldInfo = parseWorldInfoJsonBytes(input.data)
    const id = `world-info-${createHash('sha256').update(input.data).digest('hex').slice(0, 32)}`
    mkdirSync(this.root, { recursive: true })
    const dataPath = join(this.root, `${id}.json`)
    const namePath = join(this.root, `${id}.name`)
    if (!existsSync(dataPath)) writeFileSync(dataPath, input.data, { flag: 'wx' })
    if (!existsSync(namePath)) writeFileSync(namePath, name, { encoding: 'utf8', flag: 'wx' })
    return this.describe(id, name, worldInfo)
  }

  /** List retained World Info sources by display name. */
  list(): readonly WorldInfoLibraryUpload[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root)
      .filter(filename => /^world-info-[a-f0-9]{32}\.json$/u.test(filename))
      .map(filename => this.resolve(filename.slice(0, -'.json'.length)).upload)
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  /** List sources selected as defaults for newly created RP Sessions. */
  defaultIds(): readonly string[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root)
      .filter(filename => /^world-info-[a-f0-9]{32}\.default$/u.test(filename))
      .flatMap(filename => {
        const id = filename.slice(0, -'.default'.length)
        return this.isDefault(id) ? [this.resolve(id).upload] : []
      })
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(entry => entry.id)
  }

  /** Persist whether one retained source should be preselected for future RP Sessions. */
  setDefault(id: string, enabled: boolean): WorldInfoLibraryUpload {
    this.readSource(id)
    if (enabled && !this.isDefault(id) && this.defaultIds().length >= 16) {
      throw new Error('新会话默认世界书最多可以选择 16 本')
    }
    writeFileSync(join(this.root, `${id}.default`), enabled ? '1' : '0', { encoding: 'utf8' })
    return this.resolve(id).upload
  }

  /**
   * Replace one world's content, minting the new identity its content requires.
   *
   * Ids are the sha256 of the stored bytes, which is what makes identical
   * imports deduplicate. Editing therefore cannot keep the id without turning
   * that into a lie — a later import of the ORIGINAL file would hash to this id,
   * find the file present, and silently hand back the edited content. So the
   * edit writes a new id and moves every reference to it.
   *
   * Order matters for crash safety: write the new world, repoint bindings, then
   * retire the old one. Interrupted anywhere, the worst outcome is an orphaned
   * world file — never a binding pointing at something that does not exist.
   *
   * Sessions are unaffected either way: they froze a lossless snapshot of the
   * book at launch and never read the library again.
   * @param id - the world being edited.
   * @param data - complete replacement JSON bytes.
   * @returns the world under its new identity.
   */
  update(id: string, data: Uint8Array): WorldInfoLibraryUpload {
    const source = this.readSource(id)
    if (data.byteLength === 0) throw new Error('世界书内容为空')
    if (data.byteLength > MAX_WORLD_INFO_JSON_BYTES) throw new Error('世界书内容过大')
    const worldInfo = parseWorldInfoJsonBytes(data)
    const next = `world-info-${createHash('sha256').update(data).digest('hex').slice(0, 32)}`
    if (next === id) return this.describe(id, source.filename, worldInfo)

    const dataPath = join(this.root, `${next}.json`)
    const namePath = join(this.root, `${next}.name`)
    const existed = existsSync(dataPath)
    if (!existed) {
      // A different world already holding this content means the edit made two
      // worlds identical. Adopting it would silently merge them and take the
      // other one's bindings along, so refuse and let the player decide.
      writeFileSync(dataPath, data, { flag: 'wx' })
      writeFileSync(namePath, source.filename, { encoding: 'utf8', flag: 'wx' })
    } else if (this.bindings?.referencingCharacters(next).length ?? 0) {
      throw new Error('编辑后的内容与另一本已被角色绑定的世界书完全相同，请先调整内容或改用那一本')
    }

    try {
      this.bindings?.replaceWorldInfoId(id, next)
    } catch (error: unknown) {
      if (!existed) {
        unlinkSync(dataPath)
        unlinkSync(namePath)
      }
      throw error
    }

    if (this.isDefault(id)) writeFileSync(join(this.root, `${next}.default`), '1', { encoding: 'utf8' })
    // Labels follow the content to its new identity, or an edit would silently
    // drop the book out of every category it was in. When `existed` is true the
    // edit collapsed two books into one, so the labels merge rather than one
    // side winning — they are additive by nature, unlike a single folder.
    const carriedTags = existed ? mergeResourceTags(this.tagsOf(id), this.tagsOf(next)) : this.tagsOf(id)
    if (carriedTags.length > 0) {
      writeFileSync(join(this.root, `${next}.tags`), JSON.stringify(carriedTags), { encoding: 'utf8' })
    }
    for (const suffix of ['.json', '.name', '.default', '.tags']) {
      const path = join(this.root, `${id}${suffix}`)
      if (existsSync(path)) unlinkSync(path)
    }
    return this.describe(next, source.filename, worldInfo)
  }

  /** Remove one reusable source without affecting Sessions that already logged its lossless snapshot. */
  remove(id: string): WorldInfoLibraryUpload {
    const upload = this.resolve(id).upload
    const characterIds = this.bindings?.referencingCharacters(id) ?? []
    if (characterIds.length > 0) throw new Error('这本世界书仍由角色绑定，请先解除角色世界绑定')
    for (const suffix of ['.json', '.name', '.default', '.tags']) {
      const path = join(this.root, `${id}${suffix}`)
      if (existsSync(path)) unlinkSync(path)
    }
    return upload
  }

  /** Load the exact original source bytes retained for one import. */
  asset(id: string): WorldInfoLibraryAsset {
    const source = this.readSource(id)
    const worldInfo = parseWorldInfoJsonBytes(source.data)
    return {
      upload: this.describe(id, source.filename, worldInfo),
      worldInfo,
      filename: source.filename,
      data: source.data,
    }
  }

  /** Resolve one validated source without accepting a filesystem path from the browser. */
  resolve(id: string): ResolvedWorldInfoUpload {
    const { upload, worldInfo } = this.asset(id)
    return { upload, worldInfo }
  }

  private readSource(id: string): { readonly filename: string; readonly data: Uint8Array } {
    if (!ID_PATTERN.test(id)) throw new Error('世界书导入编号无效')
    const dataPath = join(this.root, `${id}.json`)
    const namePath = join(this.root, `${id}.name`)
    if (!existsSync(dataPath) || !existsSync(namePath)) throw new Error('这本世界书已不可用，请重新选择 JSON 文件')
    const data = new Uint8Array(readFileSync(dataPath))
    const filename = readFileSync(namePath, 'utf8').trim()
    if (filename === '' || !/\.json$/iu.test(filename) || data.byteLength > MAX_WORLD_INFO_JSON_BYTES) {
      throw new Error('已保存的世界书来源无效')
    }
    return { filename, data }
  }

  /**
   * Resource-center labels for one book.
   *
   * A sidecar file beside the content, exactly like `.name` and `.default`:
   * the id is the sha256 of the book's bytes, so anything stored *inside* the
   * file would change the id every time a label changed.
   */
  private tagsOf(id: string): readonly string[] {
    const path = join(this.root, `${id}.tags`)
    if (!existsSync(path)) return []
    try {
      return parseResourceTags(JSON.parse(readFileSync(path, 'utf8')), '分类')
    } catch {
      // A hand-edited or truncated sidecar must not take the library down; the
      // book is still perfectly readable without its labels.
      return []
    }
  }

  /** Replace the resource-center labels for one retained source. */
  setTags(id: string, tags: readonly string[]): WorldInfoLibraryUpload {
    this.readSource(id)
    const normalized = parseResourceTags(tags, '分类')
    const path = join(this.root, `${id}.tags`)
    if (normalized.length === 0) {
      if (existsSync(path)) unlinkSync(path)
    } else {
      writeFileSync(path, JSON.stringify(normalized), { encoding: 'utf8' })
    }
    return this.resolve(id).upload
  }

  private isDefault(id: string): boolean {
    const preferencePath = join(this.root, `${id}.default`)
    return existsSync(preferencePath) && readFileSync(preferencePath, 'utf8').trim() === '1'
  }

  private describe(id: string, filename: string, worldInfo: ImportedWorldInfo): WorldInfoLibraryUpload {
    return {
      id,
      name: worldInfo.name?.trim() || filename.replace(/\.json$/iu, ''),
      entryCount: worldInfo.lorebook.entries.length,
      degradations: [...worldInfo.degradations],
      defaultForNewSessions: this.isDefault(id),
      tags: this.tagsOf(id),
    }
  }
}
