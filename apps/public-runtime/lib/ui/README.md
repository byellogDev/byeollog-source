# Shared UI sources

Edit palette.json for dashboard light/dark colors, tokens.css for legacy theme tokens, components.css for shared controls and reviewed layouts. account-styles.js owns the shared account dialog and field styles injected into both product pages at the same original cascade position. compatibility.css retains older page styles in their original cascade order while individual components are migrated. Never edit assets/byeollog-theme.css directly; it is generated.

Run npm run ui:generate after edits. npm test and build:public reject stale generated UI. Header/navigation/review markup is generated from shared JavaScript modules by generate-admin-html.mjs. Theme and contrast browser verification must cover populated, empty and error states.
