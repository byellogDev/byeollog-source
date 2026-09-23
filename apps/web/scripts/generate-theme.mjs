import {readFile,writeFile} from 'node:fs/promises';
const sources=['tokens','compatibility','components'];
export async function renderTheme(){
 const palette=JSON.parse(await readFile(new URL('../lib/ui/palette.json',import.meta.url),'utf8'));
 const theme=Object.entries(palette).map(([mode,values])=>`${mode==='light'?'.dashboard-page':'.dashboard-page[data-theme="dark"]'}{${Object.entries(values).map(([key,value])=>`--ui-${key}:${value}`).join(';')}}`).join('\n');
 const parts=await Promise.all(sources.map(name=>readFile(new URL('../lib/ui/'+name+'.css',import.meta.url),'utf8')));
 return '/* Generated from lib/ui/*.css and palette.json. Run npm run ui:generate. */\n'+parts.join('\n').replace('/* shared:palette */',theme);
}
export async function checkTheme(){const expected=await renderTheme(),actual=await readFile(new URL('../assets/byeollog-theme.css',import.meta.url),'utf8');if(actual!==expected)throw Error('Shared theme is stale. Run npm run ui:generate.');return true}
if(process.argv[1]&&import.meta.url===(await import('node:url')).pathToFileURL(process.argv[1]).href){if(process.argv.includes('--check'))await checkTheme();else await writeFile(new URL('../assets/byeollog-theme.css',import.meta.url),await renderTheme())}
