import {check} from '../errors.mjs';
import {listScales} from './scales.mjs';
export function configureTaskPresentation(registry,kind,save) {
 const evidence=[];
 for(const [name,tool] of registry.tools){
  const execute=tool.execute;
  tool.execute=async(args,context)=>{
   const output=await execute(args,context);
   if(['read_patient_brief','read_source'].includes(name)&&!output?.error)evidence.push(JSON.stringify(output));
   if(!output?.error && kind==='literature' && ['literature_search','literature_fetch'].includes(name))save({kind:'literature',key:name+JSON.stringify(args),tool:name,...output});
   if(!output?.error && kind==='calculator' && name==='medical_scale_calculate'){
    const scale=listScales().find(s=>s.id===args.scaleId);
    save({kind:'calculator',key:name+JSON.stringify(args),...output,formula:scale?.desc,inputs:(scale?.items||[]).map(i=>({label:i.label,value:args.answers[i.key]}))});
   }
   return output;
  };
 }
 if(kind!=='diagnostic')return;
 const str={type:'string',maxLength:1500};
 registry.register({permission:'tools.execute',capability:{backend:'local'},definition:{type:'function',function:{name:'present_diagnostic_review',description:'将辅助诊断整理成供医生比较的结果界面。保存可能诊断、支持与不支持的证据、待补资料。quote 必须是本轮已读取患者资料中的连续原文；没有资料不要生成此界面，直接回答缺少什么。',parameters:{type:'object',properties:{summary:str,candidates:{type:'array',maxItems:6,items:{type:'object',properties:{name:str,support:str,against:str,missing:str,quote:str},required:['name','support','against','missing','quote'],additionalProperties:false}}},required:['summary','candidates'],additionalProperties:false}}},execute:args=>{
  check(args.candidates.length>0,'DIAGNOSIS_EVIDENCE','没有可比较内容，请直接说明所缺资料。');
  for(const c of args.candidates)check(c.quote.trim() && evidence.some(e=>e.includes(c.quote)),'DIAGNOSIS_EVIDENCE','支持依据必须来自本次已读取患者资料。');
  const result={kind:'diagnostic',key:'diagnostic',...args};save(result);return{...result,readOnly:true,note:'供医生参考，未写入患者诊断。'};
 }});
}
