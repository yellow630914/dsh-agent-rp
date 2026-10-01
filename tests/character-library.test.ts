import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { CharacterLibrary } from '../src/character-library.ts'
import { parseCharacterCardJsonBytes } from '../src/import/character-card.ts'
import { parseCharx } from '../src/import/charx.ts'
import { readCharacterCardPng } from '../src/import/png.ts'

test('keeps one exact reusable Character Card asset with selectable greetings', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-agent-rp-character-library-'))
  context.after(() => { rmSync(root, { recursive: true, force: true }) })
  const data = new Uint8Array(readFileSync('tests/fixtures/manual-character-card.json'))
  const card = parseCharacterCardJsonBytes(data)
  const library = new CharacterLibrary({ root })

  const first = library.import({
    data,
    filename: '白露.json',
    mediaType: 'application/json',
    card,
    transport: { transport: 'json' },
  })
  const duplicate = library.import({
    data,
    filename: 'renamed.json',
    mediaType: 'application/json',
    card,
    transport: { transport: 'json' },
  })

  assert.equal(library.importWithOutcome({
    data,
    filename: 'another-name.json',
    mediaType: 'application/json',
    card,
    transport: { transport: 'json' },
  }).outcome, 'existing')

  assert.equal(duplicate.id, first.id)
  assert.equal(JSON.parse(readFileSync(join(root, `${first.id}.meta.json`), 'utf8')).index.format, 0)
  assert.deepEqual(library.list(), [{
    id: first.id,
    name: '白露',
    displayName: '白露',
    originalFilename: '白露.json',
    cardVersion: 2,
    greetingCount: 2,
    worldInfoCount: 0,
    regexScriptCount: 0,
    avatarAvailable: false,
    imageAssetCount: 0,
    archived: false,
    tags: [],
    transport: 'json',
    importedAt: first.importedAt,
    updatedAt: first.updatedAt,
  }])
  assert.deepEqual(library.get(first.id).greetings, [
    '门还没锁，你进来吧。',
    '今天来得很早。',
  ])
  const firstResolution = library.resolve(first.id)
  const cachedResolution = library.resolve(first.id)
  assert.equal(cachedResolution.card, firstResolution.card)
  assert.equal(Object.isFrozen(firstResolution.card), true)
  assert.equal(Object.isFrozen(firstResolution.card.frontend), true)
  assert.throws(() => {
    (firstResolution.card as unknown as { name: string }).name = '不应写进缓存'
  }, TypeError)
  assert.deepEqual(library.asset(first.id).data, data)

  assert.equal(library.archive(first.id).archived, true)
  assert.deepEqual(library.list(), [])
  assert.deepEqual(library.list('archived').map(entry => entry.id), [first.id])
  assert.deepEqual(library.asset(first.id).data, data)

  assert.equal(library.restore(first.id).archived, false)
  assert.deepEqual(library.list().map(entry => entry.id), [first.id])
  assert.deepEqual(library.list('archived'), [])
  assert.deepEqual(library.asset(first.id).data, data)

  assert.equal(library.archive(first.id).archived, true)
  const browserImport = library.importFileWithOutcome({ data, filename: '白露.json', mediaType: 'application/json' })
  assert.equal(browserImport.entry.id, first.id)
  assert.equal(browserImport.entry.archived, false)
  assert.equal(browserImport.outcome, 'restored')

  const png = new Uint8Array(readFileSync('tests/fixtures/manual-character-card.png'))
  const pngImport = library.importFile({ data: png, filename: '白露.png', mediaType: 'image/png' })
  assert.equal(pngImport.transport, 'png')
  assert.deepEqual(library.asset(pngImport.id).data, png)
})

