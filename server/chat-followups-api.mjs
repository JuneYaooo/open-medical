export async function chatFollowupsApi(service, req, url, { body, send }) {
  const p = url.pathname.split('/').filter(Boolean);
  if (p[0] !== 'api' || p[1] !== 'chat-followups') return false;
  const reply = (value, status = 200) => { send(status,value); return true; };
  if (p.length === 3 && p[2] === 'plugins' && req.method === 'POST') return reply(service.installPlugin(await body()), 201);
  if (p.length === 4 && p[2] === 'plugins' && req.method === 'DELETE') return reply(service.removePlugin(p[3]));
  if (p.length === 3 && p[2] === 'settings' && req.method === 'GET') return reply(service.settings());
  if (p[2] === 'connections' && p.length === 4 && req.method === 'POST') return reply(service.save(p[3],await body()));
  if (p[2] === 'connections' && p.length === 5 && req.method === 'POST') {
    service.channel(p[3]);
    if (p[4] === 'rescan') return reply(service.resetCursor(p[3],await body()));
    if (p[4] === 'connect') return reply(await service.connect(p[3],await body()));
    if (p[4] === 'test') return reply(await service.test(p[3]));
    if (p[4] === 'sync') return reply(await service.sync(p[3],await body()));
    if (p[4] === 'cancel') return reply(service.cancel(p[3]));
  }
  if (p[2] === 'patients' && p.length === 4 && req.method === 'GET') return reply(service.list(p[3],url.searchParams.get('offset') || 0));
  if (p[2] === 'conversations' && p.length === 3 && req.method === 'GET') return reply(await service.conversations(url.searchParams.get('channel') || 'wecom'));
  if (p[2] === 'imports' && p.length === 4 && p[3] === 'preview' && req.method === 'POST') return reply(await service.previewImport(await body()));
  if (p[2] === 'imports' && p.length === 3 && req.method === 'POST') return reply(service.importExport(await body()),201);
  if (p[2] === 'preview' && p.length === 3 && req.method === 'POST') return reply(await service.preview(await body()));
  if (p[2] === 'bindings' && p.length === 3 && req.method === 'POST') return reply(await service.bind(await body()),201);
  if (p[2] === 'bindings' && p.length === 4 && req.method === 'DELETE') return reply(service.unbind(p[3]));
  if (p[2] === 'bindings' && p.length === 5 && p[4] === 'send' && req.method === 'POST') return reply(await service.sendToBinding({ bindingId: p[3], ...(await body()) }), 201);
  if (p[2] === 'assign' && p.length === 3 && req.method === 'POST') return reply(service.assign(await body()),201);
  if (p[2] === 'drafts' && p.length === 5) {
    if (p[4] === 'sources' && req.method === 'GET') return reply(service.evidence(p[3]));
    if (req.method === 'POST') {
      if (p[4] === 'save') return reply(service.updateDraft(p[3],await body()));
      if (p[4] === 'summarize') return reply(await service.summarize(p[3],await body()));
      if (p[4] === 'archive') return reply(service.archiveDraft(p[3],await body()));
    }
  }
  return false;
}
