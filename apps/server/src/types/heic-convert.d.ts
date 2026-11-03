declare module 'heic-convert' {
  interface Options {
    buffer: Buffer | ArrayBuffer | Uint8Array;
    format: 'JPEG' | 'PNG';
    quality?: number;
  }
  const convert: (options: Options) => Promise<ArrayBuffer>;
  export default convert;
}