test('returns safe Tavern Helper and degradation diagnostics with library entries', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-agent-rp-character-library-diagnostics-'))
  context.after(() => { rmSync(root, { recursive: true, force: true }) })
  const raw = JSON.parse(readFileSync('tests/fixtures/manual-character-card.json', 'utf8')) as Record<string, unknown>
  const cardData = raw.data as Record<string, unknown>
  cardData.group_only_greetings = ['群聊开场不会执行']
  cardData.first_mes = '<标题>开场</标题>'
  cardData.character_book = {
    name: '海城',
    entries: [{
      id: 7, name: '钟楼', keys: ['午夜'], secondary_keys: [], content: '钟楼每天午夜停摆。',
      enabled: true, insertion_order: 10, selective: false, constant: false,
      case_sensitive: false, match_whole_words: false, position: 'after_char', extensions: {},
    }],
  }
  const extensions = cardData.extensions as Record<string, unknown>
  extensions.regex_scripts = [{
    scriptName: '开场界面', findRegex: '/^<标题>(.*?)<\\/标题>$/su', replaceString: '```html\n<h1>$1</h1>\n```',
    trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false,
    runOnEdit: false, substituteRegex: 0, minDepth: null, maxDepth: null,
  }]
  extensions.tavern_helper = [
    ['scripts', [{ id: 'status', name: '状态', content: 'secret script', enabled: true },
      { id: 'off', name: '关闭', content: 'secret script', enabled: false }]],
    ['variables', { privateValue: 'not exposed' }],
    ['legacy_ui', { hidden: true }],
  ]
  const data = new TextEncoder().encode(JSON.stringify(raw))
  const library = new CharacterLibrary({ root })
  const imported = library.importFileWithOutcome({ data, filename: 'diagnostics.json', mediaType: 'application/json' })

  assert.deepEqual(imported.entry.tavernHelper, {
    format: 'entries', scriptCount: 2, enabledScriptCount: 1, variableCount: 1, ignoredFieldCount: 1,
  })
  assert.deepEqual(imported.entry.degradations, ['group-greetings'])
  assert.deepEqual(imported.entry.regexScripts, [{
    index: 0,
    scriptName: '开场界面',
    enabled: true,
    state: 'active',
    placement: [2],
    unsupportedPlacement: [],
    display: true,
    prompt: false,
    runOnEdit: false,
    minDepth: null,
    maxDepth: null,
    locallyOverridden: false,
    replacedByDisplayExtension: false,
  }])
  assert.equal(imported.entry.greetings[0], '<标题>开场</标题>')
  assert.equal(imported.entry.renderedGreetings[0], '```html\n<h1>开场</h1>\n```')
  assert.deepEqual(imported.entry.worldInfo, {
    name: '海城',
    entries: [{
      sourceId: '7', name: '钟楼', keys: ['午夜'], secondaryKeys: [], content: '钟楼每天午夜停摆。',
      enabled: true, constant: false, selective: false, useRegex: false,
    }],
  })
  assert.deepEqual(library.worldInfoPage(imported.entry.id, 0, 1), {
    name: '海城',
    offset: 0,
    total: 1,
    entries: [{
      sourceId: '7', name: '钟楼', keys: ['午夜'], secondaryKeys: [], content: '钟楼每天午夜停摆。',
      enabled: true, constant: false, selective: false, useRegex: false,
    }],
  })
  assert.deepEqual(library.worldInfoPage(imported.entry.id, 1, 1)?.entries, [])
  assert.equal(library.overview(imported.entry.id).worldInfo, undefined)
  assert.equal(library.overview(imported.entry.id).worldInfoCount, 1)
  assert.deepEqual(library.list()[0]?.tavernHelper, imported.entry.tavernHelper)
  assert.equal(JSON.stringify(imported.entry).includes('secret script'), false)
  assert.equal(JSON.stringify(imported.entry).includes('not exposed'), false)
  assert.equal(JSON.stringify(imported.entry).includes('findRegex'), false)
  assert.equal(JSON.stringify(imported.entry).includes('replaceString'), false)
})

