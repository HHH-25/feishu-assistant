// No credentials are returned or logged. Preserve unrelated environment lines.
export function withWikiFileScopes(contents,currentScopes) {
  const scopes=new Set(currentScopes.trim().split(/\s+/).filter(Boolean));
  if([...scopes].some(s=>!/^[A-Za-z0-9_:.-]+$/.test(s)))throw Error('授权范围配置格式无效，未更新');
  if(!scopes.has('drive:drive')){
    scopes.add('drive:drive.metadata:readonly');
    if(!scopes.has('drive:file'))scopes.add('drive:file:upload');
  }
  const lines=contents.split(/\r?\n/),matching=lines.filter(s=>/^\s*(?:export\s+)?MCP_FEISHU_SCOPES\s*=/.test(s));
  if(matching.length>1)throw Error('授权范围重复配置，请先核实');
  if(matching.some(s=>!/^\s*(?:export\s+)?MCP_FEISHU_SCOPES\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^'"\r\n]*)(?:\s*#.*)?$/.test(s)))
    throw Error('授权范围必须单行配置，未更新');
  const kept=lines.filter(s=>!/^\s*(?:export\s+)?MCP_FEISHU_SCOPES\s*=/.test(s));
  return kept.join('\n').replace(/\n?$/,'\n')+'MCP_FEISHU_SCOPES="'+[...scopes].join(' ')+'"\n';
}
