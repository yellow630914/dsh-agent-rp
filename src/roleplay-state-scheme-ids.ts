/** Browser-safe stable references and the default panel template for native state schemes. */

/** Stable module authority for every state namespace owned by a native scheme. */
export const ROLEPLAY_STATE_SCHEME_MODULE_ID = 'roleplay:state-scheme'

/** Provider ownership id shared by the built-in scheme and the editable library. */
export const ROLEPLAY_STATE_SCHEME_PROVIDER_ID = 'agent-rp-native-state-schemes'

/** Built-in scheme available to any native session without an imported card. */
export const BASIC_ROLEPLAY_STATE_SCHEME_ID = 'state-scheme:native:basic-v0'

/** Opaque prefix marking a scheme that resolves its panel template from the library. */
export const ROLEPLAY_STATE_SCHEME_LIBRARY_PREFIX = 'state-scheme:library:'

/**
 * Opaque prefix for the identity one Session owns for its whole life.
 *
 * Library ids and Session ids are deliberately separate namespaces: the library
 * entry is a reusable source that many Sessions copy from, while the Session id
 * is minted once at launch and never changes — not when the player switches to
 * another library scheme, and not when the Session branches. Switching rewrites
 * `source`; the identity and its state namespace stay put so the values carry over.
 */
export const ROLEPLAY_STATE_SCHEME_SESSION_PREFIX = 'state-scheme:session:'

/** Resolve the library entry backing one scheme's editable panel template. */
export function roleplayStateSchemeLibraryId(resourceId: string | undefined): string | undefined {
  return resourceId !== undefined
    && resourceId.startsWith(ROLEPLAY_STATE_SCHEME_LIBRARY_PREFIX)
    && resourceId.length > ROLEPLAY_STATE_SCHEME_LIBRARY_PREFIX.length
    ? resourceId.slice(ROLEPLAY_STATE_SCHEME_LIBRARY_PREFIX.length)
    : undefined
}

/** Mint the identity one Session keeps across every later scheme change. */
export function roleplayStateSchemeSessionId(unique: string): string {
  return `${ROLEPLAY_STATE_SCHEME_SESSION_PREFIX}${unique.replaceAll('-', '')}`
}

/** Whether this id is the Session-owned identity rather than a reusable source. */
export function isRoleplayStateSchemeSessionId(schemeId: string): boolean {
  return schemeId.startsWith(ROLEPLAY_STATE_SCHEME_SESSION_PREFIX)
}

/** Exact opaque scheme reference written by a library-backed Session seed. */
export function roleplayStateSchemeResourceId(libraryId: string): string {
  return `${ROLEPLAY_STATE_SCHEME_LIBRARY_PREFIX}${libraryId}`
}

/**
 * Fallback panel template used when a scheme has no authored template.
 *
 * It assumes the two-level shape the built-in scheme ships with — a group per
 * top-level key, a row per field inside it — and doubles as the worked example
 * an author starts from. A scalar at the top level renders as a bare group
 * heading, so a different shape wants its own template.
 */
export const BASIC_ROLEPLAY_STATE_PANEL_TEMPLATE = `<style>
.rp-state{display:grid;gap:10px;font:13px/1.55 system-ui,sans-serif}
.rp-state section{border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:8px 10px}
.rp-state h4{margin:0 0 6px;font-size:11px;letter-spacing:.06em;opacity:.6;text-transform:uppercase}
.rp-state .row{display:flex;gap:10px;justify-content:space-between;padding:2px 0}
.rp-state .k{opacity:.62}
.rp-state .v{font-weight:600;text-align:right;overflow-wrap:anywhere}
</style>
<div class="rp-state">
{{#/}}<section>
  <h4>{{@}}</h4>
  {{#.}}<div class="row"><span class="k">{{@}}</span><span class="v">{{.}}</span></div>{{/}}
</section>{{/}}
</div>
`
