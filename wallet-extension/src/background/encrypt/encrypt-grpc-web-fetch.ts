import {
  createGrpcWebRequestBody,
  createGrpcWebRequestHeader,
  readGrpcWebResponseBody,
  readGrpcWebResponseHeader,
  readGrpcWebResponseTrailer,
  GrpcWebFrame,
  GrpcStatusCode,
} from '@protobuf-ts/grpcweb-transport';

const CREATE_INPUT_PATH = '/encrypt.v1.EncryptService/CreateInput';
const READ_CIPHERTEXT_PATH = '/encrypt.v1.EncryptService/ReadCiphertext';

async function grpcWebUnary(
  baseUrl: string,
  path: string,
  requestBytes: Uint8Array,
): Promise<Uint8Array> {
  const base = baseUrl.replace(/\/$/, '');
  const url = `${base}${path}`;
  const body = createGrpcWebRequestBody(requestBytes, 'binary');
  const headers = createGrpcWebRequestHeader(new Headers(), 'binary', undefined, undefined);
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: body as BodyInit,
    signal: AbortSignal.timeout(25_000),
  });
  const [code, detail] = readGrpcWebResponseHeader(res);
  if (code != null && code !== GrpcStatusCode.OK) {
    throw new Error(detail ?? GrpcStatusCode[code]);
  }
  if (!res.body) throw new Error('missing response body');

  let dataMessage: Uint8Array | undefined;
  await readGrpcWebResponseBody(res.body, res.headers.get('content-type'), (type, data) => {
    if (type === GrpcWebFrame.DATA) {
      if (dataMessage) throw new Error('unexpected second data frame');
      dataMessage = data;
    } else if (type === GrpcWebFrame.TRAILER) {
      const [tCode, tDetail] = readGrpcWebResponseTrailer(data);
      if (tCode !== GrpcStatusCode.OK) {
        throw new Error(tDetail ?? GrpcStatusCode[tCode]);
      }
    }
  });
  if (!dataMessage) throw new Error('empty grpc-web response');
  return dataMessage;
}

export async function encryptGrpcCreateInput(
  baseUrl: string,
  encodedRequest: Uint8Array,
): Promise<Uint8Array> {
  return grpcWebUnary(baseUrl, CREATE_INPUT_PATH, encodedRequest);
}

export async function encryptGrpcReadCiphertext(
  baseUrl: string,
  encodedRequest: Uint8Array,
): Promise<Uint8Array> {
  return grpcWebUnary(baseUrl, READ_CIPHERTEXT_PATH, encodedRequest);
}
