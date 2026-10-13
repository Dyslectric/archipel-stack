// Generated data is committed: building/running Rust does not require Node.
import {nameToEmoji,gemoji} from 'gemoji';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const directory=new URL('../native/data/',import.meta.url);
mkdirSync(directory,{recursive:true});
writeFileSync(new URL('standard-emojis.json',directory),JSON.stringify(nameToEmoji));
writeFileSync(new URL('emoji-aliases.json',directory),JSON.stringify(Object.fromEntries(gemoji.map(g=>[g.emoji.replace(/[\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu,''),g.names]))));
writeFileSync(new URL('gemoji-LICENSE',directory),readFileSync(new URL('license',import.meta.resolve('gemoji'))));
