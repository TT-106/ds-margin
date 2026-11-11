import { readdir,readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './browser-utils.mjs';
// A dependency-free ZIP writer (stored entries) for a portable unpacked extension.
const table=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc(buffer){let c=0xffffffff;for(const b of buffer)c=table[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
async function files(dir,prefix=''){let out=[];for(const entry of await readdir(dir,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isDirectory())out.push(...await files(join(dir,entry.name),name+'/'));else if(!name.endsWith('.map'))out.push({name,buffer:await readFile(join(dir,entry.name))});}return out;}
const entries=await files(join(root,'dist')),locals=[],centrals=[];let offset=0;
const {version}=JSON.parse(await readFile(join(root,'dist','manifest.json'),'utf8'));
for(const {name,buffer} of entries){
  const file=Buffer.from(name,'utf8'),checksum=crc(buffer),header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(33,12);header.writeUInt32LE(checksum,14);header.writeUInt32LE(buffer.length,18);header.writeUInt32LE(buffer.length,22);header.writeUInt16LE(file.length,26);
  locals.push(header,file,buffer);const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(33,14);central.writeUInt32LE(checksum,16);central.writeUInt32LE(buffer.length,20);central.writeUInt32LE(buffer.length,24);central.writeUInt16LE(file.length,28);central.writeUInt32LE(offset,42);centrals.push(central,file);offset+=header.length+file.length+buffer.length;
}
const central=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);
const filename=`DS-Margin-${version}.zip`;
await writeFile(join(root,filename),Buffer.concat([...locals,central,end]));console.log(`已生成 ${filename}（解压后加载文件夹）`);
