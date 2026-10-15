import {test} from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {Store} from "../src/store.js";
import {Events} from "../src/events.js";
import type {Request,Response} from "express";

test("shared message projection uses the same database work for one and 64 browsers",async t=>{
  const counts:number[]=[];
  for(const population of [1,64]){
    const store=new Store(":memory:");store.initializeRegistration("open");
    const users=Array.from({length:8},(_,i)=>store.loginIdentity("test",`reader-${i}`,`Reader ${i}`,[],i===0));
    const channel=store.createChannel(users[0],{name:"constant",mode:"timeline",visibility:"members",admission:"open"});
    for(const user of users)store.join(user,channel.id);
    const sessions=users.map(user=>store.createSession(user.id)),hub=new Events(store),frames:string[]=[];
    t.after(()=>{hub.close();store.close();});
    for(let i=0;i<population;i++){
      const response=Object.assign(new EventEmitter(),{writableLength:0,destroyed:false,writeHead(){},write(value:string){frames.push(value);return true;},end(){}});
      const request={query:{deltas:"1",watch:channel.id},socket:{setTimeout(){},setNoDelay(){}}};
      await hub.open(request as unknown as Request,response as unknown as Response,sessions[i%users.length].token);
    }
    let queries=0;const original=store.db.prepare.bind(store.db);
    store.db.prepare=(...args:Parameters<typeof store.db.prepare>)=>{queries++;return original(...args);};
    store.post(users[0],channel.id,{body:"One shared projection"});
    await (hub as any).flush();counts.push(queries);
    const deltas=frames.filter(frame=>frame.includes('"delta"'));
    assert.equal(deltas.length,population);
    assert.equal(new Set(deltas).size,1,"all ordinary viewers share the same encoded buffer");
    store.db.prepare=original;
  }
  assert.equal(counts[0],counts[1],`database calls grew with browser count: ${counts}`);
});

test("bookkeeping writes and one member's changes do not reroute every open stream",async t=>{
  const counts:Record<string,number[]>={settings:[],member:[]};
  for(const population of [1,64]){
    const store=new Store(":memory:");store.initializeRegistration("open");
    const users=Array.from({length:population+1},(_,i)=>store.loginIdentity("test",`reader-${i}`,`Reader ${i}`,[],i===0));
    const channel=store.createChannel(users[0],{name:"routes",mode:"timeline",visibility:"members",admission:"open"});
    for(const user of users.slice(1,-1))store.join(user,channel.id);
    const hub=new Events(store);
    t.after(()=>{hub.close();store.close();});
    for(const user of users.slice(0,population)){
      const response=Object.assign(new EventEmitter(),{writableLength:0,destroyed:false,writeHead(){},write(){return true;},end(){}});
      const request={query:{deltas:"1",watch:channel.id},socket:{setTimeout(){},setNoDelay(){}}};
      await hub.open(request as unknown as Request,response as unknown as Response,store.createSession(user.id).token);
    }
    await (hub as any).flush();
    let queries=0;const original=store.db.prepare.bind(store.db);
    store.db.prepare=(...args:Parameters<typeof store.db.prepare>)=>{queries++;return original(...args);};
    store.db.prepare("INSERT INTO instance_settings(key,value) VALUES('push_cursor','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    queries=0;await (hub as any).flush();counts.settings.push(queries);
    store.join(users.at(-1)!,channel.id);
    queries=0;await (hub as any).flush();counts.member.push(queries);
    store.db.prepare=original;
  }
  assert.equal(counts.settings[0],counts.settings[1],`push bookkeeping grew with streams: ${counts.settings}`);
  assert.equal(counts.member[0],counts.member[1],`one membership grew with streams: ${counts.member}`);
});
