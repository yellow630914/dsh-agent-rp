/**
 * Identity of the roleplay Agent preset.
 *
 * DSH 0.2.0 replaced the preset-manager plugin and its user preset root with one
 * `@deepseek-ai/dsh-agent-preset` row per preset, declared in the profile
 * composition and submitted to `dsh-agent-preset-registry`. Agent RP's preset is
 * therefore declared in `cordis.patch.yml` and this module keeps only the id
 * both sides agree on.
 *
 * What went away with it: the staging directory, the `.dsh-agent-rp-owner.json`
 * ownership manifest, the content digest and the "contains unowned files" check.
 * Those existed to keep a plugin-written directory distinguishable from a
 * player-authored one; a declared row has no directory to protect.
 */

/** Id of the managed roleplay preset, as declared in `cordis.patch.yml`. */
export const AGENT_RP_PRESET_ID = 'agent-rp'
