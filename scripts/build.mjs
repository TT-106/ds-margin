import { build } from 'vite';
import { mkdir,readFile,writeFile,readdir,copyFile,rm,cp } from 'node:fs/promises';
import { dirname,resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {version}=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const out=join(root,'dist');
if (resolve(out)!==resolve(root,'dist') || dirname(out)!==root) throw new Error('拒绝清理工程之外的目录');
await rm(out,{recursive:true,force:true});await mkdir(join(out,'fonts'),{recursive:true});
const fontAssets=new Map(),fontStyles=[];
for(const spec of [
  {pkg:'@fontsource-variable/noto-serif-sc',css:['index.css'],license:'OFL-Noto-Serif-SC.txt'},
  {pkg:'@fontsource-variable/lora',css:['index.css'],license:'OFL-Lora.txt'},
  {pkg:'@fontsource/poppins',css:['400.css','500.css','600.css'],license:'OFL-Poppins.txt'},
]){
  const fontRoot=join(root,'node_modules',spec.pkg);
  for(const css of spec.css){
    const source=await readFile(join(fontRoot,css),'utf8');
    fontStyles.push(source.replace(/url\((?:['"])?\.\/files\/([^)'"\s]+)(?:['"])?\)/g,(_match,file)=>{fontAssets.set(file,join(fontRoot,'files',file));return `url("__FONT_BASE__${file}")`;}));
  }
  await copyFile(join(fontRoot,'LICENSE'),join(out,'fonts',spec.license));
}
const fontCss=fontStyles.join('\n');
for(const [name,path] of fontAssets)await copyFile(path,join(out,'fonts',name));
await cp(join(root,'public'),out,{recursive:true});
await copyFile(join(root,'node_modules','katex','LICENSE'),join(out,'LICENSE-KaTeX.txt'));
await copyFile(join(root,'node_modules','marked','LICENSE'),join(out,'LICENSE-Marked.txt'));
const shared={root,configFile:false,publicDir:false,logLevel:'warn',define:{__DS_FONT_CSS__:JSON.stringify(fontCss)}};
for (const [entry,name,format] of [
  ['src/content/index.tsx','content','iife'],
  ['src/background/index.ts','background','es'],
  ['src/sidequestions/native-stream-main.ts','native-stream','iife'],
]) {
  await build({...shared,build:{outDir:out,emptyOutDir:false,target:'chrome120',sourcemap:true,minify:'esbuild',lib:{entry:join(root,entry),name:'DSMargin',formats:[format],fileName:()=>`${name}.js`}}});
}
const lazyEntries = {
  'side-question-katex': 'virtual:ds-margin-side-question-katex',
  'side-question-markdown': join(root,'src/ui/side-question-markdown.ts'),
};
const mathEntry = lazyEntries['side-question-katex'];
const resolvedMathEntry = '\0' + mathEntry;
await build({
  ...shared,
  // Keep the literal U+FFFF in KaTeX's regex escaped for Chrome.
  esbuild: { charset: 'ascii' },
  plugins: [{
    name: 'ds-margin-side-question-katex',
    resolveId(id) { if (id === mathEntry) return resolvedMathEntry; },
    load(id) { if (id === resolvedMathEntry) return "export { renderToString } from 'katex';"; },
  }],
  build: {
    outDir: out, emptyOutDir: false, target: 'chrome120', sourcemap: true, minify: 'esbuild',
    rollupOptions: {
      input: lazyEntries,
      preserveEntrySignatures: 'strict',
      output: { format: 'es', entryFileNames: '[name].js' },
    },
  },
});
await build({...shared,build:{outDir:out,emptyOutDir:false,target:'chrome120',sourcemap:true,minify:'esbuild',rollupOptions:{input:join(root,'popup.html')}}});
const origin='https://chat.deepseek.com';
const chatMatches=['/','/?*','/a/chat','/a/chat?*','/a/chat/*','/chat','/chat?*','/chat/*'].map(path=>origin+path);
const manifest={manifest_version:3,name:'DS Margin · 留白',version,description:'DeepSeek 划词旁问、本地书库、提示词与草稿恢复。',minimum_chrome_version:'120',permissions:['storage'],background:{service_worker:'background.js',type:'module'},action:{default_popup:'popup.html',default_title:'DS Margin · 留白',default_icon:{16:'icons/16.png',48:'icons/48.png',128:'icons/128.png'}},icons:{16:'icons/16.png',48:'icons/48.png',128:'icons/128.png'},content_scripts:[
  {matches:chatMatches,css:['startup.css'],run_at:'document_start',all_frames:false},
  {matches:[`${origin}/*`],js:['native-stream.js'],run_at:'document_start',world:'MAIN',all_frames:false},
  {matches:[`${origin}/*`],js:['content.js'],run_at:'document_start',all_frames:false},
],web_accessible_resources:[
  {resources:[...fontAssets.keys()].map(name=>`fonts/${name}`),matches:[`${origin}/*`]},
  {resources:Object.keys(lazyEntries).map(name=>name+'.js'),matches:[`${origin}/*`]},
],content_security_policy:{extension_pages:"script-src 'self'; object-src 'none'"}};
await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2));
const files=await readdir(out);console.log(`DS Margin ${version} 构建完成：${out}（${fontAssets.size} 个本地字体子集）`);console.log(files.join(' · '));
