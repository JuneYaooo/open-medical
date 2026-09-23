// Display as React text, never inject publisher HTML into the application.
export function medicalExcerpt(value='') {
  const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
  return String(value).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,key)=>{
    if(key[0]!=='#')return entities[key.toLowerCase()];
    const code=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));
    return code>0&&code<=0x10ffff?String.fromCodePoint(code):'';
  }).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'')
    .replace(/<\/?(?:h[1-6]|p|div|li|br)\b[^>]*>/gi,'\n')
    .replace(/<\/?[a-z][^>]*>/gi,'')
    .replace(/[\t ]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