test('keeps the original CHARX archive reusable', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-agent-rp-character-library-charx-'))
  context.after(() => { rmSync(root, { recursive: true, force: true }) })
  const raw = JSON.parse(readFileSync('tests/fixtures/manual-character-card.json', 'utf8')) as Record<string, unknown>
  const data = raw.data as Record<string, unknown>
  raw.spec = 'chara_card_v3'
  raw.spec_version = '3.0'
  data.group_only_greetings = []
  data.assets = [
    { type: 'icon', uri: 'embeded://assets/icon/images/main.png', name: 'main', ext: 'png' },
    { type: 'background', uri: 'embeded://assets/background/images/rain.webp', name: 'rain', ext: 'webp' },
    { type: 'emotion', uri: 'embeded://assets/emotion/images/smile.png', name: 'smile', ext: 'png' },
  ]
  const avatar = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
  const background = Uint8Array.from([0x52, 0x49, 0x46, 0x46])
  const emotion = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x01])
  const archive = zipSync({
    'card.json': strToU8(JSON.stringify(raw)),
    'assets/icon/images/main.png': avatar,
    'assets/background/images/rain.webp': background,
    'assets/emotion/images/smile.png': emotion,
  })
  const library = new CharacterLibrary({ root })
  const imported = library.import({
    data: archive,
    filename: '白露.charx',
    mediaType: 'application/zip',
    card: parseCharx(archive).card,
    transport: { transport: 'charx' },
  })

  assert.equal(library.importFile({ data: archive, filename: '白露.charx' }).id, imported.id)

  assert.equal(imported.transport, 'charx')
  assert.equal(imported.avatarAvailable, true)
  assert.deepEqual(library.avatar(imported.id), { mediaType: 'image/png', data: avatar })
  assert.equal(imported.imageAssetCount, 3)
  assert.deepEqual(imported.imageAssets, [
    { index: 0, type: 'icon', name: 'main', mediaType: 'image/png', sourceUri: 'embeded://assets/icon/images/main.png' },
    { index: 1, type: 'background', name: 'rain', mediaType: 'image/webp', sourceUri: 'embeded://assets/background/images/rain.webp' },
    { index: 2, type: 'emotion', name: 'smile', mediaType: 'image/png', sourceUri: 'embeded://assets/emotion/images/smile.png' },
  ])
  assert.deepEqual(library.image(imported.id, 0), {
    index: 0, type: 'icon', name: 'main', mediaType: 'image/png',
    sourceUri: 'embeded://assets/icon/images/main.png', data: avatar,
  })
  assert.deepEqual(library.image(imported.id, 1)?.data, background)
  assert.deepEqual(library.image(imported.id, 2)?.data, emotion)
  assert.equal(library.image(imported.id, 3), undefined)
  assert.deepEqual(library.asset(imported.id).data, archive)
  const edited = library.updateContent(imported.id, { ...imported.content, name: 'CHARX 本机版' }, 0)
  const exported = library.exportModified(imported.id)
  assert.equal(exported.mediaType, 'application/zip')
  assert.equal(parseCharx(exported.data).card.name, 'CHARX 本机版')
  assert.deepEqual(library.asset(edited.id).data, archive)
})

