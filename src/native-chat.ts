import type { Config } from "./config.js";
import { randomUUID,createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { Problem, type Store,type User } from "./store.js";
// Hot-path calls to the native service share kept-alive connections. Plain
// node:http costs much less per call than fetch, which matters when a crowd of
// browsers reconnects at once. Redirects are never followed.
const agents = { http: new http.Agent({ keepAlive: true, maxSockets: 256 }), https: new https.Agent({ keepAlive: true, maxSockets: 256 }) };
function rpc(url: string, secret: string, body: string, timeout: number) {
  return new Promise<{ status: number; type: string; body: Buffer }>((resolve, reject) => {
    const target = new URL(url), secure = target.protocol === "https:";
    const req = (secure ? https : http).request(target, { method: "POST", agent: secure ? agents.https : agents.http,
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode || 0, type: String(res.headers["content-type"] || ""), body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.setTimeout(timeout, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}
const invalidUtf16 = (value: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);

// Migration boundary: only an explicit, pre-mutation "unsupported" response
// permits legacy execution. Timeouts and failures must never replay a write.
export class NativeChat {
  readonly statistics = { requests:0, completed:0, unsupported:0, errors:0, posts:0, pages:0, readMarks:0, overviews:0, sessions:0 };
  private healthUntil = 0;
  private healthPending?: Promise<void>;
  private sessionsPending = new Map<string,Promise<{user:User;csrf:string;expiresAt:number}>>();
  constructor(private store: Store, private config: Config) {}
  async eventSession(token:string) {
    if(!this.config.nativeChatUrl)return undefined;
    try{return await this.session(token,true);}catch(error){if(error instanceof Problem && error.status===401)return null;throw error;}
  }
  async audience(channels:string[]) {
    if(!this.config.nativeChatUrl)return undefined;
    const rows:{id:string;visibility:string;mode:string;members:string[]}[]=[];
    for(let at=0;at<channels.length;at+=1000) {
      const response=await fetch(`${this.config.nativeChatUrl}/v1/events/audience`,{method:"POST",redirect:"error",signal:AbortSignal.timeout(5000),
        headers:{Authorization:`Bearer ${this.config.nativeBridgeSecret}`,"Content-Type":"application/json"},body:JSON.stringify({channels:channels.slice(at,at+1000)}),
      }).catch(()=>{throw new Problem(503,"Native notification audience unavailable.");});
      const result=await response.json().catch(()=>{throw new Problem(502,"Invalid notification audience.");}) as typeof rows;
      if(!response.ok || !Array.isArray(result) || result.some(r=>!r || typeof r.id!=="string" || typeof r.visibility!=="string" || typeof r.mode!=="string" || !Array.isArray(r.members) || r.members.some(m=>typeof m!=="string")))
        throw new Problem(502,"Invalid notification audience.");
      rows.push(...result);
    }
    return rows;
  }
  async account(op:string,token:string,csrf="",input?:Record<string,unknown>) {
    if(!this.config.nativeChatUrl) return undefined;
    await this.store.db.listenExternalChanges();
    const response=await fetch(`${this.config.nativeChatUrl}/v1/account`,{
      method:"POST",redirect:"error",signal:AbortSignal.timeout(20000),
      headers:{Authorization:`Bearer ${this.config.nativeBridgeSecret}`,"Content-Type":"application/json"},body:JSON.stringify({op,token,csrf,input:input??null}),
    }).catch(()=>{throw new Problem(503,"Native account service unavailable.");});
    const result=await response.json().catch(()=>{throw new Problem(502,"Invalid native account response.");}) as any;
    if(!response.ok) throw new Problem(response.status,result.error || "Native account operation failed.");
    return result;
  }
  async reviewSessions(tokens:string[]) {
    if(!this.config.nativeChatUrl) return undefined;
    const hashes=[...new Set(tokens.map(token=>createHash("sha256").update(token).digest("hex")))];
    const rows:{hash:string;user:string;approved:boolean;admin:boolean}[]=[];
    for(let offset=0;offset<hashes.length;offset+=1000) {
      const response=await fetch(`${this.config.nativeChatUrl}/v1/events/sessions`,{
        method:"POST",redirect:"error",signal:AbortSignal.timeout(5000),
        headers:{Authorization:`Bearer ${this.config.nativeBridgeSecret}`,"Content-Type":"application/json"},body:JSON.stringify({hashes:hashes.slice(offset,offset+1000)}),
      }).catch(()=>{throw new Problem(503,"Native session review unavailable.");});
      const data=await response.json().catch(()=>{throw new Problem(502,"Invalid native session review.");}) as typeof rows;
      if(!response.ok || !Array.isArray(data) || data.some(row=>typeof row.hash!=="string" || typeof row.user!=="string" || typeof row.approved!=="boolean" || typeof row.admin!=="boolean"))
        throw new Problem(503,"Native session review unavailable.");
      rows.push(...data);
    }
    return new Map(rows.map(row=>[row.hash,row]));
  }
  async health() {
    if (!this.config.nativeChatUrl || Date.now()<this.healthUntil) return;
    if (this.healthPending) return this.healthPending;
    const pending = (async()=>{
      const response = await fetch(`${this.config.nativeChatUrl}/health`,{redirect:"error",signal:AbortSignal.timeout(3000),headers:{Authorization:`Bearer ${this.config.nativeBridgeSecret}`}})
        .catch(()=>{throw new Problem(503,"Native chat worker unavailable.");});
      await response.arrayBuffer().catch(()=>{throw new Problem(503,"Native chat worker unavailable.");});
      if(!response.ok) throw new Problem(503,"Native chat worker unavailable.");
      this.healthUntil=Date.now()+1000;
    })();
    this.healthPending=pending;
    try { await pending; } finally { this.healthPending=undefined; }
  }
  private async call(job: Record<string, unknown>) {
    await this.store.db.listenExternalChanges().catch(()=>{throw new Problem(503,"Native change notifications unavailable.");});
    this.statistics.requests++;
    const response = await rpc(`${this.config.nativeChatUrl}/v1/chat`, this.config.nativeBridgeSecret, JSON.stringify(job), 20000)
      .catch(() => { this.statistics.errors++;throw new Problem(503, "Native chat worker unavailable."); });
    const text = response.body.toString("utf8");
    if (Buffer.byteLength(text) > (["messages","overview"].includes(String(job.op)) ? 4 * 1024 * 1024 : 262144)) {this.statistics.errors++;throw new Problem(502, "Invalid native worker response.");}
    let reply: { result?: unknown; user?: string; changed?: boolean; code?: string; error?: string };
    try { reply = JSON.parse(text); } catch { this.statistics.errors++;throw new Problem(502, "Invalid native worker response."); }
    if (response.status === 501 && reply.code === "native_unsupported") {this.statistics.unsupported++;return undefined;}
    if (response.status < 200 || response.status > 299) {this.statistics.errors++;throw new Problem(response.status, reply.error || "Native chat worker failed.");}
    if (typeof reply.user !== "string" || typeof reply.changed !== "boolean" || reply.result === undefined) {
      this.statistics.errors++;throw new Problem(502, "Invalid native worker response.");
    }
    this.statistics.completed++;
    if(job.op==="post")this.statistics.posts++;else if(job.op==="messages")this.statistics.pages++;else if(job.op==="read")this.statistics.readMarks++;else if(job.op==="overview")this.statistics.overviews++;else if(job.op==="session" || job.op==="auth")this.statistics.sessions++;
    return reply;
  }
  async post(token: string, csrf: string, channel: string, input: Record<string, unknown>) {
    if (!this.config.nativeChatUrl || this.config.xmppDomain || typeof input.body !== "string" ||
        invalidUtf16(input.body) ||
        [input.parent_id,input.topic_id,input.title].some(value=>value!==undefined && value!==null && (typeof value!=="string" || invalidUtf16(value))) ||
        input.parent_id === "" || input.topic_id === "") return undefined;
    const reply = await this.call({ op: "post", channel, token, csrf, body: input.body, message_id: randomUUID(),
      parent_id:input.parent_id ?? null,topic_id:input.topic_id ?? null,title:input.title ?? null });
    if (!reply) return undefined;
    return reply.result;
  }
  async edit(token:string,csrf:string,id:string,input:Record<string,unknown>) {
    if(!this.config.nativeChatUrl || this.config.xmppDomain || typeof input.body!=="string" || invalidUtf16(input.body) || !Object.hasOwn(input,"expected_edited_at") ||
      (input.expected_edited_at!==null && typeof input.expected_edited_at!=="string") || Object.keys(input).some(k=>!["body","title","expected_edited_at"].includes(k)) ||
      (input.title!==undefined && input.title!==null && (typeof input.title!=="string" || invalidUtf16(input.title))))return undefined;
    return (await this.call({op:"edit",channel:`edit:${id}`,message_id:id,token,csrf,body:input.body,title:input.title??null,title_supplied:Object.hasOwn(input,"title"),expected_edited_at:input.expected_edited_at}))?.result;
  }
  async mark(token: string, csrf: string, input: Record<string, unknown>) {
    if (!this.config.nativeChatUrl || input.all !== undefined || typeof input.target !== "string" || invalidUtf16(input.target) || input.target.startsWith("dm:") ||
        (input.seq !== undefined && (!Number.isSafeInteger(input.seq) || Number(input.seq) < 0))) return false;
    const reply = await this.call({ op: "read", channel: input.target, token, csrf, seq: input.seq ?? null });
    if (!reply) return false;
    return true;
  }
  async messages(token: string, csrf: string, channel: string, before?: number) {
    if (!this.config.nativeChatUrl) return undefined;
    const reply = await this.call({ op: "messages", channel, token, csrf, before: before ?? null });
    return reply?.result;
  }
  private async rawRead(job:Record<string,unknown>) {
    await this.store.db.listenExternalChanges();this.statistics.requests++;
    const response=await rpc(`${this.config.nativeChatUrl}/v1/read`,this.config.nativeBridgeSecret,JSON.stringify(job),20000)
      .catch(()=>{this.statistics.errors++;throw new Problem(503,"Native read service unavailable.");});
    const body=response.body;
    if(body.length>4*1024*1024+4096){this.statistics.errors++;throw new Problem(502,"Native read response is too large.");}
    if(response.status<200 || response.status>299) {
      let error:{code?:string;error?:string};
      try{error=JSON.parse(body.toString());if(!error || typeof error!=="object")throw new Error();}
      catch{this.statistics.errors++;throw new Problem(502,"Invalid native read response.");}
      if(response.status===501 && error.code==="native_unsupported"){this.statistics.unsupported++;return undefined;}
      this.statistics.errors++;throw new Problem(response.status,typeof error.error==="string"?error.error:"Native read failed.");
    }
    // The authenticated worker emits the public JSON projection directly. Do
    // not parse and serialize a full message page again on the Node edge.
    if(!response.type.startsWith("application/json") || body[0]!==123){this.statistics.errors++;throw new Problem(502,"Invalid native read response.");}
    this.statistics.completed++;if(job.op==="messages")this.statistics.pages++;else this.statistics.overviews++;
    return body;
  }
  async rawMessages(token:string,csrf:string,channel:string,before?:number,after?:number,stamp?:string) {
    if(!this.config.nativeChatUrl)return undefined;
    return this.rawRead({op:"messages",channel,token,csrf,before:before??null,after:after??null,refresh_stamp:stamp??null,refresh:before===undefined});
  }
  async rawOverview(token:string,csrf:string) {
    if(!this.config.nativeChatUrl || this.config.xmppDomain)return undefined;
    return this.rawRead({op:"overview",channel:`overview:${createHash("sha256").update(token).digest("hex")}`,token,csrf});
  }
  async overview(token:string,csrf:string) {
    if(!this.config.nativeChatUrl || this.config.xmppDomain) return undefined;
    const channel=`overview:${createHash("sha256").update(token).digest("hex")}`;
    return (await this.call({op:"overview",channel,token,csrf}))?.result as Record<string,unknown> | undefined;
  }
  async session(token:string,allowPending=false) {
    // Concurrent page/overview/read requests from one browser may share the
    // quota snapshot while it is in flight. Each operation still authenticates
    // afresh at apply time, and completed snapshots are never retained.
    const key=`${allowPending?"auth":"session"}:${createHash("sha256").update(token).digest("hex")}`;
    const existing=this.sessionsPending.get(key);if(existing)return existing;
    const pending=this.readSession(token,allowPending);
    if(this.sessionsPending.size>=4096)return pending;
    this.sessionsPending.set(key,pending);
    try{return await pending;}finally{if(this.sessionsPending.get(key)===pending)this.sessionsPending.delete(key);}
  }
  private async readSession(token:string,allowPending:boolean) {
    const channel=`session:${createHash("sha256").update(token).digest("hex")}`;
    const reply=await this.call({op:allowPending?"auth":"session",channel,token,csrf:""});
    const result=reply?.result as {user:User;csrf:string;expiresAt:number} | undefined;
    if(!result || result.user?.id!==reply?.user || typeof result.csrf!=="string" || !Number.isSafeInteger(result.expiresAt))
      throw new Problem(502,"Invalid native session response.");
    return result;
  }
}
