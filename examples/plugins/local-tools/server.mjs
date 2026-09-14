// Dependency-free example MCP server; production servers can use the official SDK.
import { createInterface } from 'node:readline';
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of input){
  let request;
  try{
    request=JSON.parse(line);if(request.id===undefined)continue;
    const p=request.params||{};let result;
    switch(request.method){
      case 'initialize':result={protocolVersion:p.protocolVersion||'2025-11-25',capabilities:{tools:{},resources:{},prompts:{}},serverInfo:{name:'offline-example',version:'1.0.0'}};break;
      case 'ping':result={};break;
      case 'tools/list':result={tools:[{name:'sum_numbers',description:'Add numbers without host filesystem or network access',inputSchema:{type:'object',properties:{values:{type:'array',items:{type:'number'},minItems:1,maxItems:100}},required:['values'],additionalProperties:false}}]};break;
      case 'tools/call':if(p.name!=='sum_numbers'||!Array.isArray(p.arguments?.values)||!p.arguments.values.every(Number.isFinite))throw new Error('Invalid tool or arguments');result={content:[{type:'text',text:String(p.arguments.values.reduce((a,b)=>a+b,0))}]};break;
      case 'resources/list':result={resources:[{uri:'example://about',name:'about',mimeType:'text/plain'}]};break;
      case 'resources/templates/list':result={resourceTemplates:[]};break;
      case 'resources/read':if(p.uri!=='example://about')throw new Error('Unknown resource');result={contents:[{uri:p.uri,mimeType:'text/plain',text:'Offline MCP sample'}]};break;
      case 'prompts/list':result={prompts:[{name:'explain',description:'Explain a calculation'}]};break;
      case 'prompts/get':if(p.name!=='explain')throw new Error('Unknown prompt');result={messages:[{role:'user',content:{type:'text',text:'Explain the calculation using only verified tool results.'}}]};break;
      default:throw new Error('Unknown method');
    }
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
  }catch(e){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request?.id??null,error:{code:-32602,message:e.message}})+'\n');}
}
