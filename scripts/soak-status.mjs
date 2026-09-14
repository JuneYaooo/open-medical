import {readFileSync} from "node:fs";
import {resolve,join} from "node:path";
import {sourceFingerprint} from "./source-fingerprint.mjs";
const directory=resolve(process.argv[2]||"output/soak-remaining-48h");
const report=JSON.parse(readFileSync(join(directory,"report.json"),"utf8"));
let alive=false;
try {process.kill(report.pid,0);alive=true;}catch{}
console.log(JSON.stringify({status:report.status==="running"&&!alive?"interrupted":report.status,processAlive:alive,sourceMatches:report.sourceFingerprint===sourceFingerprint(),elapsedHours:report.elapsedHours,iterations:report.iterations,durationTargetMet:report.durationTargetMet,updatedAt:report.updatedAt,error:report.error||(!alive&&report.status==="running"?"进程已退出，旧 running 字段不能当作仍在运行":undefined)},null,2));
