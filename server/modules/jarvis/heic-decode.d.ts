// heic-decode (ISC) ships no types: decodes the primary image of an HEIC/HEIF file to RGBA pixels (libheif-js).
declare module 'heic-decode' {
  type DecodedImage = { width: number; height: number; data: Uint8ClampedArray };
  export default function decode(input: { buffer: Buffer | ArrayBuffer | Uint8Array }): Promise<DecodedImage>;
}
