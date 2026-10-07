export async function chatAutoFollowApi(service, req, url, { body, send }) {
  const p = url.pathname.split('/').filter(Boolean);
  if (p[0] !== 'api' || p[1] !== 'chat-autofollow') return false;
  const reply = (value, status = 200) => { send(status, value); return true; };
  if (p.length === 3 && p[2] === 'queue' && req.method === 'GET') return reply(await service.queue({ limit: url.searchParams.get('limit') || 30, offset: url.searchParams.get('offset') || 0 }));
  if (p.length === 4 && p[3] === 'generate' && req.method === 'POST') return reply(await service.generate(p[2]));
  if (p.length === 4 && p[3] === 'send' && req.method === 'POST') return reply(await service.send(p[2], await body()), 201);
  if (p.length === 4 && p[3] === 'record' && req.method === 'POST') return reply(await service.record(p[2]));
  if (p.length === 4 && p[3] === 'archive' && req.method === 'POST') return reply(await service.archive(p[2], await body()), 201);
  return false;
}
