// Reproduce the pre-quality default comparison; pin current control at quality100.
// node bench/default-performance.mjs /saved/before /fresh/results
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {inflateSync} from 'node:zlib';
import {cpus} from 'node:os';
import * as image from '@napi-rs/image';
import {optimize,builtinPlugins} from 'svgo';
import {loadEngine,optimiseSvg,engineVersions} from '../bin/favseed.mjs';
import {normaliseOptions} from '../lib/config.mjs';
import {buildSet} from '../lib/pipeline.mjs';
import {createZopfli} from '../lib/zopfli.mjs';
import {decode} from '../test/lib/png.mjs';
import {benchmarkPath} from './path.mjs';
assert.ok(process.argv[2]&&process.argv[3],'Pass saved before modules and a fresh result directory');
const before=benchmarkPath(process.argv[2]),out=benchmarkPath(process.argv[3]);mkdirSync(out,{recursive:true});assert.equal(readdirSync(out).length,0);
const hash=b=>createHash('sha256').update(b).digest('hex');
const oldCore=await import(pathToFileURL(join(before,'core.mjs')));
const {buildSet:oldBuild}=await import(pathToFileURL(join(before,'pipeline.mjs')));
const {normaliseOptions:oldOptions}=await import(pathToFileURL(join(before,'config.mjs')));
const {createEngine}=await import(pathToFileURL(join(before,'engine.mjs')));
const oldSvg=oldCore.createSvgStage({optimize,builtinPlugins}).optimiseSvg;
const oldEngine=createEngine({image,inflate:inflateSync,zopfli:createZopfli({loadWasm:()=>readFileSync(new URL('../lib/zopfli.wasm',import.meta.url))})});
const engine=await loadEngine(),marks=['tiles','general','heavy','gradient'];
const arms=['before-release','before-no-zopfli','current-default'];
assert.equal(oldOptions({}).iterations,120,'Before snapshot must have default compression');
assert.equal(normaliseOptions({}).iterations,0,'Current default must skip compression');
const metadata={node:process.version,cpu:cpus()[0]?.model,engine:engineVersions(),repetitions:3,marks,arms,
 beforeHashes:Object.fromEntries(['core.mjs','pipeline.mjs','config.mjs','engine.mjs'].map(n=>[n,hash(readFileSync(join(before,n)))])),
 currentHashes:Object.fromEntries(['core.mjs','pipeline.mjs','config.mjs','engine.mjs'].map(n=>[n,hash(readFileSync(new URL('../lib/'+n,import.meta.url)))])),
 note:'Current control pins quality100, the default when this comparison was recorded. Paired/interleaved full buildSet generation, manifest enabled; includes source read, SVG optimization, placement and PNG/ICO/manifest creation. Excludes module imports, disk writes and validation. First repetition excluded. Before release uses120; before-no-zopfli isolates remaining changes. One-vs-two SVG output differs: raster bytes reported separately. All PNG/ICO dimensions and pixels must match before-no-zopfli; old compressed outputs also lossless relative to that control.'};
writeFileSync(join(out,'metadata.json'),JSON.stringify(metadata,null,2)+'\n');
await oldEngine.finish(await oldEngine.render('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',32),{iterations:1});
const rows=[],seen=new Map();
for(let rep=0;rep<3;rep++)for(const [index,mark]of marks.entries()){
 const order=[...arms.slice(index%arms.length),...arms.slice(0,index%arms.length)];if(rep%2)order.reverse();
 const results={};
 for(const arm of order){
  const t=performance.now(),source=readFileSync(new URL('../test/fixtures/'+mark+'.svg',import.meta.url),'utf8');
  const current=arm==='current-default';
  const result=await(current?buildSet:oldBuild)(source,current?normaliseOptions({manifest:true,quality:100}):oldOptions({manifest:true,...(arm==='before-no-zopfli'?{zopfli:false}:{})}),{engine:current?engine:oldEngine,optimiseSvg:current?optimiseSvg:oldSvg});
  const ms=performance.now()-t;results[arm]=result;
  const directory=join(out,`r${rep}`,mark,arm);mkdirSync(directory,{recursive:true});
  const files=result.files.map(f=>{writeFileSync(join(directory,f.name),f.bytes);return{name:f.name,bytes:f.bytes.length,sha256:hash(f.bytes)};});
  const key=mark+'/'+arm;if(seen.has(key))assert.deepEqual(files,seen.get(key));else seen.set(key,files);
  const rasterBytes=files.filter(f=>/\.(png|ico)$/.test(f.name)).reduce((s,f)=>s+f.bytes,0);
  const row={rep,mark,arm,ms,rasterBytes,allBytes:files.reduce((s,f)=>s+f.bytes,0),files};rows.push(row);
  console.log(JSON.stringify({rep,mark,arm,ms,rasterBytes,allBytes:row.allBytes}));
 }
 const control=results['before-no-zopfli'];
 for(const arm of arms)for(const f of results[arm].files.filter(f=>/\.(png|ico)$/.test(f.name))){
  const old=control.files.find(c=>c.name===f.name),ico=f.name.endsWith('.ico');
  assert.deepEqual(decode(Buffer.from(ico?f.bytes.subarray(22):f.bytes)),decode(Buffer.from(ico?old.bytes.subarray(22):old.bytes)),`${mark}/${arm}/${f.name}: dimensions/pixels differ`);
 }
 assert.deepEqual(results['current-default'].fit,control.fit,'Placement changed');
 writeFileSync(join(out,'rows.json'),JSON.stringify(rows,null,2)+'\n');
}
const summary=arms.map(arm=>({arm,repetitions:[0,1,2].map(rep=>{
 const selected=rows.filter(r=>r.arm===arm&&r.rep===rep);return{rep,ms:selected.reduce((s,r)=>s+r.ms,0),rasterBytes:selected.reduce((s,r)=>s+r.rasterBytes,0),allBytes:selected.reduce((s,r)=>s+r.allBytes,0)};
})}));
writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log('SUMMARY',JSON.stringify(summary));
