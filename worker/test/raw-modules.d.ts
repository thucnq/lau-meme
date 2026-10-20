// Type for Vite raw imports used by subpath.test.ts (reads config files as text).
declare module '*?raw' {
  const content: string
  export default content
}