test('keeps local wording fixes and standalone display regexes beside the original card', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-agent-rp-character-overlay-'))
  context.after(() => { rmSync(root, { recursive: true, force: true }) })
  const raw = JSON.parse(readFileSync('tests/fixtures/manual-character-card.json', 'utf8')) as Record<string, unknown>
  const cardData = raw.data as Record<string, unknown>
  cardData.first_mes = '<角色图片><img>角色图image.png</img></角色图片>\n门还没锁。'
  const extensions = cardData.extensions as Record<string, unknown>
  const replacement = '<center><img src=https://cdn.example.com/$1 width=50% /></center>'
  extensions.regex_scripts = [{
    scriptName: '旧图片规则',
    findRegex: '<(?:illustration|img)>.*[^A-Za-z0-9\\.\\s<\\/>]+(.*?)<\\/(?:illustration|img)>/g',
    replaceString: replacement,
    trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false,
    runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null,
  }]
  const data = new TextEncoder().encode(JSON.stringify(raw))
  const library = new CharacterLibrary({ root })
  const imported = library.importFile({ data, filename: 'overlay.json', mediaType: 'application/json' })
  assert.deepEqual(imported.remoteResourceOrigins, ['https://cdn.example.com'])
  assert.deepEqual(imported.remoteResources, [{ origin: 'https://cdn.example.com', type: 'image' }])
  assert.deepEqual(imported.approvedRemoteResourceOrigins, [])
  assert.deepEqual(imported.approvedRemoteResources, [])
  assert.equal(imported.remoteResourcePolicy, 'prompt')
  assert.equal(library.setRemoteResourcePolicy(imported.id, 'isolated-https').remoteResourcePolicy, 'isolated-https')
  assert.equal(library.get(imported.id).remoteResourcePolicy, 'isolated-https')
  assert.equal(library.setRemoteResourcePolicy(imported.id, 'prompt').remoteResourcePolicy, 'prompt')

  const approved = library.setRemoteResourceOriginApproved(imported.id, 'https://cdn.example.com', true)
  assert.deepEqual(approved.approvedRemoteResourceOrigins, ['https://cdn.example.com'])
  assert.equal(approved.approvedRemoteResources.length, 7)
  assert.deepEqual(library.get(imported.id).approvedRemoteResourceOrigins, ['https://cdn.example.com'])
  assert.deepEqual(library.setRemoteResourceOriginApproved(imported.id, 'https://cdn.example.com', false)
    .approvedRemoteResourceOrigins, [])
  assert.throws(() => library.setRemoteResourceOriginApproved(imported.id, 'https://other.example.com', true),
    /没有引用/u)
  const dynamic = library.setRemoteResourceApproved(imported.id, 'https://runtime.example.com/app.js', 'script', true)
  assert.deepEqual(dynamic.approvedRemoteResources, [{ origin: 'https://runtime.example.com', type: 'script' }])
  assert.deepEqual(dynamic.approvedRemoteResourceOrigins, [])
  assert.deepEqual(dynamic.remoteResourceOrigins, ['https://cdn.example.com', 'https://runtime.example.com'])
  assert.deepEqual(library.setRemoteResourceApproved(
    imported.id, 'https://runtime.example.com', 'script', false,
  ).approvedRemoteResources, [])

  const corrected = library.replaceText(imported.id, '门还没锁', '门已经打开')
  assert.equal(corrected.localCorrectionCount, 1)
  assert.match(corrected.greetings[0]!, /门已经打开/u)
  assert.deepEqual(library.asset(imported.id).data, data)

  const extension = new TextEncoder().encode(JSON.stringify({
    scriptName: '插图 DLC',
    findRegex: '/<(?:illustration|img)>.*[^A-Za-z0-9\\.\\s<\\/>]+(.*?)<\\/(?:illustration|img)>/g',
    replaceString: replacement,
    trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false,
    runOnEdit: true,
  }))
  assert.throws(() => library.importDisplayExtension(imported.id, {
    data: extension, filename: '插图.json', approvedImageOrigins: [],
  }), /确认.*外部图片域名/u)
  const extended = library.importDisplayExtension(imported.id, {
    data: extension, filename: '插图.json', approvedImageOrigins: ['https://cdn.example.com'],
  })
  assert.equal(extended.displayExtensions.length, 1)
  assert.equal(library.resolve(imported.id).card.frontend.regexScripts.at(-1)?.scriptName, '插图 DLC')
  assert.deepEqual(extended.displayExtensions[0]?.remoteImageOrigins, ['https://cdn.example.com'])
  assert.deepEqual(extended.displayExtensions[0]?.replacedCardRegexNames, ['旧图片规则'])
  assert.match(extended.renderedGreetings[0]!, /<img src=https:\/\/cdn\.example\.com\/image\.png/u)
  assert.doesNotMatch(extended.renderedGreetings[0]!, /角色图片/u)
  assert.deepEqual(library.asset(imported.id).data, data)

  const extensionId = extended.displayExtensions[0]!.id
  const enabledCard = library.resolve(imported.id).card
  const paused = library.setDisplayExtensionEnabled(imported.id, extensionId, false)
  assert.equal(paused.displayExtensions[0]?.enabled, false)
  const pausedCard = library.resolve(imported.id).card
  assert.notEqual(pausedCard, enabledCard)
  assert.equal(pausedCard.frontend.regexScripts.at(-1)?.scriptName, '旧图片规则')
  assert.equal(library.setDisplayExtensionEnabled(imported.id, extensionId, true).displayExtensions[0]?.enabled, true)
  assert.notEqual(library.resolve(imported.id).card, pausedCard)
  assert.equal(library.removeDisplayExtension(imported.id, extensionId).displayExtensions.length, 0)
  assert.deepEqual(library.asset(imported.id).data, data)
})

