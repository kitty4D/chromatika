import { TypedDataEncoder, getAddress, getBytes, hexlify, isAddress, type TypedDataField } from 'ethers';
import { RPC_USER_REJECTED, RPC_UNSUPPORTED_METHOD } from '@/lib/dapp-bridge-result';
import { getSession } from '@/background/session';
import { signMessageEvm, signBytesEvm } from '@/background/chains/signing';
import { getEvmAddressForOrigin } from '@/background/chains/evm';
import { getRpcProvider, sendEvmRpcWithRetry } from '@/background/chains/evm-send';
import {
  canAccessChain,
  canUseMethod,
  getPermission,
  upsertPermission,
  getEip2255PermissionsFiltered,
} from '@/background/dapp-permissions';
import { getActiveNetworks } from '@/background/network/active-network';
import { findEvmNetwork } from '@/config/networks';
import { getCustomNetworks, addCustomEvm } from '@/background/network/custom-networks';
import { lookupEvmNetworkFromChainlistByChainId } from '@/background/network/chainlist';
import { verifyEvmRpcForChain } from '@/background/network/evm-rpc-verify';
import { broadcastToTabs } from '@/background/broadcast';
import { decodeTx } from '@/background/tx-decode';
import { personalSignMessageBody } from '@/background/chains/evm-eip191';
import { enqueueTxApproval } from '@/background/tx-approval';
import { enqueueDappApproval } from '@/background/dapp-approval';
import { addWatchedEvmToken } from '@/background/network/evm-watched-tokens';
import { invalidateEvmTokenBalanceCache } from '@/background/chains/evm-tokens';
import { enqueueHardwareSign } from '@/background/hardware/pending-queue';
import { findLedgerEvmAccount } from '@/background/hardware/accounts';
import {
  ETH_SEND_RAW_UNSUPPORTED_MSG,
  LEGACY_ENC_API_MSG,
  LEGACY_ETH_SIGN_MSG,
  LEGACY_ETH_SIGN_TYPED_DATA_V1_MSG,
  MUST_NOT_PROXY_ETH,
  ensureEthAccountsForOrigin,
  parseEip712Payload,
  parseWalletPermissionObjectKeys,
  setEvmActiveForDapp,
  type BridgeCtx,
  type HandlerResult,
} from './internal';

