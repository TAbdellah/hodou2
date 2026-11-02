import { readFile, writeFile, mkdir } from 'node:fs/promises';
const root = new URL('./', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');
let html = await read('src/index.html');
const scripts = await Promise.all(['engine.mjs','i18n.mjs','app.mjs'].map(name => read('src/'+name)));
const script = scripts.map(s => s.replace(/^import .*?;\s*$/gm,'').replace(/^export /gm,'')).join('\n');
let styles = await read('src/styles.css');
const fontCSS = (await Promise.all([['Regular',400],['Bold',700]].map(async ([name,weight]) => {
  const bytes = await readFile(new URL(`src/fonts/NotoSansArabic-${name}.ttf`,root));
  return `@font-face{font-family:"Noto Sans Arabic";font-style:normal;font-weight:${weight};font-display:swap;src:url("data:font/ttf;base64,${bytes.toString('base64')}") format("truetype");}`;
}))).join('\n');
styles = styles.replace('/*__FONT_CSS__*/',fontCSS);
html = html.replace('/*__STYLE__*/', styles).replace('/*__SCRIPT__*/', script);
if (html.includes('/*__') || /<script[^>]+src=/.test(html)) throw Error('Incomplete standalone build');
await mkdir(new URL('docs/', root),{recursive:true});
await Promise.all(['index.html','hodou2.html'].map(name => writeFile(new URL('docs/'+name,root),html)));
console.log('Built standalone HODOU2 prototype.');
