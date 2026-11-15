// Built by vite.config.ts from the newest section of CHANGELOG.md (null when there is none).
declare module 'virtual:latest-changelog' {
  const section: import('./lib/changelogSection').ChangelogSection | null;
  export default section;
}
