/**
 * canonical storage key registry. every `chromatika_*_v*` literal that touches
 * `chrome.storage.local` or `.session` should live here. importing from one place
 * means version bumps stay coordinated and a future migration helper can iterate
 * the full set without grep-and-pray.
 *
 * convention: `chromatika_<domain>_v<N>` (or `chromatika_<domain>_v<N>_<vaultId>`
 * for per-vault scoped state). bump N when the persisted shape changes; the prior
 * key becomes a `*_LEGACY` entry until the next pre-release reset.
 *
 * see `wallet-extension/CLAUDE.md` ("storage key convention") for the rules.
 */

export const STORAGE_KEYS = {
  // vault + unlock
  VAULT_V3: 'chromatika_vault_v3',
  VAULT_V2_LEGACY: 'chromatika_vault_v2',
  UNLOCK_CACHE_V1: 'chromatika_unlock_cache_v1',
  UNLOCK_CACHE_V1_LOCAL_LEGACY: 'chromatika_unlock_cache_v1_local',

  // networks
  ACTIVE_NETWORKS_V1: 'chromatika_active_networks_v1',
  CUSTOM_NETWORKS_V1: 'chromatika_custom_networks_v1',
  EVM_RPC_HEALTH_V1: 'chromatika_evm_rpc_health_v1',
  EVM_WATCHED_TOKENS_V1: 'chromatika_watched_evm_tokens_v1',

  // dapp surface
  DAPP_PERMISSIONS_V2: 'chromatika_dapp_permissions_v2',
  DAPP_PERMISSIONS_V1_LEGACY: 'chromatika_dapp_permissions_v1',
  DAPP_CONSENT_MODE_V1: 'chromatika_dapp_consent_mode_v1',
  DAPP_BRIDGE_DEBUG_V1: 'chromatika_dapp_bridge_debug_v1',

  // app modes + appearance
  ADVANCED_MODE_V1: 'chromatika_advanced_mode_v1',
  APPEARANCE_V1: 'chromatika_appearance_v1',
  IKA_BASE_MODE_V1: 'chromatika_ika_base_mode_v1',
  MEDIA_SAFETY_V1: 'chromatika_media_safety_v1',
  EXPLORER_PREFERENCES_V1: 'chromatika_explorer_preferences_v1',
  PRICE_WATERFALL_V1: 'chromatika_price_waterfall_v1',
  UI_HELP_HINTS_V1: 'chromatika_ui_help_hints_v1',
  ONBOARDING_AUTOTAB_V1: 'chromatika_onboarding_autotab_v1',
  ANIMATIONS_V1: 'chromatika_animations_v1',
  ROCKET_PILOT_HEAD_V1: 'chromatika_rocket_pilot_head_v1',
  ROCKET_PASSENGER_HEAD_V1: 'chromatika_rocket_passenger_head_v1',

  // alerts
  ALERTS_V1: 'chromatika_alerts_v1',
  ALERTS_APPLIED_RULES_V1: 'chromatika_alerts_applied_rules_v1',

  // hardware + biometric
  HARDWARE_ACCOUNTS_V1: 'chromatika_hardware_accounts_v1',
  PASSKEY_CRED_ID_V1: 'chromatika_passkey_cred_id_v1',

  // tx history
  SIGNED_TXS_V1: 'chromatika_signed_txs_v1',

  // pc token + encrypt-lab
  PC_TOKEN_MARKETS_V1: 'chromatika_pc_token_markets_v1',
  PC_DISCLAIMER_V1: 'chromatika_pc_disclaimer_v1',
  LABEL_AUTO_REBUILD_V1: 'chromatika_label_auto_rebuild_v1',

  // x402 payments
  X402_CAPS_V1: 'chromatika_x402_caps_v1',
  X402_RECEIPTS_V1: 'chromatika_x402_receipts_v1',
  X402_PRIVATE_RECEIPTS_V1: 'chromatika_x402_private_receipts_v1',
  X402_RECEIPTS_RETENTION_V1: 'chromatika_x402_receipts_retention_v1',

  // mcp agent surface
  MCP_V1: 'chromatika_mcp_v1',

  // policy vault (global rows; per-vault rows live in VAULT_SCOPED_KEYS)
  POLICY_PACKAGE_V1: 'chromatika_policy_package_v1',

  // deso
  DESO_NODE_V1: 'chromatika_deso_node_v1',

  // operation progress (session-scoped, single-slot)
  OP_PROGRESS_V1: 'chromatika_op_progress_v1',
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

/**
 * per-vault key builders. always pass a real `vaultId` (the value from
 * `SessionState.activeVaultId` or the vault record). rows are removed via the
 * matching helper when a vault is deleted.
 */
export const VAULT_SCOPED_KEYS = {
  /** dwallet meta overlay (per-vault chrome.storage row, fresher than blob-only state). */
  dwalletMeta: (vaultId: string) => `chromatika_dwallet_meta_v2_${vaultId}` as const,
  /** user-set display names for dwallets within a vault. */
  dwalletNames: (vaultId: string) => `chromatika_dwallet_names_v1_${vaultId}` as const,
  /** ordered list of dwallet ids for the home screen card grid. */
  dwalletCardOrder: (vaultId: string) => `chromatika_dwallet_card_order_v1_${vaultId}` as const,
  /** vault-tier (HD-only) network selection for accounts that don't ride a dwallet. */
  vaultNetworks: (vaultId: string) => `chromatika_vault_networks_v1_${vaultId}` as const,
  /** dwallet-tier network selection (mirrors `chromatika_active_networks_v1` for locked UI). */
  dwalletNetworks: (vaultId: string) => `chromatika_dwallet_networks_v1_${vaultId}` as const,
  /** presign id pools (SECP256K1_ECDSA / SECP256K1_TAPROOT / ED25519_EDDSA). */
  presignPools: (vaultId: string) => `chromatika_presign_pools_v3_${vaultId}` as const,
  /** ika protocol fee payment mode + thresholds. */
  ikaFeeSettings: (vaultId: string) => `chromatika_ika_fee_settings_v1_${vaultId}` as const,
  /** policy vault link + dwallet binding. */
  policyVault: (vaultId: string) => `chromatika_policy_vault_v1_${vaultId}` as const,
  /** policy vault presign cap object ids (set when the vault is linked). */
  policyPresigns: (vaultId: string) => `chromatika_policy_presigns_v1_${vaultId}` as const,
  /** policy vault audit log (FIFO, capped at 200 entries). */
  policyAudit: (vaultId: string) => `chromatika_policy_audit_v1_${vaultId}` as const,
  /** deso owner public key link for a vault. */
  desoOwnerLink: (vaultId: string) => `chromatika_deso_owner_link_v1_${vaultId}` as const,
} as const;

/**
 * legacy / removed key prefixes. kept for documentation + sweepers; never write.
 */
export const LEGACY_KEY_PREFIXES = {
  /** pre-Argon2id PBKDF2 vault blob. detected on parse and rejected; user re-onboards. */
  vaultV2: 'chromatika_vault_v2',
  /** plaintext-password unlock cache (pre-derived-key migration). cleared on lock/unlock/write. */
  unlockCacheV1Local: 'chromatika_unlock_cache_v1_local',
  /** old single-permission shape. read-once migration available. */
  dappPermissionsV1: 'chromatika_dapp_permissions_v1',
  /** parent dwallet relations (home nesting UI removed). */
  dwalletParentRelations: 'chromatika_dwallet_parent_relations_v1_',
  /** legacy pc token program config. ignored on read; users re-add in markets panel. */
  pcTokenProgramV1: 'chromatika_pc_token_program_v1',
} as const;