test('saves reversible character fields and regex switches beside every original transport', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-agent-rp-character-revisions-'))
  context.after(() => { rmSync(root, { recursive: true, force: true }) })
  const source = JSON.parse(readFileSync('tests/fixtures/manual-character-card.json', 'utf8')) as Record<string, unknown>
  const sourceData = source.data as Record<string, unknown>
  const extensions = sourceData.extensions as Record<string, unknown>
  extensions.regex_scripts = [{
    scriptName: '称呼替换', findRegex: '/白露/gu', replaceString: '小白', trimStrings: [], placement: [2],
    disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false, substituteRegex: 0,
    minDepth: null, maxDepth: null,
  }]
  const bytes = new TextEncoder().encode(JSON.stringify(source))
  const library = new CharacterLibrary({ root })
  const imported = library.importFile({ data: bytes, filename: '白露.json', mediaType: 'application/json' })
  const originalCard = library.resolve(imported.id).card
  const edited = library.updateContent(imported.id, {
    ...imported.content,
    name: '白露·本机版',
    description: '只在本机修改的角色描述。',
    firstMessage: '新的默认开场。',
    alternateGreetings: ['新的备选开场。'],
  }, 0)

  assert.equal(edited.localRevision, 1)
  assert.equal(edited.localEdits, true)
  assert.equal(edited.name, '白露·本机版')
  assert.deepEqual(edited.greetings, ['新的默认开场。', '新的备选开场。'])
  const contentEditedCard = library.resolve(imported.id).card
  assert.notEqual(contentEditedCard, originalCard)
  assert.equal(contentEditedCard.name, '白露·本机版')
  assert.deepEqual(library.asset(imported.id).data, bytes)
  assert.throws(() => library.updateContent(imported.id, edited.content, 0), /已在别处改变/u)

  const regexEdited = library.setRegexEnabled(imported.id, 0, false, 1)
  assert.equal(regexEdited.localRevision, 2)
  assert.equal(regexEdited.regexScripts[0]?.enabled, false)
  assert.equal(regexEdited.regexScripts[0]?.locallyOverridden, true)
  const regexEditedCard = library.resolve(imported.id).card
  assert.notEqual(regexEditedCard, contentEditedCard)
  assert.equal(regexEditedCard.frontend.regexScripts[0]?.disabled, true)
  assert.equal(parseCharacterCardJsonBytes(library.exportModified(imported.id).data).name, '白露·本机版')

  const restored = library.resetLocalEdits(imported.id, 2)
  assert.equal(restored.localRevision, 3)
  assert.equal(restored.localEdits, false)
  assert.equal(restored.name, '白露')
  assert.equal(restored.regexScripts[0]?.enabled, true)

  const png = new Uint8Array(readFileSync('tests/fixtures/manual-character-card.png'))
  const pngEntry = library.importFile({ data: png, filename: '白露.png', mediaType: 'image/png' })
  const pngEdited = library.updateContent(pngEntry.id, { ...pngEntry.content, name: 'PNG 本机版' }, 0)
  const exportedPng = library.exportModified(pngEntry.id)
  assert.equal(exportedPng.mediaType, 'image/png')
  assert.equal(parseCharacterCardJsonBytes(new TextEncoder().encode(readCharacterCardPng(exportedPng.data).json)).name, 'PNG 本机版')
  assert.deepEqual(library.asset(pngEdited.id).data, png)
})

test('the archive carries no categories, so a restore lands unlabelled', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-agent-rp-character-tags-'))
  context.after(() => { rmSync(root, { recursive: true, force: true }) })
  const data = new Uint8Array(readFileSync('tests/fixtures/manual-character-card.json'))
  const library = new CharacterLibrary({ root })
  const entry = library.import({
    data,
    filename: '白露.json',
    mediaType: 'application/json',
    card: parseCharacterCardJsonBytes(data),
    transport: { transport: 'json' },
  })

  assert.deepEqual(library.setTags(entry.id, ['主线', ' 西幻 ']).tags.length, 2)
  assert.equal(library.list('active')[0]?.tags.length, 2)

  // Into the archive without them, and back out unlabelled: a restore always
  // lands in 未分类 rather than in a category the player may have since dropped.
  assert.deepEqual(library.archive(entry.id).tags, [])
  assert.deepEqual(library.list('archived')[0]?.tags, [])
  assert.deepEqual(library.restore(entry.id).tags, [])
  assert.deepEqual(library.list('active')[0]?.tags, [])

  library.archive(entry.id)
  assert.throws(() => library.setTags(entry.id, ['主线']), /收纳箱/u)
})