export async function handleEthMethod(ctx: BridgeCtx): Promise<HandlerResult> {
  const { method, params, origin, consentMode, log } = ctx;

  if (method === 'eth_requestAccounts') {
    const r = await ensureEthAccountsForOrigin(origin, method, log);
    if (!r.ok) return r;
    await log(true);
    return { ok: true, result: [r.address] };
  }

  if (method === 'wallet_requestPermissions') {
    const requested = parseWalletPermissionObjectKeys(params);
    if (requested.length === 0) {
      return { ok: false, error: 'wallet_requestPermissions requires a non-empty permission object', code: RPC_UNSUPPORTED_METHOD };
    }
    const unknown = requested.filter((c) => c !== 'eth_accounts');
    if (unknown.length > 0) {
      return {
        ok: false,
        error: `Chromatika does not support requested capabilities: ${unknown.join(', ')}`,
        code: RPC_UNSUPPORTED_METHOD,
      };
    }
    const r = await ensureEthAccountsForOrigin(origin, method, log);
    if (!r.ok) return r;
    const objects = await getEip2255PermissionsFiltered(origin, ['eth_accounts']);
    await log(true);
    return { ok: true, result: objects };
  }

  if (method === 'wallet_getPermissions') {
    const filterCaps = parseWalletPermissionObjectKeys(params);
    const permitted = await getPermission(origin);
    if (!permitted?.scope.accounts) {
      return { ok: true, result: [] };
    }
    const objects = await getEip2255PermissionsFiltered(
      origin,
      filterCaps.length > 0 ? filterCaps : undefined,
    );
    await log(true);
    return { ok: true, result: objects };
  }

  if (method === 'eth_sign') {
    await log(false, 'eth_sign_unsupported');
    return { ok: false, error: LEGACY_ETH_SIGN_MSG, code: RPC_UNSUPPORTED_METHOD };
  }

  if (method === 'eth_signTypedData') {
    await log(false, 'eth_signTypedData_v1_unsupported');
    return { ok: false, error: LEGACY_ETH_SIGN_TYPED_DATA_V1_MSG, code: RPC_UNSUPPORTED_METHOD };
  }

  if (method === 'eth_sendRawTransaction') {
    await log(false, 'eth_sendRawTransaction_blocked');
    return { ok: false, error: ETH_SEND_RAW_UNSUPPORTED_MSG, code: RPC_UNSUPPORTED_METHOD };
  }

  if (method === 'eth_decrypt' || method === 'eth_getEncryptionPublicKey') {
    await log(false, 'legacy_enc_api');
    return { ok: false, error: LEGACY_ENC_API_MSG, code: RPC_UNSUPPORTED_METHOD };
  }

  if (method === 'eth_accounts') {
    const s = getSession();
    if (!s) return { ok: true, result: [] };
    const permitted = await getPermission(origin);
    if (!permitted?.scope.accounts) return { ok: true, result: [] };
    const address = await getEvmAddressForOrigin(origin);
    return { ok: true, result: [address] };
  }

  if (method === 'eth_chainId') {
    const { evmChainId } = await getActiveNetworks();
    return { ok: true, result: `0x${evmChainId.toString(16)}` };
  }

  if (method === 'net_version') {
    const { evmChainId } = await getActiveNetworks();
    return { ok: true, result: String(evmChainId) };
  }

  if (method === 'wallet_switchEthereumChain') {
    const permission = await getPermission(origin);
    if (consentMode === 'strict' && !canUseMethod(permission, method)) return { ok: false, error: 'Permission denied for wallet_switchEthereumChain' };
    const p = (params ?? [])[0] as { chainId?: string } | undefined;
    const chainId = p?.chainId ? parseInt(p.chainId, 16) : undefined;
    if (!chainId) return { ok: false, error: 'Missing chainId' };
    const { evmChainId } = await getActiveNetworks();
    if (evmChainId === chainId) {
      await log(true);
      return { ok: true, result: null };
    }
    const { evm: customEvm } = await getCustomNetworks();
    const found = findEvmNetwork(chainId, customEvm);
    if (!found) {
      let discovered: Awaited<ReturnType<typeof lookupEvmNetworkFromChainlistByChainId>> = null;
      try {
        discovered = await lookupEvmNetworkFromChainlistByChainId(chainId);
      } catch {
        // chainlist fetch failed - surface 4902 below
      }
      if (!discovered) {
        await log(false, 'switch_chain_not_added');
        return { ok: false, error: JSON.stringify({ code: 4902, message: 'Chain not added - use wallet_addEthereumChain' }) };
      }
      const addApproval = await enqueueDappApproval({
        kind: 'add_chain',
        origin,
        method,
        chainId,
        addChain: {
          chainId: discovered.chainId,
          chainName: discovered.name,
          rpcUrl: discovered.rpcUrl,
          symbol: discovered.symbol,
          decimals: discovered.decimals,
          explorerUrl: discovered.explorerUrl,
        },
      });
      if (!addApproval.approved) {
        return { ok: false, error: 'User rejected the request', code: RPC_USER_REJECTED };
      }
      const rpcCheck = await verifyEvmRpcForChain(chainId, discovered.rpcUrl);
      if (!rpcCheck.ok) {
        return { ok: false, error: rpcCheck.error };
      }
      await addCustomEvm({
        name: discovered.name,
        chainId: discovered.chainId,
        rpcUrl: discovered.rpcUrl,
        symbol: discovered.symbol,
        decimals: discovered.decimals,
        explorerUrl: discovered.explorerUrl,
      });
      await setEvmActiveForDapp(chainId);
      await upsertPermission(origin, { scope: { chainIds: [chainId], canAddChain: true } });
      broadcastToTabs('chainChanged', `0x${chainId.toString(16)}`);
      await log(true);
      return { ok: true, result: null };
    }
    const approval = await enqueueDappApproval({
      kind: 'switch_chain',
      origin,
      method,
      chainId,
      requestedChainId: chainId,
    });
    if (!approval.approved) {
      return { ok: false, error: 'User rejected the request', code: RPC_USER_REJECTED };
    }
    await setEvmActiveForDapp(chainId);
    await upsertPermission(origin, { scope: { chainIds: [chainId], canSwitchChain: true } });
    broadcastToTabs('chainChanged', `0x${chainId.toString(16)}`);
    await log(true);
    return { ok: true, result: null };
  }

  if (method === 'wallet_watchAsset') {
    const s = getSession();
    if (!s) return { ok: false, error: 'Wallet locked' };
    const permission = await getPermission(origin);
    if (consentMode === 'strict' && !canUseMethod(permission, method)) {
      return { ok: false, error: 'Permission denied for wallet_watchAsset' };
    }
    if (!permission?.scope.accounts) {
      return { ok: false, error: 'connect with eth_requestAccounts before wallet_watchAsset' };
    }
    const first = (params ?? [])[0] as
      | { type?: string; options?: { address?: string; symbol?: string; decimals?: number; image?: string } }
      | undefined;
    if (!first || first.type !== 'ERC20' || !first.options?.address) {
      return { ok: false, error: 'wallet_watchAsset requires { type: "ERC20", options: { address, ... } }' };
    }
    const addrRaw = first.options.address.trim();
    if (!isAddress(addrRaw)) {
      return { ok: false, error: 'Invalid token contract address' };
    }
    const tokenAddress = getAddress(addrRaw);
    const symbol = typeof first.options.symbol === 'string' ? first.options.symbol : '???';
    const decimals =
      typeof first.options.decimals === 'number' && Number.isFinite(first.options.decimals)
        ? Math.max(0, Math.min(255, Math.floor(first.options.decimals)))
        : 18;
    const image = typeof first.options.image === 'string' ? first.options.image : undefined;
    const { evmChainId } = await getActiveNetworks();
    const walletAddress = await getEvmAddressForOrigin(origin);
    const approval = await enqueueDappApproval({
      kind: 'watch_token',
      origin,
      method,
      chainId: evmChainId,
      watchToken: { address: tokenAddress, symbol, decimals, image },
    });
    if (!approval.approved) {
      return { ok: false, error: 'User rejected the request', code: RPC_USER_REJECTED };
    }
    await addWatchedEvmToken(evmChainId, walletAddress, {
      contractAddress: tokenAddress,
      symbol,
      decimals,
      image,
    });
    invalidateEvmTokenBalanceCache(walletAddress, evmChainId);
    await log(true);
    return { ok: true, result: true };
  }

  if (method === 'wallet_addEthereumChain') {
    const permission = await getPermission(origin);
    if (consentMode === 'strict' && !canUseMethod(permission, method)) return { ok: false, error: 'Permission denied for wallet_addEthereumChain' };
    const p = (params ?? [])[0] as {
      chainId?: string;
      chainName?: string;
      rpcUrls?: string[];
      nativeCurrency?: { name: string; symbol: string; decimals: number };
      blockExplorerUrls?: string[];
    } | undefined;
    if (!p?.chainId || !p.chainName || !p.rpcUrls?.length || !p.nativeCurrency) {
      return { ok: false, error: 'Invalid chain params' };
    }
    const chainId = parseInt(p.chainId, 16);
    const rpcUrl = p.rpcUrls.find((r) => r.startsWith('https://'));
    if (!rpcUrl) return { ok: false, error: 'wallet_addEthereumChain requires https rpcUrl' };
    const approval = await enqueueDappApproval({
      kind: 'add_chain',
      origin,
      method,
      chainId,
      addChain: {
        chainId,
        chainName: p.chainName,
        rpcUrl,
        symbol: p.nativeCurrency.symbol,
        decimals: p.nativeCurrency.decimals,
        explorerUrl: p.blockExplorerUrls?.[0],
      },
    });
    if (!approval.approved) {
      return { ok: false, error: 'User rejected the request', code: RPC_USER_REJECTED };
    }
    const rpcCheck = await verifyEvmRpcForChain(chainId, rpcUrl);
    if (!rpcCheck.ok) {
      return { ok: false, error: rpcCheck.error };
    }
    await addCustomEvm({
      name: p.chainName,
      chainId,
      rpcUrl,
      symbol: p.nativeCurrency.symbol,
      decimals: p.nativeCurrency.decimals,
      explorerUrl: p.blockExplorerUrls?.[0],
    });
    await setEvmActiveForDapp(chainId);
    await upsertPermission(origin, { scope: { chainIds: [chainId], canAddChain: true } });
    broadcastToTabs('chainChanged', `0x${chainId.toString(16)}`);
    await log(true);
    return { ok: true, result: null };
  }

  if (method === 'personal_sign') {
    const s = getSession();
    if (!s) return { ok: false, error: 'Wallet locked' };
    const permission = await getPermission(origin);
    if (consentMode === 'strict' && !canUseMethod(permission, method)) return { ok: false, error: 'Permission denied for personal_sign' };
    const p = params ?? [];
    let msgParam = p[0] as string | undefined;
    const secondParam = p[1] as string | undefined;
    if (
      typeof msgParam === 'string' &&
      typeof secondParam === 'string' &&
      isAddress(msgParam) &&
      !isAddress(secondParam)
    ) {
      msgParam = secondParam;
    }
    const message =
      typeof msgParam === 'string'
        ? msgParam
        : msgParam != null && typeof msgParam === 'object' && 'toString' in msgParam
          ? String(msgParam)
          : '';
    const approval = await enqueueDappApproval({
      kind: 'sign_personal',
      origin,
      method,
      messagePreview: message.slice(0, 180),
    });
    if (!approval.approved) {
      return { ok: false, error: 'User rejected the request', code: RPC_USER_REJECTED };
    }
    const { evmChainId } = await getActiveNetworks();
    const fromAddr = await getEvmAddressForOrigin(origin);
    const hw = await findLedgerEvmAccount(fromAddr);
    let signature: string;
    if (hw) {
      const body = personalSignMessageBody(message);
      const msgHex = hexlify(body).replace(/^0x/i, '');
      signature = await enqueueHardwareSign({
        vendor: 'ledger',
        chain: 'evm',
        derivationPath: hw.derivationPath,
        payloadHex: msgHex,
        kind: 'message',
      });
    } else {
      ({ signature } = await signMessageEvm(message, evmChainId, { dappOrigin: origin }));
    }
    await log(true);
    return { ok: true, result: signature };
  }

  if (method === 'eth_signTypedData_v3' || method === 'eth_signTypedData_v4') {
    const s = getSession();
    if (!s) return { ok: false, error: 'Wallet locked' };
    const permission = await getPermission(origin);
    if (consentMode === 'strict' && !canUseMethod(permission, method)) {
      return { ok: false, error: `Permission denied for ${method}` };
    }
    const raw = (params ?? [])[1];
    let domain: Parameters<typeof TypedDataEncoder.hashDomain>[0];
    let cleanTypes: Record<string, TypedDataField[]>;
    let value: Record<string, unknown>;
    try {
      const parsed = parseEip712Payload(raw);
      domain = parsed.domain;
      cleanTypes = parsed.cleanTypes;
      value = parsed.value;
    } catch {
      return { ok: false, error: 'Invalid EIP-712 typed data' };
    }
    const { evmChainId } = await getActiveNetworks();
    const preimage = TypedDataEncoder.encode(domain, cleanTypes, value);
    const msgBytes = getBytes(preimage);
    const approval = await enqueueDappApproval({
      kind: 'sign_typed_data',
      origin,
      method,
      typedDataPreview: typeof raw === 'string' ? raw.slice(0, 240) : JSON.stringify(raw).slice(0, 240),
    });
    if (!approval.approved) {
      return { ok: false, error: 'User rejected the request', code: RPC_USER_REJECTED };
    }
    const fromAddr = await getEvmAddressForOrigin(origin);
    const hw = await findLedgerEvmAccount(fromAddr);
    let signature: string;
    if (hw) {
      const primaryType = TypedDataEncoder.getPrimaryType(cleanTypes);
      const dh = TypedDataEncoder.hashDomain(domain);
      const sh = TypedDataEncoder.hashStruct(primaryType, cleanTypes, value);
      const payloadHex = dh + sh;
      signature = await enqueueHardwareSign({
        vendor: 'ledger',
        chain: 'evm',
        derivationPath: hw.derivationPath,
        payloadHex,
        kind: 'typedData',
      });
    } else {
      ({ signature } = await signBytesEvm(msgBytes, evmChainId, { dappOrigin: origin }));
    }
    await log(true);
    return { ok: true, result: signature };
  }

  if (method === 'eth_sendTransaction') {
    const s = getSession();
    if (!s) return { ok: false, error: 'Wallet locked' };
    const permission = await getPermission(origin);
    if (consentMode === 'strict' && !canUseMethod(permission, method)) return { ok: false, error: 'Permission denied for eth_sendTransaction' };
    const p = (params ?? [])[0] as {
      from?: string; to?: string; value?: string; data?: string;
      gas?: string; gasPrice?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string; nonce?: string;
      accessList?: unknown;
    } | undefined;
    if (!p) return { ok: false, error: 'Missing transaction params' };
    if (Array.isArray(p.accessList) && p.accessList.length > 0) {
      return {
        ok: false,
        error:
          'Access-list (EIP-2930) transactions are not supported yet. Ask the dapp to send a legacy or EIP-1559 transaction instead.',
      };
    }
    const { evmChainId } = await getActiveNetworks();
    const { evm: customEvmForDecode } = await getCustomNetworks();
    const evmNetForDecode = findEvmNetwork(evmChainId, customEvmForDecode);
    const decoded = decodeTx(
      p.to ?? null,
      p.value ?? '0x0',
      p.data ?? '0x',
      evmNetForDecode?.symbol ?? 'ETH',
      evmNetForDecode?.decimals ?? 18,
    );
    try {
      const result = await enqueueTxApproval({
        origin,
        chainId: evmChainId,
        from: p.from ?? (await getEvmAddressForOrigin(origin)),
        to: p.to ?? null,
        value: p.value ?? '0x0',
        data: p.data ?? '0x',
        gas: p.gas ?? null,
        maxFeePerGas: p.maxFeePerGas ?? null,
        maxPriorityFeePerGas: p.maxPriorityFeePerGas ?? null,
        gasPrice: p.gasPrice ?? null,
        nonce: p.nonce ?? null,
        decoded,
        // dapp eth_sendTransaction always broadcasts; signOnly is for MCP signTransaction.
      });
      // dapp path always broadcasts so we always get { kind: 'broadcast', txHash }.
      if (result.kind !== 'broadcast') {
        // unreachable in this code path, but satisfies the union exhaustiveness check
        // and surfaces the bug clearly if a future refactor changes the wiring.
        return { ok: false, error: `unexpected sign-only result on dapp eth_sendTransaction` };
      }
      return { ok: true, result: result.txHash };
    } catch (e) {
      await log(false, e instanceof Error ? e.message : String(e));
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return null;
}

/** EVM read-only RPC proxy: catches `eth_*` methods that aren't wallet/sign methods. */
export async function handleEthRpcProxy(ctx: BridgeCtx): Promise<HandlerResult> {
  const { method, params, origin, consentMode, log } = ctx;
  if (!method.startsWith('eth_') || MUST_NOT_PROXY_ETH.has(method)) return null;

  const { chainId, rpcUrl } = await getRpcProvider();
  const permission = await getPermission(origin);
  if (consentMode === 'strict' && !canAccessChain(permission, chainId)) {
    return { ok: false, error: 'Chain access denied for this origin' };
  }
  const result = await sendEvmRpcWithRetry(chainId, rpcUrl, method, (params ?? []) as unknown[]);
  await log(true);
  return { ok: true, result };
}
