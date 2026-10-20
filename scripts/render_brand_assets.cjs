/** Render code-native brand assets with an existing local Playwright/Chromium. No network. */
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const {chromium}=require(process.env.DOWNANY_PLAYWRIGHT_MODULE||'playwright');
const source=fs.readFileSync(path.join(root,'assets/brand/logo-mark.svg'),'utf8');
const paths=source.match(/  <path[^\n]+/g).join('\n');
const svg=(body,title='Downany · 百纳',viewBox='0 0 64 64')=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${title}">\n${body}\n</svg>\n`;
const app=svg(`<rect x="4" y="4" width="56" height="56" rx="14" fill="#252825"/>\n<g transform="translate(3.2 1.3) scale(.9)">\n${paths}\n</g>`);
const small=svg(`<rect width="64" height="64" rx="14" fill="#252825"/>\n${paths}`);
const template=svg(paths.replaceAll('#ed7051','#000'),'Downany 菜单栏','0 0 64 64');
const lockup=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 100" role="img" aria-label="Downany · 百纳">\n<g transform="translate(0 4) scale(1.4)">\n${paths}\n</g><text x="108" y="55" fill="#252825" font-family="-apple-system,BlinkMacSystemFont,Helvetica Neue,Arial,sans-serif" font-size="38" font-weight="650" letter-spacing="-1">Downany</text><text x="110" y="81" fill="#747773" font-family="-apple-system,BlinkMacSystemFont,PingFang SC,sans-serif" font-size="18">百纳</text></svg>\n`;
const writes={'assets/brand/app-icon.svg':app,'assets/brand/logo-lockup.svg':lockup,'assets/brand/tray-template.svg':template,'browser-extension/icons/icon.svg':app,'browser-extension/icons/icon-small.svg':small,'website/public/assets/logo-mark.svg':source};
for(const [file,value] of Object.entries(writes))fs.writeFileSync(path.join(root,file),value);
(async()=>{let browser;try{
 browser=await chromium.launch({headless:true,...(process.env.DOWNANY_CHROMIUM?{executablePath:process.env.DOWNANY_CHROMIUM}:{})});
 const page=await browser.newPage({deviceScaleFactor:1});
 async function png(svg,size,out){await page.setViewportSize({width:size,height:size});await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`);const bytes=await page.screenshot({omitBackground:true});if(out){fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,bytes)}return bytes;}
 await png(app,1024,path.join(root,'desktop/build/icon.png'));
 const ico=[];
 for(const size of [16,24,32,48,64,128,256])ico.push({size,data:await png(size<=24?small:app,size)});
 let offset=6+16*ico.length;const header=Buffer.alloc(offset);header.writeUInt16LE(1,2);header.writeUInt16LE(ico.length,4);
 ico.forEach(({size,data},i)=>{const pos=6+16*i;header[pos]=size===256?0:size;header[pos+1]=size===256?0:size;header.writeUInt16LE(1,pos+4);header.writeUInt16LE(32,pos+6);header.writeUInt32LE(data.length,pos+8);header.writeUInt32LE(offset,pos+12);offset+=data.length});
 fs.writeFileSync(path.join(root,'desktop/build/icon.ico'),Buffer.concat([header,...ico.map(x=>x.data)]));
 for(const size of [16,32,48,128])await png(size===16?small:app,size,path.join(root,`browser-extension/icons/icon${size}.png`));
 const iconset=process.env.DOWNANY_ICONSET;
 if(iconset)for(const size of [16,32,128,256,512]){await png(app,size,path.join(iconset,`icon_${size}x${size}.png`));await png(app,size*2,path.join(iconset,`icon_${size}x${size}@2x.png`))}
 for(const [label,svg] of [['brand-trayTemplate',template],['brand-tray',small]])for(const scale of [1,2])await png(svg,18*scale,path.join(root,`desktop/electron/assets/${label}${scale===2?'@2x':''}.png`));
 console.log('Brand SVG, PNG, ICO and 1x/2x tray assets rendered from logo-mark.svg.');
}finally{await browser?.close()}})().catch(e=>{console.error(e);process.exitCode=1});
