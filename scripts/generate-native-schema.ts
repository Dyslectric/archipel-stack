// Optional development generator. The committed SQL is embedded in the binary;
// native builds and startup do not require Node or SQLite.
import {SqliteDatabase,copyToPostgres,toPostgres,type PostgresDatabase} from '../src/db.js';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=new URL('../migrations/',import.meta.url),data=new URL('../native/data/',import.meta.url);
const files=readdirSync(root).filter(f=>/^\d+.*\.sql$/.test(f)).sort();
const hash=createHash('sha256');for(const file of files)hash.update(file).update(readFileSync(new URL(file,root),'utf8').replaceAll('\r\n','\n'));
const statements:string[]=[];
const literal=(value:any)=>value===null?'NULL':typeof value==='number'?String(value):
  typeof value==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)?"to_char(current_timestamp AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')":
  typeof value==='string'?`'${value.replaceAll("'","''")}'`:(()=>{throw new Error('Unexpected seed type');})();
const target={version:()=>0,transaction:(fn:()=>void)=>fn(),exec:(sql:string)=>statements.push(toPostgres(sql)),
  counter:(table:string)=>{const columns=blank.raw.prepare(`PRAGMA table_info("${table}")`).all() as {name:string;type:string;pk:number}[];const column=columns.find(c=>c.pk && c.type==='INTEGER');if(!column)throw new Error(`No counter for ${table}`);return `"${table}_${column.name}_seq"`;},
  native:(sql:string,values:any[]=[])=>{statements.push(sql.replace(/\$(\d+)/g,(_,number)=>literal(values[Number(number)-1])));return [];}};
const blank=new SqliteDatabase(':memory:');try{blank.migrate();copyToPostgres(blank,target as unknown as PostgresDatabase);}finally{blank.close();}
writeFileSync(new URL('schema.sql',data),`-- Generated from migrations; source SHA256 ${hash.digest('hex')}\n${statements.join(';\n')};\n`);
writeFileSync(new URL('schema-upgrades.json',data),JSON.stringify(files.filter(f=>Number(f.slice(0,3))>=27).map(file=>({version:Number(file.slice(0,3)),sql:toPostgres(readFileSync(new URL(file,root),'utf8'))}))));
