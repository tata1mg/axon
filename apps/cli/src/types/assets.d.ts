declare module "*.css" {
  const text: string;
  export default text;
}

declare module "*assets/hub.js" {
  const text: string;
  export default text;
}

declare module "*.mjs" {
  const assetPath: string;
  export default assetPath;
}

// Embedded Pi skills are loaded with `{ type: "file" }`, which yields an asset path.
declare module "*/SKILL.md" {
  const assetPath: string;
  export default assetPath;
}

// Bun's file loader returns an asset path, not the standalone extension's exports.
declare module "*harnesses/pi/resources/extensions/web-search.ts" {
  const assetPath: string;
  export default assetPath;
}
