import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function safe(file) {
  let current=path.parse(path.resolve(file)).root;
  for(const part of path.resolve(file).slice(current.length).split(path.sep)){
    current=path.join(current,part);
    try{if(fs.lstatSync(current).isSymbolicLink())throw new Error('agentbus: symlinked storage is not supported');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}

export function ensureDir(dir) {
  safe(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// Temp-Datei im Zielverzeichnis, dann rename: atomar, gleiches Volume.
export function writeJsonAtomic(file, value) {
  safe(file);
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {} // kein Temp-Rest im Zielverzeichnis
    throw e;
  }
}

export function readJson(file) {
  safe(file);
  const stat=fs.statSync(file);if(!stat.isFile()||stat.size>1024*1024)throw new Error('agentbus: invalid storage file');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function listFiles(dir) {
  safe(dir);
  try {
    return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
