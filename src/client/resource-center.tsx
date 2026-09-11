/** Task-oriented library for reusable Agent RP resources. */

import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  CharacterLibraryCollection,
  CharacterLibraryDetail,
  CharacterLibraryImportResult,
  CharacterLibrarySummary,
  CharacterWorldBindingUpdateRequest,
} from '../character-library-protocol.ts'
import type { PersonaLibraryEntry, PersonaLibrarySaveRequest } from '../persona-library-protocol.ts'
import type { PresetLibrarySummary } from '../preset-library-http-protocol.ts'
import type { RegexPackLibrarySummary } from '../regex-pack-library-protocol.ts'
import type { WorldInfoLibraryUpload } from '../world-info-library-protocol.ts'
import {
  WorldInfoEditorDialog,
  type LoadWorldInfoEntries,
  type SaveWorldInfoEntries,
} from './world-info-editor.tsx'
import { classifySillyTavernJsonFile } from './import-hint.ts'
import {
  prepareSillyTavernMigration,
  type SillyTavernMigrationAsset,
  type SillyTavernMigrationAssetKind,
  type SillyTavernMigrationScan,
} from './sillytavern-library-migration.ts'

type ResourceSection = 'characters' | 'world-info' | 'presets' | 'regex-packs' | 'personas'

interface ResourceCenterProps {
  readonly accent: string
  readonly narrow: boolean
  readonly initialSection?: ResourceSection
  readonly listCharacters: (collection?: CharacterLibraryCollection) => Promise<readonly CharacterLibrarySummary[]>
  readonly readCharacter: (id: string) => Promise<CharacterLibraryDetail>
  readonly updateCharacterWorldBinding: (
    id: string,
    request: CharacterWorldBindingUpdateRequest,
  ) => Promise<CharacterLibraryDetail>
  readonly setCharacterArchived: (id: string, archived: boolean) => Promise<CharacterLibraryDetail>
  readonly deleteCharacter: (id: string) => Promise<void>
  readonly importCharacterFile: (file: File) => Promise<CharacterLibraryImportResult>
  readonly listWorldInfos: () => Promise<readonly WorldInfoLibraryUpload[]>
  readonly importWorldInfoFile: (file: File) => Promise<WorldInfoLibraryUpload>
  readonly setWorldInfoDefault: (id: string, enabled: boolean) => Promise<WorldInfoLibraryUpload>
  readonly deleteWorldInfo: (id: string) => Promise<WorldInfoLibraryUpload>
  readonly loadWorldInfoEntries: LoadWorldInfoEntries
  readonly saveWorldInfoEntries: SaveWorldInfoEntries
  readonly listPresets: () => Promise<readonly PresetLibrarySummary[]>
  readonly importPresetFile: (file: File) => Promise<PresetLibrarySummary>
  readonly renamePreset: (id: string, name: string) => Promise<PresetLibrarySummary>
  readonly deletePreset: (id: string) => Promise<void>
  readonly listRegexPacks: () => Promise<readonly RegexPackLibrarySummary[]>
  readonly importRegexPackFile: (file: File) => Promise<RegexPackLibrarySummary>
  readonly deleteRegexPack: (id: string) => Promise<void>
  readonly listPersonas: () => Promise<readonly PersonaLibraryEntry[]>
  readonly savePersona: (request: PersonaLibrarySaveRequest) => Promise<PersonaLibraryEntry>
  readonly deletePersona: (id: string) => Promise<PersonaLibraryEntry>
  readonly onConfigureWorldInfo?: (entry: WorldInfoLibraryUpload) => void
  readonly onClose: () => void
}

interface CharacterWorldBindingDraft {
  readonly character: CharacterLibraryDetail
  readonly primaryWorldInfoId: string | null
  readonly additionalWorldInfoIds: readonly string[]
}

const secondaryButtonStyle = {
  background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l2, #444)',
  borderRadius: '8px',
  color: 'inherit',
  font: 'inherit',
  fontSize: '11px',
  padding: '6px 9px',
  whiteSpace: 'nowrap',
} as const

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function sectionName(section: ResourceSection): string {
  if (section === 'characters') return '角色'
  if (section === 'world-info') return '世界书'
  if (section === 'presets') return '预设'
  if (section === 'regex-packs') return '正则包'
  return '身份'
}

function migrationKindName(kind: SillyTavernMigrationAssetKind): string {
  if (kind === 'character') return '角色卡'
  if (kind === 'world-info') return '世界书'
  if (kind === 'regex-pack') return '正则包'
  return '预设'
}

function migrationSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`
}

interface MigrationImportReport {
  readonly handled: number
  readonly existing: number
  readonly restored: number
  readonly failures: readonly { readonly name: string; readonly message: string }[]
}

function SillyTavernLibraryMigrationDialog({
  accent,
  narrow,
  characters,
  worldInfos,
  importCharacterFile,
  importWorldInfoFile,
  importPresetFile,
  importRegexPackFile,
  onImported,
  onClose,
}: {
  readonly accent: string
  readonly narrow: boolean
  readonly characters: readonly CharacterLibrarySummary[]
  readonly worldInfos: readonly WorldInfoLibraryUpload[]
  readonly importCharacterFile: (file: File) => Promise<CharacterLibraryImportResult>
  readonly importWorldInfoFile: (file: File) => Promise<WorldInfoLibraryUpload>
  readonly importPresetFile: (file: File) => Promise<PresetLibrarySummary>
  readonly importRegexPackFile: (file: File) => Promise<RegexPackLibrarySummary>
  readonly onImported: (report: MigrationImportReport) => Promise<void>
  readonly onClose: () => void
}) {
  const [scan, setScan] = useState<SillyTavernMigrationScan>()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [working, setWorking] = useState<'scan' | 'import'>()
  const [progress, setProgress] = useState(0)
  const [report, setReport] = useState<MigrationImportReport>()
  const [error, setError] = useState<string>()
  const zipInputRef = useRef<HTMLInputElement | null>(null)
  const folderInputRef = useRef<HTMLInputElement | null>(null)
  const filesInputRef = useRef<HTMLInputElement | null>(null)

  const beginScan = (files: readonly File[]): void => {
    setWorking('scan')
    setError(undefined)
    setReport(undefined)
    void prepareSillyTavernMigration(files, {
      characters: characters.map(entry => ({ id: entry.id, archived: entry.archived })),
      worldInfoIds: worldInfos.map(entry => entry.id),
    }).then(result => {
      setScan(result)
      setSelected(new Set(result.assets.filter(asset => asset.selectedByDefault).map(asset => asset.id)))
    }).catch(reason => { setError(message(reason)) }).finally(() => { setWorking(undefined) })
  }
  const readInput = (input: HTMLInputElement): void => {
    const files = [...(input.files ?? [])]
    input.value = ''
    if (files.length > 0) beginScan(files)
  }
  const kinds: readonly SillyTavernMigrationAssetKind[] = ['character', 'world-info', 'preset', 'regex-pack']
  const ready = scan?.assets.filter(asset => asset.state === 'ready') ?? []
  const selectedAssets = ready.filter(asset => selected.has(asset.id))
  const setKindSelected = (kind: SillyTavernMigrationAssetKind, enabled: boolean): void => {
    setSelected(current => {
      const next = new Set(current)
      for (const asset of ready) {
        if (asset.kind !== kind) continue
        if (enabled) next.add(asset.id)
        else next.delete(asset.id)
      }
      return next
    })
  }
  const importSelected = (): void => {
    if (selectedAssets.length === 0) return
    const assets = [...selectedAssets]
    setWorking('import')
    setError(undefined)
    setProgress(0)
    const failures: { name: string; message: string }[] = []
    let existing = 0
    let restored = 0
    let handled = 0
    let cursor = 0
    const importOne = async (asset: SillyTavernMigrationAsset): Promise<void> => {
      try {
        if (asset.kind === 'character') {
          const result = await importCharacterFile(asset.file)
          if (result.outcome === 'existing') existing += 1
          else if (result.outcome === 'restored') restored += 1
        } else if (asset.kind === 'world-info') {
          await importWorldInfoFile(asset.file)
        } else if (asset.kind === 'preset') {
          await importPresetFile(asset.file)
        } else {
          await importRegexPackFile(asset.file)
        }
        handled += 1
      } catch (reason: unknown) {
        failures.push({ name: asset.name, message: message(reason) })
      } finally {
        setProgress(value => value + 1)
      }
    }
    const worker = async (): Promise<void> => {
      while (cursor < assets.length) {
        const index = cursor
        cursor += 1
        const asset = assets[index]
        if (asset !== undefined) await importOne(asset)
      }
    }
    void Promise.all(Array.from({ length: Math.min(3, assets.length) }, worker)).then(async () => {
      const nextReport = { handled, existing, restored, failures }
      await onImported(nextReport)
      setReport(nextReport)
    }).catch(reason => { setError(message(reason)) }).finally(() => { setWorking(undefined) })
  }

  const chats = scan?.deferred.filter(entry => entry.kind === 'chat') ?? []
  const groupChats = scan?.deferred.filter(entry => entry.kind === 'group-chat') ?? []
  const personas = scan?.deferred.filter(entry => entry.kind === 'persona') ?? []
  const chatGroups = [...new Set(chats.map(entry => entry.characterName ?? '未识别角色'))]
    .map(name => ({ name, count: chats.filter(entry => (entry.characterName ?? '未识别角色') === name).length }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
  const panelStyle = {
    background: 'var(--dsw-alias-bg-layer-1, #202024)', border: '1px solid var(--dsw-alias-border-l2, #3b3b41)',
    borderRadius: '11px', padding: '12px',
  } as const
  const choiceButtonStyle = {
    ...secondaryButtonStyle, cursor: working === undefined ? 'pointer' : 'default', fontSize: '12px', padding: '10px 12px',
  } as const

  return <div data-agent-rp-dialog data-agent-rp-surface="sillytavern-library-migration" role="dialog" aria-modal="true"
    aria-label="从 SillyTavern 迁移" style={{
      alignItems: 'center', background: 'rgba(0,0,0,.68)', display: 'flex', inset: 0, justifyContent: 'center',
      padding: narrow ? '8px' : '24px', position: 'fixed', zIndex: 1003,
    }} onMouseDown={event => { if (event.target === event.currentTarget && working === undefined) onClose() }}>
    <section style={{
      background: 'var(--dsw-alias-bg-base, #171719)', border: '1px solid var(--dsw-alias-border-l2, #39393c)',
      borderRadius: '16px', boxShadow: '0 22px 80px rgba(0,0,0,.45)', display: 'flex', flexDirection: 'column',
      maxHeight: narrow ? 'calc(100vh - 16px)' : 'min(760px, calc(100vh - 48px))', maxWidth: '680px',
      overflow: 'hidden', width: narrow ? 'calc(100vw - 16px)' : 'min(680px, calc(100vw - 48px))',
    }}>
      <header style={{ alignItems: 'center', borderBottom: '1px solid var(--dsw-alias-border-l2, #39393c)', display: 'flex', gap: '10px', padding: narrow ? '13px 14px' : '17px 18px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ fontSize: '17px', margin: 0 }}>从 SillyTavern 迁移</h2>
          <p style={{ fontSize: '11px', lineHeight: 1.45, margin: '4px 0 0', opacity: .5 }}>先扫描预览，确认后才写入资源中心</p>
        </div>
        <button type="button" aria-label="关闭迁移" disabled={working !== undefined} onClick={onClose} style={{
          background: 'transparent', border: 0, color: 'inherit', cursor: working === undefined ? 'pointer' : 'default', fontSize: '23px', padding: '2px 5px',
        }}>×</button>
      </header>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: narrow ? '14px' : '18px' }}>
        {scan === undefined && report === undefined && <>
          <p style={{ fontSize: '13px', lineHeight: 1.65, margin: '0 0 14px', opacity: .72 }}>
            可以选择整个用户数据目录、压缩后的 ZIP，或一次选择多份导出文件。角色卡、世界书、预设和独立正则包会自动分类。
          </p>
          <div style={{ display: 'grid', gap: '9px', gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : 'repeat(3, minmax(0, 1fr))' }}>
            <button type="button" disabled={working !== undefined} onClick={() => { zipInputRef.current?.click() }} style={choiceButtonStyle}>
              <strong style={{ display: 'block', fontSize: '13px' }}>数据 ZIP</strong>
              <span style={{ display: 'block', marginTop: '4px', opacity: .52 }}>手机推荐</span>
            </button>
            <button type="button" disabled={working !== undefined} onClick={() => { folderInputRef.current?.click() }} style={choiceButtonStyle}>
              <strong style={{ display: 'block', fontSize: '13px' }}>数据目录</strong>
              <span style={{ display: 'block', marginTop: '4px', opacity: .52 }}>电脑版推荐</span>
            </button>
            <button type="button" disabled={working !== undefined} onClick={() => { filesInputRef.current?.click() }} style={choiceButtonStyle}>
              <strong style={{ display: 'block', fontSize: '13px' }}>多份文件</strong>
              <span style={{ display: 'block', marginTop: '4px', opacity: .52 }}>只迁移选中内容</span>
            </button>
          </div>
          <input ref={zipInputRef} type="file" accept=".zip,application/zip" hidden onChange={event => { readInput(event.currentTarget) }} />
          <input ref={element => {
            folderInputRef.current = element
            element?.setAttribute('webkitdirectory', '')
            element?.setAttribute('directory', '')
          }} type="file" multiple hidden onChange={event => { readInput(event.currentTarget) }} />
          <input ref={filesInputRef} type="file" multiple accept=".png,.json,.jsonl,.charx,image/png,application/json,application/zip" hidden onChange={event => { readInput(event.currentTarget) }} />
          <div style={{ ...panelStyle, fontSize: '11px', lineHeight: 1.6, marginTop: '14px', opacity: .62 }}>
            不会读取或导入 API Key、账号凭据、酒馆界面设置、插件缓存。聊天记录只统计并按角色整理，本轮不会自动创建大量会话。
          </div>
          {working === 'scan' && <p role="status" style={{ fontSize: '12px', margin: '14px 2px 0', opacity: .62 }}>正在扫描并识别资源…</p>}
        </>}
        {scan !== undefined && report === undefined && <>
          <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
            {[
              ['角色', scan.assets.filter(asset => asset.kind === 'character').length],
              ['世界书', scan.assets.filter(asset => asset.kind === 'world-info').length],
              ['预设', scan.assets.filter(asset => asset.kind === 'preset').length],
              ['正则', scan.assets.filter(asset => asset.kind === 'regex-pack').length],
              ['聊天', chats.length],
            ].map(([label, count]) => <div key={String(label)} style={{ ...panelStyle, padding: narrow ? '9px 6px' : '10px', textAlign: 'center' }}>
              <strong style={{ display: 'block', fontSize: '16px' }}>{count}</strong>
              <span style={{ display: 'block', fontSize: '10px', marginTop: '2px', opacity: .5 }}>{label}</span>
            </div>)}
          </div>
          <p style={{ fontSize: '11px', lineHeight: 1.55, margin: '10px 2px 14px', opacity: .52 }}>
            共查看 {scan.totalFiles} 个文件；{scan.ignoredCount} 个无关文件未读取
          </p>
          <div style={{ display: 'grid', gap: '9px' }}>
            {kinds.map(kind => {
              const entries = scan.assets.filter(asset => asset.kind === kind)
              if (entries.length === 0) return null
              const selectable = entries.filter(asset => asset.state === 'ready')
              const checked = selectable.length > 0 && selectable.every(asset => selected.has(asset.id))
              return <section key={kind} style={panelStyle}>
                <label style={{ alignItems: 'center', cursor: selectable.length > 0 ? 'pointer' : 'default', display: 'flex', gap: '9px' }}>
                  <input type="checkbox" checked={checked} disabled={working !== undefined || selectable.length === 0}
                    onChange={event => { setKindSelected(kind, event.target.checked) }} />
                  <strong style={{ flex: 1, fontSize: '13px' }}>{migrationKindName(kind)}</strong>
                  <span style={{ fontSize: '10px', opacity: .48 }}>{selectable.length} 可迁移 / {entries.length} 识别</span>
                </label>
                <div style={{ borderTop: '1px solid var(--dsw-alias-border-l2, #39393c)', marginTop: '9px', paddingTop: '7px' }}>
                  {entries.slice(0, 6).map(asset => <div key={asset.id} style={{ alignItems: 'baseline', display: 'flex', fontSize: '11px', gap: '8px', lineHeight: 1.55 }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asset.name}</span>
                    <span style={{ opacity: .42, whiteSpace: 'nowrap' }}>{migrationSize(asset.bytes)}</span>
                    {asset.note !== undefined && <span style={{ color: asset.state === 'ready' ? 'var(--dsw-alias-state-success, #4fba83)' : 'inherit', maxWidth: '45%', opacity: asset.state === 'ready' ? .78 : .5 }}>{asset.note}</span>}
                  </div>)}
                  {entries.length > 6 && <div style={{ fontSize: '10px', marginTop: '5px', opacity: .42 }}>另有 {entries.length - 6} 项</div>}
                </div>
              </section>
            })}
          </div>
          {chats.length > 0 && <section style={{ ...panelStyle, marginTop: '9px' }}>
            <strong style={{ display: 'block', fontSize: '13px' }}>聊天记录已整理</strong>
            <p style={{ fontSize: '11px', lineHeight: 1.55, margin: '5px 0 8px', opacity: .55 }}>不会立即创建会话；后续可按角色选择需要继续的记录。</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {chatGroups.slice(0, 8).map(group => <span key={group.name} style={{
                background: 'color-mix(in srgb, currentColor 6%, transparent)', borderRadius: '999px', fontSize: '10px', padding: '4px 8px',
              }}>{group.name} · {group.count}</span>)}
              {chatGroups.length > 8 && <span style={{ fontSize: '10px', opacity: .45, padding: '4px 2px' }}>另有 {chatGroups.length - 8} 个角色</span>}
            </div>
          </section>}
          {(personas.length > 0 || groupChats.length > 0) && <p style={{ fontSize: '11px', lineHeight: 1.55, margin: '10px 2px 0', opacity: .52 }}>
            {personas.length > 0 ? `发现 ${personas.length} 张 Persona 图片；身份描述需要与 settings.json 安全配对，暂不导入。` : ''}
            {personas.length > 0 && groupChats.length > 0 ? ' ' : ''}
            {groupChats.length > 0 ? `发现 ${groupChats.length} 段群聊；当前单角色阶段暂不导入。` : ''}
          </p>}
          {scan.issues.length > 0 && <details style={{ ...panelStyle, marginTop: '9px' }}>
            <summary style={{ cursor: 'pointer', fontSize: '11px' }}>{scan.issues.length} 项未能识别</summary>
            <div style={{ display: 'grid', fontSize: '10px', gap: '5px', marginTop: '8px', opacity: .58 }}>
              {scan.issues.slice(0, 20).map((issue, index) => <div key={`${issue.path}:${index}`}><strong>{issue.path}</strong> · {issue.message}</div>)}
              {scan.issues.length > 20 && <div>另有 {scan.issues.length - 20} 项</div>}
            </div>
          </details>}
          {working === 'import' && <div role="status" style={{ ...panelStyle, fontSize: '12px', marginTop: '10px' }}>
            正在迁移 {progress}/{selectedAssets.length}…
          </div>}
        </>}
        {report !== undefined && <div style={{ textAlign: 'center' }}>
          <div aria-hidden="true" style={{ color: 'var(--dsw-alias-state-success, #4fba83)', fontSize: '30px', margin: '6px 0 8px' }}>✓</div>
          <h3 style={{ fontSize: '17px', margin: 0 }}>迁移完成</h3>
          <p style={{ fontSize: '12px', lineHeight: 1.65, margin: '8px 0 0', opacity: .65 }}>
            已处理 {report.handled} 项{report.existing > 0 ? `，其中 ${report.existing} 项原本已存在` : ''}{report.restored > 0 ? `，恢复 ${report.restored} 个角色` : ''}
          </p>
          {report.failures.length > 0 && <div style={{ ...panelStyle, marginTop: '14px', textAlign: 'left' }}>
            <strong style={{ display: 'block', fontSize: '12px', marginBottom: '7px' }}>{report.failures.length} 项没有导入</strong>
            {report.failures.slice(0, 20).map((failure, index) => <div key={`${failure.name}:${index}`} style={{ fontSize: '10px', lineHeight: 1.55, opacity: .62 }}>
              {failure.name} · {failure.message}
            </div>)}
          </div>}
        </div>}
        {error !== undefined && <p role="alert" style={{ color: 'var(--dsw-alias-state-danger, #e88989)', fontSize: '11px', lineHeight: 1.55, margin: '12px 2px 0' }}>{error}</p>}
      </div>
      <footer style={{ alignItems: 'center', borderTop: '1px solid var(--dsw-alias-border-l2, #39393c)', display: 'flex', gap: '8px', justifyContent: 'flex-end', padding: narrow ? '11px 14px' : '13px 18px' }}>
        {scan !== undefined && report === undefined && <button type="button" disabled={working !== undefined} onClick={() => { setScan(undefined); setError(undefined) }} style={secondaryButtonStyle}>重新选择</button>}
        {scan !== undefined && report === undefined && <button type="button" disabled={working !== undefined || selectedAssets.length === 0} onClick={importSelected} style={{
          ...secondaryButtonStyle, background: accent, borderColor: accent, color: '#fff', cursor: working === undefined && selectedAssets.length > 0 ? 'pointer' : 'default', opacity: selectedAssets.length > 0 ? 1 : .46,
        }}>{working === 'import' ? `迁移中 ${progress}/${selectedAssets.length}` : `迁移 ${selectedAssets.length} 项`}</button>}
        {report !== undefined && <button type="button" onClick={onClose} style={{ ...secondaryButtonStyle, background: accent, borderColor: accent, color: '#fff', cursor: 'pointer' }}>完成</button>}
      </footer>
    </section>
  </div>
}

/** Manage reusable resources without tying them to one Character Card or Session. */
export function RoleplayResourceCenter({
  accent, narrow, initialSection = 'characters',
  listCharacters, readCharacter, updateCharacterWorldBinding,
  setCharacterArchived, deleteCharacter, importCharacterFile,
  listWorldInfos, importWorldInfoFile, setWorldInfoDefault, deleteWorldInfo,
  loadWorldInfoEntries, saveWorldInfoEntries,
  listPresets, importPresetFile, renamePreset, deletePreset,
  listRegexPacks, importRegexPackFile, deleteRegexPack,
  listPersonas, savePersona, deletePersona,
  onConfigureWorldInfo,
  onClose,
}: ResourceCenterProps) {
  const [section, setSection] = useState<ResourceSection>(initialSection)
  const [query, setQuery] = useState('')
  const [characters, setCharacters] = useState<readonly CharacterLibrarySummary[]>()
  const [worldInfos, setWorldInfos] = useState<readonly WorldInfoLibraryUpload[]>()
  const [presets, setPresets] = useState<readonly PresetLibrarySummary[]>()
  const [regexPacks, setRegexPacks] = useState<readonly RegexPackLibrarySummary[]>()
  const [personas, setPersonas] = useState<readonly PersonaLibraryEntry[]>()
  const [loadErrors, setLoadErrors] = useState<Partial<Record<ResourceSection, string>>>({})
  const [busy, setBusy] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()
  const [personaDraft, setPersonaDraft] = useState<{ readonly id?: string; readonly name: string; readonly description: string }>()
  const [presetDraft, setPresetDraft] = useState<{ readonly id: string; readonly name: string }>()
  const [worldBindingDraft, setWorldBindingDraft] = useState<CharacterWorldBindingDraft>()
  const [confirmingPresetId, setConfirmingPresetId] = useState<string>()
  const [confirmingPersonaId, setConfirmingPersonaId] = useState<string>()
  const [confirmingRegexPackId, setConfirmingRegexPackId] = useState<string>()
  const [confirmingWorldInfoId, setConfirmingWorldInfoId] = useState<string>()
  const [editingWorldInfo, setEditingWorldInfo] = useState<WorldInfoLibraryUpload>()
  const [confirmingCharacterId, setConfirmingCharacterId] = useState<string>()
  const [migrationOpen, setMigrationOpen] = useState(false)
  const characterInputRef = useRef<HTMLInputElement | null>(null)
  const worldInfoInputRef = useRef<HTMLInputElement | null>(null)
  const presetInputRef = useRef<HTMLInputElement | null>(null)
  const regexPackInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    let current = true
    const failed = (target: ResourceSection) => (reason: unknown): void => {
      if (!current) return
      setLoadErrors(value => ({ ...value, [target]: message(reason) }))
      if (target === 'characters') setCharacters([])
      else if (target === 'world-info') setWorldInfos([])
      else if (target === 'presets') setPresets([])
      else if (target === 'regex-packs') setRegexPacks([])
      else setPersonas([])
    }
    void Promise.all([listCharacters('active'), listCharacters('archived')]).then(([active, archived]) => {
      if (current) setCharacters([...active, ...archived])
    }, failed('characters'))
    void listWorldInfos().then(value => { if (current) setWorldInfos(value) }, failed('world-info'))
    void listPresets().then(value => { if (current) setPresets(value) }, failed('presets'))
    void listRegexPacks().then(value => { if (current) setRegexPacks(value) }, failed('regex-packs'))
    void listPersonas().then(value => { if (current) setPersonas(value) }, failed('personas'))
    return () => { current = false }
  }, [listCharacters, listPersonas, listPresets, listRegexPacks, listWorldInfos])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matches = (...values: readonly string[]): boolean => normalizedQuery === ''
    || values.some(value => value.toLocaleLowerCase().includes(normalizedQuery))
  const visibleCharacters = useMemo(() => (characters ?? []).filter(entry =>
    matches(entry.displayName, entry.name, entry.originalFilename)), [characters, normalizedQuery])
  const visibleWorldInfos = useMemo(() => (worldInfos ?? []).filter(entry => matches(entry.name)), [worldInfos, normalizedQuery])
  const visiblePresets = useMemo(() => (presets ?? []).filter(entry => matches(entry.name)), [presets, normalizedQuery])
  const visibleRegexPacks = useMemo(() => (regexPacks ?? []).filter(entry => matches(entry.name)), [regexPacks, normalizedQuery])
  const visiblePersonas = useMemo(() => (personas ?? []).filter(entry => matches(entry.name, entry.description)), [personas, normalizedQuery])
  const worldInfoById = useMemo(() => new Map((worldInfos ?? []).map(entry => [entry.id, entry])), [worldInfos])

  const startAction = (key: string): void => {
    setBusy(key)
    setError(undefined)
    setNotice(undefined)
  }
  const finishAction = (): void => { setBusy(undefined) }
  const importCharacter = (file: File): void => {
    startAction('import-character')
    void importCharacterFile(file).then(result => {
      setCharacters(value => [result.entry, ...(value ?? []).filter(entry => entry.id !== result.entry.id)])
      setNotice(result.outcome === 'created' ? `已加入角色「${result.entry.displayName}」`
        : result.outcome === 'restored' ? `已恢复角色「${result.entry.displayName}」`
          : `角色「${result.entry.displayName}」已经在资源中心`)
    }).catch(reason => { setError(message(reason)) }).finally(finishAction)
  }
  const importWorldInfo = (file: File): void => {
    startAction('import-world-info')
    void importWorldInfoFile(file).then(entry => {
      setWorldInfos(value => [entry, ...(value ?? []).filter(item => item.id !== entry.id)])
      setNotice(`已加入世界书「${entry.name}」`)
    }).catch(reason => { setError(message(reason)) }).finally(finishAction)
  }
  const importPreset = (file: File): void => {
    startAction('import-preset')
    void importPresetFile(file).then(entry => {
      setPresets(value => [entry, ...(value ?? []).filter(item => item.id !== entry.id)])
      setNotice(`已加入预设「${entry.name}」`)
    }).catch(reason => { setError(message(reason)) }).finally(finishAction)
  }
  const importRegexPack = (file: File): void => {
    startAction('import-regex-pack')
    void importRegexPackFile(file).then(entry => {
      setRegexPacks(value => [entry, ...(value ?? []).filter(item => item.id !== entry.id)])
      setNotice(`已加入正则包「${entry.name}」`)
    }).catch(reason => { setError(message(reason)) }).finally(finishAction)
  }
  const importResource = (file: File, fallback: Exclude<ResourceSection, 'personas'>): void => {
    if (!/\.json$/iu.test(file.name)) {
      if (fallback === 'characters') importCharacter(file)
      else setError('这里只接受 JSON 资源')
      return
    }
    startAction('classify-resource')
    void classifySillyTavernJsonFile(file).then(kind => {
      if (kind === 'character-card') {
        setSection('characters')
        importCharacter(file)
      } else if (kind === 'world-info') {
        setSection('world-info')
        importWorldInfo(file)
      } else if (kind === 'preset') {
        setSection('presets')
        importPreset(file)
      } else if (kind === 'regex-pack') {
        setSection('regex-packs')
        importRegexPack(file)
      } else {
        finishAction()
        setError('无法识别这份 JSON；请选择角色卡、世界书、Chat Completion 预设或独立正则包')
      }
    }, reason => {
      finishAction()
      setError(message(reason))
    })
  }
  const toggleCharacterArchive = (entry: CharacterLibrarySummary): void => {
    startAction(`character:${entry.id}`)
    void setCharacterArchived(entry.id, !entry.archived).then(updated => {
      setCharacters(value => (value ?? []).map(item => item.id === updated.id ? updated : item))
      if (updated.archived) {
        setWorldBindingDraft(value => value?.character.id === updated.id ? undefined : value)
      }
      setNotice(`${updated.archived ? '已收起' : '已恢复'}角色「${updated.displayName}」`)
    }).catch(reason => { setError(message(reason)) }).finally(finishAction)
  }
  const removeCharacter = (entry: CharacterLibrarySummary): void => {
    if (!entry.archived) return
    if (confirmingCharacterId !== entry.id) {
      setConfirmingCharacterId(entry.id)
      setError(undefined)
      setNotice('永久删除不可恢复；已有会话引用这张角色卡时，Host 会拒绝删除')
      return
    }
    startAction(`character:${entry.id}`)
    void deleteCharacter(entry.id).then(() => {
      setCharacters(value => (value ?? []).filter(item => item.id !== entry.id))
      setConfirmingCharacterId(undefined)
      setNotice(`已永久删除角色「${entry.displayName}」`)
    }).catch(reason => { setError(message(reason)) }).finally(finishAction)
  }
  const editCharacterWorldBinding = (entry: CharacterLibrarySummary): void => {
    if (entry.archived) return
    startAction(`character-world:${entry.id}`)
    void readCharacter(entry.id).then(character => {
      if (character.worldBinding === undefined) throw new Error('当前 Host 没有提供角色世界组合编辑能力')
      setWorldBindingDraft({
        character,
        primaryWorldInfoId: character.worldBinding.primary?.worldInfoId ?? null,
        additionalWorldInfoIds: character.worldBinding.additional.map(reference => reference.worldInfoId),
      })
    }).catch(reason => { setError(message(reason)) }).finally(finishAction)
  }
  const saveCharacterWorldBinding = (): void => {
    const draft = worldBindingDraft
    const binding = draft?.character.worldBinding
    if (draft === undefined || binding === undefined) return
    startAction(`character-world:${draft.character.id}`)
    void updateCharacterWorldBinding(draft.character.id, {
      format: 0,
      revision: binding.revision,
      primaryWorldInfoId: draft.primaryWorldInfoId,
      additionalWorldInfoIds: draft.additionalWorldInfoIds,
    }).then(entry => {
      setCharacters(value => (value ?? []).map(item => item.id === entry.id ? entry : item))
      setWorldBindingDraft(undefined)
      setNotice(`已保存角色「${entry.displayName}」的世界组合；已有会话与原始文件不受影响`)
    }).catch(reason => { setError(message(reason)) }).finally(finishAction)
  }
  const savePresetName = (): void => {
    if (presetDraft === undefined || presetDraft.name.trim() === '') return
    startAction(`preset:${presetDraft.id}`)
    void renamePreset(presetDraft.id, presetDraft.name).then(entry => {
      setPresets(value => (value ?? []).map(item => item.id === entry.id ? entry : item))
      setPresetDraft(undefined)
      setNotice(`预设已改名为「${entry.name}」`)
    }).catch(reason => { setError(message(reason)) }).finally(finishAction)
  }
  const removePreset = (entry: PresetLibrarySummary): void => {
    if (confirmingPresetId !== entry.id) {
      setConfirmingPresetId(entry.id)
      return
    }
    startAction(`preset:${entry.id}`)
    void deletePreset(entry.id).then(() => {
      setPresets(value => (value ?? []).filter(item => item.id !== entry.id))
      setPresetDraft(value => value?.id === entry.id ? undefined : value)
      setConfirmingPresetId(undefined)
      setNotice(`已移除预设「${entry.name}」；已有会话不受影响`)
    }).catch(reason => { setError(message(reason)) }).finally(finishAction)
  }
  const removeRegexPack = (entry: RegexPackLibrarySummary): void => {
    if (confirmingRegexPackId !== entry.id) {
      setConfirmingRegexPackId(entry.id)
      return
    }
    startAction(`regex-pack:${entry.id}`)
    void deleteRegexPack(entry.id).then(() => {
      setRegexPacks(value => (value ?? []).filter(item => item.id !== entry.id))
      setConfirmingRegexPackId(undefined)
      setNotice(`已移除正则包「${entry.name}」；已有会话不受影响`)
    }).catch(reason => { setError(message(reason)) }).finally(finishAction)
  }
  const toggleWorldInfoDefault = (entry: WorldInfoLibraryUpload): void => {
    startAction(`world-info-default:${entry.id}`)
    void setWorldInfoDefault(entry.id, !entry.defaultForNewSessions).then(updated => {
      setWorldInfos(value => (value ?? []).map(item => item.id === updated.id ? updated : item))
      setNotice(updated.defaultForNewSessions
        ? `「${updated.name}」会在新 RP 会话中默认加载`
        : `「${updated.name}」改为开聊时手动选择`)
    }).catch(reason => { setError(message(reason)) }).finally(finishAction)
  }
  const adoptEditedWorldInfo = (previousId: string, upload: WorldInfoLibraryUpload): void => {
    // Saving mints a new id, so the row has to adopt it — keeping the old one
    // would leave every later action pointing at a world that no longer exists.
    setWorldInfos(current => current?.map(candidate => candidate.id === previousId ? upload : candidate))
    setNotice(`已保存世界书「${upload.name}」；绑定它的角色卡已同步`)
  }
  const removeWorldInfo = (entry: WorldInfoLibraryUpload): void => {
    if (confirmingWorldInfoId !== entry.id) {
      setConfirmingWorldInfoId(entry.id)
      return
    }
    startAction(`world-info:${entry.id}`)
    void deleteWorldInfo(entry.id).then(removed => {
      setWorldInfos(current => current?.filter(candidate => candidate.id !== removed.id))
      setConfirmingWorldInfoId(undefined)
      setNotice(`已从世界书库移除「${removed.name}」；已开始的会话不受影响`)
    }, reason => { setError(message(reason)) }).finally(finishAction)
  }
  const savePersonaDraft = (): void => {
    if (personaDraft === undefined || personaDraft.name.trim() === '') return
    startAction(personaDraft.id === undefined ? 'persona:new' : `persona:${personaDraft.id}`)
    void savePersona({ format: 0, ...personaDraft }).then(entry => {
      setPersonas(value => [entry, ...(value ?? []).filter(item => item.id !== entry.id)])
      setPersonaDraft(undefined)
      setNotice(`已保存身份「${entry.name}」`)
    }).catch(reason => { setError(message(reason)) }).finally(finishAction)
  }
  const removePersona = (entry: PersonaLibraryEntry): void => {
    if (confirmingPersonaId !== entry.id) {
      setConfirmingPersonaId(entry.id)
      return
    }
    startAction(`persona:${entry.id}`)
    void deletePersona(entry.id).then(() => {
      setPersonas(value => (value ?? []).filter(item => item.id !== entry.id))
      setConfirmingPersonaId(undefined)
      setNotice(`已移除身份「${entry.name}」`)
    }).catch(reason => { setError(message(reason)) }).finally(finishAction)
  }

  const counts: Record<ResourceSection, number | undefined> = {
    characters: characters?.length,
    'world-info': worldInfos?.length,
    presets: presets?.length,
    'regex-packs': regexPacks?.length,
    personas: personas?.length,
  }
  const sections: readonly ResourceSection[] = ['characters', 'world-info', 'presets', 'regex-packs', 'personas']
  const loading = counts[section] === undefined
  const empty = section === 'characters' ? visibleCharacters.length === 0
    : section === 'world-info' ? visibleWorldInfos.length === 0
      : section === 'presets' ? visiblePresets.length === 0
        : section === 'regex-packs' ? visibleRegexPacks.length === 0 : visiblePersonas.length === 0
  const canImport = section !== 'personas'
  const importLabel = section === 'characters' ? '导入角色卡' : section === 'world-info' ? '导入世界书'
    : section === 'regex-packs' ? '导入正则包' : '导入预设'
  const importBusy = busy === (section === 'characters' ? 'import-character'
    : section === 'world-info' ? 'import-world-info'
      : section === 'regex-packs' ? 'import-regex-pack' : 'import-preset')

  const triggerImport = (): void => {
    if (section === 'characters') characterInputRef.current?.click()
    else if (section === 'world-info') worldInfoInputRef.current?.click()
    else if (section === 'presets') presetInputRef.current?.click()
    else if (section === 'regex-packs') regexPackInputRef.current?.click()
  }
  const rowStyle = {
    alignItems: 'center', borderTop: '1px solid var(--dsw-alias-border-l2, #39393c)',
    display: 'flex', gap: '12px', padding: '11px 12px',
  } as const
  const actionStyle = (active = true) => ({
    ...secondaryButtonStyle,
    cursor: active ? 'pointer' : 'default',
    opacity: active ? 1 : .48,
  })

  return <div data-agent-rp-dialog data-agent-rp-surface="resource-center" role="dialog" aria-modal="true"
    aria-label="Agent RP 资源中心" style={{
      alignItems: 'center', background: 'rgba(0,0,0,.52)', display: 'flex', inset: 0, justifyContent: 'center',
      padding: narrow ? '8px' : '24px', position: 'fixed', zIndex: 1001,
    }} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section style={{
      background: 'var(--dsw-alias-bg-base, #171719)', border: '1px solid var(--dsw-alias-border-l2, #39393c)',
      borderRadius: '16px', boxShadow: '0 22px 80px rgba(0,0,0,.36)', display: 'grid',
      gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : '190px minmax(0, 1fr)',
      gridTemplateRows: narrow ? 'auto minmax(0, 1fr)' : 'minmax(0, 1fr)',
      height: narrow ? 'calc(100vh - 16px)' : 'min(700px, calc(100vh - 48px))', maxWidth: '960px',
      overflow: 'hidden', width: narrow ? 'calc(100vw - 16px)' : 'min(960px, calc(100vw - 48px))',
    }}>
      <aside style={{
        borderBottom: narrow ? '1px solid var(--dsw-alias-border-l2, #39393c)' : undefined,
        borderRight: narrow ? undefined : '1px solid var(--dsw-alias-border-l2, #39393c)', padding: narrow ? '12px' : '20px 14px',
      }}>
        <div style={{ alignItems: 'center', display: 'flex', gap: '8px', margin: narrow ? '0 2px 10px' : '0 6px 18px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ fontSize: '17px', margin: 0 }}>资源中心</h2>
            {!narrow && <p style={{ fontSize: '11px', lineHeight: 1.5, margin: '5px 0 0', opacity: .5 }}>跨角色与会话复用的本机内容</p>}
          </div>
          {narrow && <button type="button" aria-label="关闭资源中心" onClick={onClose} style={{
            background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', fontSize: '22px', padding: '2px 5px',
          }}>×</button>}
        </div>
        <div role="tablist" aria-label="资源类型" style={{
          display: 'grid', gap: narrow ? '4px' : '5px', gridTemplateColumns: narrow ? 'repeat(5, minmax(0, 1fr))' : 'minmax(0, 1fr)',
        }}>
          {sections.map(value => <button key={value} type="button" role="tab" aria-selected={section === value}
            onClick={() => { setSection(value); setQuery(''); setError(undefined); setNotice(undefined) }} style={{
              alignItems: 'center', background: section === value ? `color-mix(in srgb, ${accent} 15%, transparent)` : 'transparent',
              border: section === value ? `1px solid color-mix(in srgb, ${accent} 34%, transparent)` : '1px solid transparent',
              borderRadius: '9px', color: 'inherit', cursor: 'pointer', display: 'flex', font: 'inherit', fontSize: narrow ? '11px' : '12px',
              gap: '8px', justifyContent: narrow ? 'center' : 'space-between', padding: narrow ? '7px 4px' : '9px 10px', textAlign: 'left',
            }}><span>{sectionName(value)}</span><span style={{ fontSize: '10px', opacity: .46 }}>{counts[value] ?? '…'}</span></button>)}
        </div>
        <button type="button" data-agent-rp-action="open-sillytavern-library-migration" disabled={busy !== undefined}
          onClick={() => { setMigrationOpen(true); setError(undefined); setNotice(undefined) }} style={{
            ...secondaryButtonStyle, alignItems: 'center', cursor: busy === undefined ? 'pointer' : 'default', display: 'flex',
            fontSize: '11px', gap: '7px', justifyContent: 'center', marginTop: narrow ? '8px' : '14px', padding: '8px 9px', width: '100%',
          }}><span aria-hidden="true">↗</span><span>从 SillyTavern 迁移</span></button>
      </aside>
      <main role="tabpanel" aria-label={`${sectionName(section)}资源`} style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <header style={{ alignItems: 'center', borderBottom: '1px solid var(--dsw-alias-border-l2, #39393c)', display: 'flex', gap: '10px', padding: narrow ? '12px' : '17px 18px' }}>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <strong style={{ display: 'block', fontSize: '15px' }}>{sectionName(section)}</strong>
            <span style={{ display: 'block', fontSize: '11px', marginTop: '2px', opacity: .48 }}>
              {section === 'characters' ? '角色卡与收藏状态' : section === 'world-info' ? '独立世界书来源'
                : section === 'presets' ? '可复用的对话预设'
                  : section === 'regex-packs' ? '会话显式选择的全局正则规则' : '玩家身份与人物设定'}
            </span>
          </div>
          {section === 'personas' && <button type="button" disabled={busy !== undefined} onClick={() => {
            setPersonaDraft({ name: '', description: '' }); setConfirmingPersonaId(undefined)
          }} style={actionStyle(busy === undefined)}>＋ 新建</button>}
          {canImport && <button type="button" disabled={busy !== undefined} onClick={triggerImport}
            style={actionStyle(busy === undefined)}>{importBusy ? '导入中…' : `＋ ${importLabel}`}</button>}
          {!narrow && <button type="button" aria-label="关闭资源中心" onClick={onClose} style={{
            background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', fontSize: '23px', padding: '2px 5px',
          }}>×</button>}
        </header>
        <input ref={characterInputRef} type="file" accept=".png,.json,.charx,image/png,application/json,application/zip" hidden onChange={event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file !== undefined) importResource(file, 'characters')
        }} />
        <input ref={worldInfoInputRef} type="file" accept=".json,application/json" hidden onChange={event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file !== undefined) importResource(file, 'world-info')
        }} />
        <input ref={presetInputRef} type="file" accept=".json,application/json" hidden onChange={event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file !== undefined) importResource(file, 'presets')
        }} />
        <input ref={regexPackInputRef} type="file" accept=".json,application/json" hidden onChange={event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file !== undefined) importResource(file, 'regex-packs')
        }} />
        <div style={{ padding: narrow ? '10px 12px' : '12px 18px' }}>
          <input type="search" value={query} aria-label={`搜索${sectionName(section)}`} placeholder={`搜索${sectionName(section)}`}
            onChange={event => { setQuery(event.target.value) }} style={{
              background: 'var(--dsw-alias-bg-layer-1, #202024)', border: '1px solid var(--dsw-alias-border-l2, #3b3b41)',
              borderRadius: '9px', boxSizing: 'border-box', color: 'inherit', font: 'inherit', fontSize: '12px',
              outline: 'none', padding: '8px 10px', width: '100%',
            }} />
          {notice !== undefined && <p role="status" style={{ color: 'var(--dsw-alias-state-success, #4fba83)', fontSize: '11px', margin: '8px 2px 0' }}>{notice}</p>}
          {error !== undefined && <p role="alert" style={{ color: 'var(--dsw-alias-state-danger, #d64d5f)', fontSize: '11px', margin: '8px 2px 0' }}>{error}</p>}
          {loadErrors[section] !== undefined && <p role="alert" style={{ color: 'var(--dsw-alias-state-danger, #d64d5f)', fontSize: '11px', margin: '8px 2px 0' }}>{loadErrors[section]}</p>}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: narrow ? '0 12px 16px' : '0 18px 18px' }}>
          {section === 'personas' && personaDraft !== undefined && <div style={{
            background: 'var(--dsw-alias-bg-layer-1, #202024)', border: `1px solid color-mix(in srgb, ${accent} 30%, transparent)`,
            borderRadius: '10px', display: 'grid', gap: '8px', marginBottom: '10px', padding: '11px',
          }}>
            <input value={personaDraft.name} maxLength={120} placeholder="身份名称" onChange={event => {
              setPersonaDraft(value => value === undefined ? undefined : { ...value, name: event.target.value })
            }} style={{ background: 'transparent', border: '1px solid var(--dsw-alias-border-l2, #444)', borderRadius: '8px', color: 'inherit', font: 'inherit', padding: '8px' }} />
            <textarea value={personaDraft.description} maxLength={12_000} rows={4} placeholder="身份、外貌、性格或与角色的关系"
              onChange={event => { setPersonaDraft(value => value === undefined ? undefined : { ...value, description: event.target.value }) }}
              style={{ background: 'transparent', border: '1px solid var(--dsw-alias-border-l2, #444)', borderRadius: '8px', color: 'inherit', font: 'inherit', lineHeight: 1.5, padding: '8px', resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button type="button" disabled={busy !== undefined} onClick={() => { setPersonaDraft(undefined) }} style={actionStyle(busy === undefined)}>取消</button>
              <button type="button" disabled={busy !== undefined || personaDraft.name.trim() === ''} onClick={savePersonaDraft} style={{
                ...actionStyle(busy === undefined && personaDraft.name.trim() !== ''), background: accent, borderColor: accent, color: '#fff',
              }}>{busy?.startsWith('persona:') === true ? '保存中…' : '保存身份'}</button>
            </div>
          </div>}
          {section === 'characters' && worldBindingDraft !== undefined && <div style={{
            background: 'var(--dsw-alias-bg-layer-1, #202024)', border: `1px solid color-mix(in srgb, ${accent} 30%, transparent)`,
            borderRadius: '10px', display: 'grid', gap: '10px', marginBottom: '10px', padding: '12px',
          }}>
            <div>
              <strong style={{ display: 'block', fontSize: '13px' }}>{worldBindingDraft.character.displayName} · 默认世界组合</strong>
              <span style={{ display: 'block', fontSize: '10px', lineHeight: 1.55, marginTop: '4px', opacity: .56 }}>
                保存后只影响未来新会话与“导出当前版本”；已有会话和导入的原始角色文件不会改变。
              </span>
            </div>
            <label style={{ display: 'grid', fontSize: '11px', gap: '5px' }}>
              <span>主世界</span>
              <select aria-label="主世界" value={worldBindingDraft.primaryWorldInfoId ?? ''} onChange={event => {
                const primaryWorldInfoId = event.target.value === '' ? null : event.target.value
                setWorldBindingDraft(value => value === undefined ? undefined : { ...value, primaryWorldInfoId })
              }} style={{
                background: 'var(--dsw-alias-bg-base, #171719)', border: '1px solid var(--dsw-alias-border-l2, #444)',
                borderRadius: '8px', color: 'inherit', font: 'inherit', padding: '8px',
              }}>
                <option value="">不绑定主世界</option>
                {(worldInfos ?? []).map(entry => <option key={entry.id} value={entry.id}
                  disabled={worldBindingDraft.additionalWorldInfoIds.includes(entry.id)}>{entry.name}</option>)}
              </select>
            </label>
            <div style={{ display: 'grid', gap: '6px' }}>
              <span style={{ fontSize: '11px' }}>附加世界（按此顺序进入新会话）</span>
              {worldBindingDraft.additionalWorldInfoIds.length === 0
                ? <span style={{ fontSize: '10px', opacity: .5 }}>没有附加世界</span>
                : worldBindingDraft.additionalWorldInfoIds.map((id, index) => <div key={id} style={{
                  alignItems: 'center', display: 'flex', gap: '6px', minWidth: 0,
                }}>
                  <span style={{ flex: 1, fontSize: '11px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {index + 1}. {worldInfoById.get(id)?.name ?? id}
                  </span>
                  <button type="button" aria-label={`上移 ${worldInfoById.get(id)?.name ?? id}`} disabled={index === 0 || busy !== undefined}
                    onClick={() => { setWorldBindingDraft(value => {
                      if (value === undefined || index === 0) return value
                      const additionalWorldInfoIds = [...value.additionalWorldInfoIds]
                      ;[additionalWorldInfoIds[index - 1], additionalWorldInfoIds[index]] = [additionalWorldInfoIds[index]!, additionalWorldInfoIds[index - 1]!]
                      return { ...value, additionalWorldInfoIds }
                    }) }} style={actionStyle(index > 0 && busy === undefined)}>↑</button>
                  <button type="button" aria-label={`下移 ${worldInfoById.get(id)?.name ?? id}`}
                    disabled={index === worldBindingDraft.additionalWorldInfoIds.length - 1 || busy !== undefined}
                    onClick={() => { setWorldBindingDraft(value => {
                      if (value === undefined || index === value.additionalWorldInfoIds.length - 1) return value
                      const additionalWorldInfoIds = [...value.additionalWorldInfoIds]
                      ;[additionalWorldInfoIds[index], additionalWorldInfoIds[index + 1]] = [additionalWorldInfoIds[index + 1]!, additionalWorldInfoIds[index]!]
                      return { ...value, additionalWorldInfoIds }
                    }) }} style={actionStyle(index < worldBindingDraft.additionalWorldInfoIds.length - 1 && busy === undefined)}>↓</button>
                  <button type="button" disabled={busy !== undefined} onClick={() => {
                    setWorldBindingDraft(value => value === undefined ? undefined : {
                      ...value, additionalWorldInfoIds: value.additionalWorldInfoIds.filter(worldInfoId => worldInfoId !== id),
                    })
                  }} style={actionStyle(busy === undefined)}>移除</button>
                </div>)}
              <select aria-label="添加附加世界" value="" disabled={busy !== undefined
                || worldBindingDraft.additionalWorldInfoIds.length + (worldBindingDraft.primaryWorldInfoId === null ? 0 : 1) >= 16}
                onChange={event => {
                  const id = event.target.value
                  if (id === '') return
                  setWorldBindingDraft(value => value === undefined ? undefined : {
                    ...value, additionalWorldInfoIds: [...value.additionalWorldInfoIds, id],
                  })
                }} style={{
                  background: 'var(--dsw-alias-bg-base, #171719)', border: '1px solid var(--dsw-alias-border-l2, #444)',
                  borderRadius: '8px', color: 'inherit', font: 'inherit', padding: '8px',
                }}>
                <option value="">添加附加世界…</option>
                {(worldInfos ?? []).filter(entry => entry.id !== worldBindingDraft.primaryWorldInfoId
                  && !worldBindingDraft.additionalWorldInfoIds.includes(entry.id))
                  .map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button type="button" disabled={busy !== undefined} onClick={() => { setWorldBindingDraft(undefined) }}
                style={actionStyle(busy === undefined)}>取消</button>
              <button type="button" disabled={busy !== undefined} onClick={saveCharacterWorldBinding} style={{
                ...actionStyle(busy === undefined), background: accent, borderColor: accent, color: '#fff',
              }}>{busy === `character-world:${worldBindingDraft.character.id}` ? '保存中…' : '保存世界组合'}</button>
            </div>
          </div>}
          {loading && <div style={{ fontSize: '12px', opacity: .52, padding: '22px 4px' }}>正在读取{sectionName(section)}…</div>}
          {!loading && empty && <div style={{ fontSize: '12px', lineHeight: 1.65, opacity: .55, padding: '22px 4px', textAlign: 'center' }}>
            {normalizedQuery === '' ? `还没有${sectionName(section)}资源` : `没有找到匹配的${sectionName(section)}`}
          </div>}
          {!loading && !empty && <div style={{ border: '1px solid var(--dsw-alias-border-l2, #39393c)', borderRadius: '11px', overflow: 'hidden' }}>
            {section === 'characters' && visibleCharacters.map((entry, index) => <div key={entry.id} style={{ ...rowStyle, borderTop: index === 0 ? 'none' : rowStyle.borderTop }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ display: 'block', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.displayName}</strong>
                <span style={{ display: 'block', fontSize: '10px', marginTop: '4px', opacity: .48, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  V{entry.cardVersion} · {entry.greetingCount} 个开场{entry.worldInfoCount > 0 ? ` · ${entry.worldInfoCount} 条世界书` : ''}{entry.archived ? ' · 已收起' : ''}
                </span>
              </div>
              <button type="button" disabled={busy !== undefined || entry.archived}
                title={entry.archived ? '请先恢复这个角色' : '编辑未来新会话使用的默认世界组合'}
                onClick={() => { editCharacterWorldBinding(entry) }} style={actionStyle(busy === undefined && !entry.archived)}>
                {busy === `character-world:${entry.id}` ? '读取中…' : '世界组合'}
              </button>
              <button type="button" disabled={busy !== undefined} onClick={() => { toggleCharacterArchive(entry) }} style={actionStyle(busy === undefined)}>
                {busy === `character:${entry.id}` ? '处理中…' : entry.archived ? '恢复' : '移入收纳箱'}
              </button>
              {entry.archived && <button type="button" disabled={busy !== undefined} onClick={() => { removeCharacter(entry) }} style={{
                ...actionStyle(busy === undefined),
                color: confirmingCharacterId === entry.id ? 'var(--dsw-alias-state-danger, #e88989)' : 'inherit',
              }}>
                {busy === `character:${entry.id}` ? '删除中…'
                  : confirmingCharacterId === entry.id ? '确认永久删除' : '永久删除'}
              </button>}
            </div>)}
            {section === 'world-info' && visibleWorldInfos.map((entry, index) => <div key={entry.id} style={{ ...rowStyle, borderTop: index === 0 ? 'none' : rowStyle.borderTop }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ display: 'block', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</strong>
                <span style={{ display: 'block', fontSize: '10px', marginTop: '4px', opacity: .48 }}>{entry.entryCount} 条目{entry.defaultForNewSessions ? ' · 新会话默认加载' : ''}{entry.degradations.length > 0 ? ` · ${entry.degradations.length} 项兼容提醒` : ''}</span>
              </div>
              <button type="button" data-agent-rp-action="edit-world-info" disabled={busy !== undefined}
                onClick={() => { setEditingWorldInfo(entry) }} style={actionStyle(busy === undefined)}>编辑</button>
              <button type="button" disabled={busy !== undefined} onClick={() => { toggleWorldInfoDefault(entry) }} style={actionStyle(busy === undefined)}>
                {busy === `world-info-default:${entry.id}` ? '保存中…' : entry.defaultForNewSessions ? '取消默认' : '设为默认'}
              </button>
              <button type="button" disabled={busy !== undefined} onClick={() => { removeWorldInfo(entry) }} style={{
                ...actionStyle(busy === undefined),
                color: confirmingWorldInfoId === entry.id ? 'var(--dsw-alias-state-danger, #e88989)' : 'inherit',
              }}>
                {busy === `world-info:${entry.id}` ? '移除中…' : confirmingWorldInfoId === entry.id ? '确认移除' : '移除'}
              </button>
              {onConfigureWorldInfo !== undefined && <button type="button" disabled={busy !== undefined}
                onClick={() => { onConfigureWorldInfo(entry) }} style={actionStyle(busy === undefined)}>
                开始
              </button>}
            </div>)}
            {section === 'presets' && visiblePresets.map((entry, index) => <div key={entry.id} style={{ ...rowStyle, borderTop: index === 0 ? 'none' : rowStyle.borderTop }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {presetDraft?.id === entry.id
                  ? <input value={presetDraft.name} maxLength={160} aria-label="预设名称" onChange={event => { setPresetDraft({ id: entry.id, name: event.target.value }) }} style={{
                    background: 'var(--dsw-alias-bg-layer-1, #202024)', border: '1px solid var(--dsw-alias-border-l2, #444)', borderRadius: '7px', color: 'inherit', font: 'inherit', padding: '6px 8px', width: '100%',
                  }} />
                  : <strong style={{ display: 'block', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</strong>}
                <span style={{ display: 'block', fontSize: '10px', marginTop: '4px', opacity: .48 }}>{entry.enabledCount}/{entry.promptCount} 项启用{entry.regexScriptCount > 0 ? ` · ${entry.regexScriptCount} 条正则` : ''}</span>
              </div>
              {presetDraft?.id === entry.id ? <>
                <button type="button" disabled={busy !== undefined} onClick={() => { setPresetDraft(undefined) }} style={actionStyle(busy === undefined)}>取消</button>
                <button type="button" disabled={busy !== undefined || presetDraft.name.trim() === ''} onClick={savePresetName} style={actionStyle(busy === undefined && presetDraft.name.trim() !== '')}>{busy === `preset:${entry.id}` ? '保存中…' : '保存'}</button>
              </> : <button type="button" disabled={busy !== undefined} onClick={() => { setPresetDraft({ id: entry.id, name: entry.name }) }} style={actionStyle(busy === undefined)}>改名</button>}
              <button type="button" disabled={busy !== undefined} onClick={() => { removePreset(entry) }} style={{
                ...actionStyle(busy === undefined),
                color: confirmingPresetId === entry.id ? 'var(--dsw-alias-state-danger, #e88989)' : 'inherit',
              }}>
                {busy === `preset:${entry.id}` ? '移除中…' : confirmingPresetId === entry.id ? '确认移除' : '移除'}
              </button>
            </div>)}
            {section === 'regex-packs' && visibleRegexPacks.map((entry, index) => <div key={entry.id} style={{ ...rowStyle, borderTop: index === 0 ? 'none' : rowStyle.borderTop }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ display: 'block', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</strong>
                <span style={{ display: 'block', fontSize: '10px', marginTop: '4px', opacity: .48 }}>
                  {entry.enabledCount}/{entry.scriptCount} 启用 · {entry.displayCount} 显示 · {entry.promptCount} 提示词
                </span>
              </div>
              <button type="button" disabled={busy !== undefined} onClick={() => { removeRegexPack(entry) }} style={{
                ...actionStyle(busy === undefined),
                color: confirmingRegexPackId === entry.id ? 'var(--dsw-alias-state-danger, #e88989)' : 'inherit',
              }}>
                {busy === `regex-pack:${entry.id}` ? '移除中…'
                  : confirmingRegexPackId === entry.id ? '确认移除' : '移除'}
              </button>
            </div>)}
            {section === 'personas' && visiblePersonas.map((entry, index) => <div key={entry.id} style={{ ...rowStyle, alignItems: 'flex-start', borderTop: index === 0 ? 'none' : rowStyle.borderTop }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ display: 'block', fontSize: '13px' }}>{entry.name}</strong>
                <span style={{ display: '-webkit-box', fontSize: '10px', lineHeight: 1.5, marginTop: '4px', opacity: .48, overflow: 'hidden', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 }}>{entry.description || '没有额外人物设定'}</span>
              </div>
              <button type="button" disabled={busy !== undefined} onClick={() => {
                setPersonaDraft({ id: entry.id, name: entry.name, description: entry.description }); setConfirmingPersonaId(undefined)
              }} style={actionStyle(busy === undefined)}>编辑</button>
              <button type="button" disabled={busy !== undefined} onClick={() => { removePersona(entry) }} style={{
                ...actionStyle(busy === undefined), color: confirmingPersonaId === entry.id ? 'var(--dsw-alias-state-danger, #e88989)' : 'inherit',
              }}>{busy === `persona:${entry.id}` ? '移除中…' : confirmingPersonaId === entry.id ? '确认移除' : '移除'}</button>
            </div>)}
          </div>}
        </div>
      </main>
      {migrationOpen && <SillyTavernLibraryMigrationDialog
        accent={accent}
        narrow={narrow}
        characters={characters ?? []}
        worldInfos={worldInfos ?? []}
        importCharacterFile={importCharacterFile}
        importWorldInfoFile={importWorldInfoFile}
        importPresetFile={importPresetFile}
        importRegexPackFile={importRegexPackFile}
        onImported={async report => {
          const [active, archived, nextWorldInfos, nextPresets, nextRegexPacks] = await Promise.all([
            listCharacters('active'), listCharacters('archived'), listWorldInfos(), listPresets(), listRegexPacks(),
          ])
          setCharacters([...active, ...archived])
          setWorldInfos(nextWorldInfos)
          setPresets(nextPresets)
          setRegexPacks(nextRegexPacks)
          setNotice(report.failures.length === 0
            ? `迁移已完成，共处理 ${report.handled} 项`
            : `已处理 ${report.handled} 项，${report.failures.length} 项需要查看原因`)
        }}
        onClose={() => { setMigrationOpen(false) }} />}
    {editingWorldInfo !== undefined && <WorldInfoEditorDialog
      entry={editingWorldInfo}
      load={loadWorldInfoEntries}
      save={saveWorldInfoEntries}
      onSaved={adoptEditedWorldInfo}
      onClose={() => { setEditingWorldInfo(undefined) }} />}
    </section>
  </div>
}
