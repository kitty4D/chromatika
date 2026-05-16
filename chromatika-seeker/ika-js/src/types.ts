// JSON-RPC-ish contract between the kotlin host and the JS bridge. every method's payload is
// passed as a JSON object via WebView.evaluateJavascript, every response goes back through
// `chromatikaBridge.send(json)` (an @JavascriptInterface added on the kotlin side).
//
// methods are intentionally narrow: the bridge owns ika SDK state, the kotlin host owns
// network IO outside of ika gRPC + sui graphql + solana gRPC. anything the kotlin host can
// do natively (basic solana sends, EVM RPC reads, etc.) stays out of this contract.

export type BaseChain = 'sui' | 'solana';
export type CurveLabel = 'SECP256K1' | 'ED25519';
export type SigAlg = 'ECDSASecp256k1' | 'EdDSA';

export interface IkaInitRequest {
  baseChain: BaseChain;
  network: string; // e.g. 'sui-mainnet' | 'sui-testnet' | 'solana-devnet'
  rootSeedB64: string;
  suiGraphQlEndpoint?: string;
  solanaRpcEndpoint?: string;
  solanaIkaGrpcEndpoint?: string;
}

export interface IkaInitResponse {
  ready: true;
}

export interface IkaDkgRequest {
  curve: CurveLabel;
}

export interface IkaDkgResponse {
  dwalletId: string;
  attestationB64?: string;
  publicKeyB64: string;
}

export interface IkaPresignRequest {
  curve: CurveLabel;
  sigAlg: SigAlg;
  dwalletId?: string;
}

export interface IkaPresignResponse {
  presignIdHex: string;
}

export interface IkaSignRequest {
  dwalletId: string;
  curve: CurveLabel;
  sigAlg: SigAlg;
  presignIdHex: string;
  messageB64: string;
}

export interface IkaSignResponse {
  signatureB64: string;
}

export type IkaRequest =
  | { method: 'ika_init'; id: string; params: IkaInitRequest }
  | { method: 'ika_dkg'; id: string; params: IkaDkgRequest }
  | { method: 'ika_presign'; id: string; params: IkaPresignRequest }
  | { method: 'ika_sign'; id: string; params: IkaSignRequest };

export type IkaResult =
  | { id: string; ok: true; method: 'ika_init'; result: IkaInitResponse }
  | { id: string; ok: true; method: 'ika_dkg'; result: IkaDkgResponse }
  | { id: string; ok: true; method: 'ika_presign'; result: IkaPresignResponse }
  | { id: string; ok: true; method: 'ika_sign'; result: IkaSignResponse }
  | { id: string; ok: false; error: { code: string; message: string } };
