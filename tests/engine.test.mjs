import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionEngine, relativeLevel, compareSessions, MicrophoneInput } from '../src/engine.mjs';
const config = {mode:'group',source:'mic',threshold:62,delay:3,duration:600,gain:1,feedback:true};

test('a transient spike does not trigger an alert; a sustained crossing does',()=>{
 const s=new SessionEngine(config);
 s.step(90,2.5);assert.equal(s.alerts,0);assert.equal(s.signal,'amber');
 s.step(20,.5);s.step(90,2.9);assert.equal(s.alerts,0);
 s.step(90,.1);assert.equal(s.alerts,1);assert.equal(s.signal,'red');
 s.step(90,2);assert.equal(s.alerts,1);
 s.step(10,1);s.step(90,3);assert.equal(s.alerts,2);
});
test('pause excludes time and resets the pending alert before resuming',()=>{
 const s=new SessionEngine(config);s.step(90,2);s.pause();s.step(100,50);
 assert.equal(s.elapsed,2);assert.equal(s.above,2);assert.equal(s.pending,0);
 s.resume();s.step(90,2);assert.equal(s.alerts,0);s.step(90,1);assert.equal(s.alerts,1);
});
test('time and crossing duration stop exactly at the planned end',()=>{
 const s=new SessionEngine({...config,duration:10});s.step(20,8);s.step(90,8);
 assert.equal(s.elapsed,10);assert.equal(s.above,2);assert.equal(s.snapshot().percentage,20);assert.equal(s.finished,true);
 s.step(90,30);assert.equal(s.elapsed,10);
});
test('the visual condition does not change how the baseline is measured',()=>{
 const a=new SessionEngine(config),b=new SessionEngine({...config,feedback:false});
 for(const [level,dt]of [[20,4],[90,6],[30,2]]){a.step(level,dt);b.step(level,dt);}
 assert.deepEqual(a.snapshot(),b.snapshot());
});
test('relative sound index is finite, bounded, and monotonic with signal amplitude',()=>{
 const quiet=relativeLevel(new Float32Array(64).fill(.001));
 const loud=relativeLevel(new Float32Array(64).fill(.1));
 assert.ok(quiet>=0&&loud<=100&&loud>quiet);
 assert.equal(relativeLevel(new Float32Array(64)),0);assert.equal(relativeLevel([]),0);
 assert.equal(relativeLevel(new Float32Array(64).fill(1)),100);
});
test('comparison rejects illustrative, short, or differently configured records',()=>{
 const row=(feedback,pct,extra={})=>({source:'mic',complete:true,endedAt:100,percentage:pct,config:{...config,feedback},...extra});
 assert.equal(compareSessions([row(false,60,{source:'demo'}),row(true,20)]),null);
 assert.equal(compareSessions([row(false,60,{complete:false}),row(true,20)]),null);
 assert.equal(compareSessions([row(false,60,{config:{...config,feedback:false,gain:2}}),row(true,20)]),null);
 const c=compareSessions([row(false,60),row(true,35,{endedAt:200})]);assert.equal(c.difference,-25);
});
test('microphone uses audio only and releases every track and audio context',async()=>{
 let stopped=0,closed=0,connected=0,requested;
 class FakeAudio {
  async resume(){} createAnalyser(){return {fftSize:2048,getFloatTimeDomainData(a){a.fill(.01);}};}
  createMediaStreamSource(){return {connect(){connected++;},disconnect(){}};}
  async close(){closed++;}
 }
 const input=new MicrophoneInput({navigator:{mediaDevices:{async getUserMedia(c){requested=c;return {getTracks:()=>[{stop(){stopped++;}}]};}}},AudioContext:FakeAudio});
 assert.equal(await input.start(),true);assert.equal(requested.video,false);assert.equal(requested.audio.noiseSuppression,false);
 assert.equal(connected,1);assert.ok(input.read(1)>0);input.stop();input.stop();assert.equal(stopped,1);assert.equal(closed,1);
});
test('permission denial is propagated and leaves no active resource',async()=>{
 const input=new MicrophoneInput({navigator:{mediaDevices:{getUserMedia:async()=>{throw Object.assign(new Error('Denied'),{name:'NotAllowedError'});}}}});
 await assert.rejects(()=>input.start(),{name:'NotAllowedError'});assert.equal(input.stream,null);
});
test('cancelling a pending microphone request stops any subsequently granted stream',async()=>{
 let resolve,stopped=0;
 const input=new MicrophoneInput({navigator:{mediaDevices:{getUserMedia:()=>new Promise(r=>resolve=r)}}});
 const start=input.start();input.stop();resolve({getTracks:()=>[{stop(){stopped++;}}]});
 assert.equal(await start,false);assert.equal(stopped,1);assert.equal(input.stream,null);
});
test('cancelling during audio setup releases resources without stopping a later session',async()=>{
 let resolveFirst,stops=[0,0],closes=[0,0],request=0,contexts=0;
 class Audio {
  constructor(){this.index=contexts++;}
  resume(){return this.index===0?new Promise(r=>resolveFirst=r):Promise.resolve();}
  createAnalyser(){return {fftSize:2048,getFloatTimeDomainData(){}};}
  createMediaStreamSource(){return {connect(){},disconnect(){}};}
  async close(){closes[this.index]++;}
 }
 const input=new MicrophoneInput({navigator:{mediaDevices:{async getUserMedia(){const i=request++;return {getTracks:()=>[{stop(){stops[i]++;}}]};}}},AudioContext:Audio});
 const first=input.start();await new Promise(r=>setImmediate(r));input.stop();assert.equal(stops[0],1);
 assert.equal(await input.start(),true);resolveFirst();assert.equal(await first,false);
 assert.equal(stops[1],0);assert.equal(closes[1],0);input.stop();assert.equal(stops[1],1);assert.equal(closes[0],1);
});
