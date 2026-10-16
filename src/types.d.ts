declare module "*.wgsl?raw" {
  const src: string;
  export default src;
}
declare module "*.wgsl" {
  const src: string;
  export default src;
}
declare module "*.ttf?raw" {
  const src: Uint8Array;
  export default src;
}
