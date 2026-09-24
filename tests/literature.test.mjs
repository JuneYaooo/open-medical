import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.mjs";
import { LiteratureService, literatureTools } from "../server/medical/literature.mjs";

const jsonResponse = (data) => async () => ({
  ok: true,
  status: 200,
  json: async () => data,
});

const pubmedResponses = (urls) => (url) => {
  urls.push(url);
  if (url.includes("esearch"))
    return jsonResponse({
      esearchresult: { idlist: ["39918244", "39815042"], retcount: 2 },
    })();
  if (url.includes("39815042"))
    return jsonResponse({
      result: {
        "39918244": {
          title: "SGLT2 inhibitors in heart failure.",
          fulljournalname: "European Journal of Heart Failure",
          pubdate: "2025 Feb 10",
          authors: [{ name: "Zhang L" }, { name: "Wang H" }],
          pubtype: ["Journal Article", "Meta-Analysis"],
          articleids: [{ idtype: "doi", value: "10.1000/example" }],
        },
        "39815042": {
          title: "Cardiac rehabilitation uptake.",
          fulljournalname: "Circulation",
          pubdate: "2025 Jan 22",
          authors: [{ name: "Li M" }],
          pubtype: ["Journal Article"],
          articleids: [],
        },
      },
    })();
  return jsonResponse({})();
};

const europeResponse = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    resultList: {
      result: [
        {
          pmid: "39918244",
          pmcid: "PMC11800000",
          doi: "10.1000/example",
          title: "SGLT2 inhibitors in heart failure.",
          journalTitle: "Eur J Heart Fail",
          pubYear: "2025",
          authorString: "Zhang L, Wang H, Chen J",
          pubTypeList: { pubType: ["Review", "Meta-Analysis"] },
          isOpenAccess: "Y",
        },
      ],
    },
  }),
});

const coreArticleResponse = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    resultList: {
      result: [
        {
          pmid: "39918244",
          pmcid: "PMC11800000",
          doi: "10.1000/example",
          title: "SGLT2 inhibitors in heart failure.",
          journalInfo: { journal: { title: "European Journal of Heart Failure" } },
          pubYear: "2025",
          authorString: "Zhang L, Wang H",
          abstractText: "BACKGROUND: SGLT2 inhibitors reduce events. METHODS: Meta-analysis.",
          meshHeadingList: { meshHeading: ["Heart Failure", "Sodium-Glucose Transporter 2 Inhibitors"] },
          pubTypeList: { pubType: ["Meta-Analysis"] },
          isOpenAccess: "Y",
          license: "cc-by",
        },
      ],
    },
  }),
});

const newLiterature = (t, fetchImpl) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  return new LiteratureService(store, { fetchImpl });
};

test('Europe PMC MED identifiers survive lite search and core fetch without a pmid field', async t => {
  const literature = newLiterature(t, async () => ({ ok: true, json: async () => ({resultList:{result:[{id:'39918244',source:'MED',title:'Identifier fixture',pubYear:'2025'}]}}) }));
  const found=await literature.search({query:'identifier fixture',source:'europepmc'});
  assert.equal(found.articles[0].pmid,'39918244');
  const article=await literature.fetchArticle({pmid:found.articles[0].pmid});
  assert.equal(article.pmid,'39918244');
  assert.match(literature.materialText(article),/PMID: 39918244/);
});

test("literature search over PubMed normalizes results with evidence hints", async (t) => {
  const urls = [];
  const literature = newLiterature(t, async (url) => pubmedResponses(urls)(url));
  const result = await literature.search({
    query: "sglt2 heart failure",
    limit: 5,
  });
  assert.equal(result.source, "pubmed");
  assert.equal(result.count, 2);
  assert.equal(result.articles[0].pmid, "39918244");
  assert.deepEqual(result.articles[0].hints, ["Meta 分析"]);
  assert.ok(urls[0].includes("esearch.fcgi"));
  assert.ok(urls[0].includes("sglt2%20heart%20failure"));
  // Cached second call hits no network.
  const urlsBefore = urls.length;
  const cached = await literature.search({ query: "sglt2 heart failure", limit: 5 });
  assert.equal(cached.cached, true);
  assert.equal(urls.length, urlsBefore);
});

test("literature search validates query, source, year range and limit", async (t) => {
  const literature = newLiterature(t, jsonResponse({}));
  await assert.rejects(() => literature.search({ query: "a" }), /至少 2 个字符/);
  await assert.rejects(
    () => literature.search({ query: "valid query", source: "cnki" }),
    /pubmed 或 europepmc/,
  );
  await assert.rejects(
    () =>
      literature.search({ query: "valid query", yearFrom: 2030 }),
    /年份须为/,
  );
  await assert.rejects(
    () =>
      literature.search({ query: "valid query", yearFrom: 2020, yearTo: 2010 }),
    /年份区间无效/,
  );
  await assert.rejects(() => literature.search({ query: "valid query", limit: 99 }), /1–30/);
});

test("literature search over Europe PMC maps fields and open-access flag", async (t) => {
  const literature = newLiterature(t, europeResponse);
  const result = await literature.search({
    query: "sglt2",
    source: "europepmc",
    yearFrom: 2020,
  });
  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0].isOpenAccess, true);
  assert.ok(result.articles[0].hints.includes("Meta 分析"));
});

test("literature fetchArticle resolves PMID with abstract and MeSH; 404 when missing", async (t) => {
  const literature = newLiterature(t, async (url) =>
    url.includes("EXT_ID%3A39918244") || url.includes("DOI%3A")
      ? await coreArticleResponse()
      : await jsonResponse({ resultList: { result: [] } })(),
  );
  const article = await literature.fetchArticle({ pmid: "39918244" });
  assert.equal(article.title, "SGLT2 inhibitors in heart failure");
  assert.match(article.abstract, /BACKGROUND/);
  assert.ok(article.meshTerms.includes("Heart Failure"));
  await assert.rejects(
    () => literature.fetchArticle({ pmid: "1" }),
    (err) => err.code === "NOT_FOUND",
  );
  await assert.rejects(
    () => literature.fetchArticle({}),
    /pmid 或 doi 之一/,
  );
  await assert.rejects(
    () => literature.fetchArticle({ pmid: "abc" }),
    /PMID 格式无效/,
  );
});

test("literature material text contains citation, abstract and provenance", async (t) => {
  const literature = newLiterature(t, async (url) =>
    url.includes("EXT_ID") || url.includes("DOI%3A") ? await coreArticleResponse() : await jsonResponse({ resultList: { result: [] } })(),
  );
  const article = await literature.fetchArticle({ doi: "10.1000/example" });
  const text = literature.materialText(article);
  assert.match(text, /# SGLT2 inhibitors in heart failure/);
  assert.match(text, /PMID: 39918244/);
  assert.match(text, /## 摘要/);
  assert.match(text, /Meta 分析/);
  assert.match(text, /Europe PMC REST API/);
});

test("literature agent tools registered and executable through runTool contract", async (t) => {
  const literature = newLiterature(t, async (url) =>
    url.includes("EXT_ID") || url.includes("DOI%3A") ? await coreArticleResponse() : await jsonResponse({ resultList: { result: [] } })(),
  );
  const tools = literatureTools(literature);
  assert.deepEqual(
    tools.map((t) => t.definition.function.name),
    ["literature_search", "literature_fetch"],
  );
  const fetched = tools[1].execute({ pmid: "39918244" });
  assert.ok(fetched instanceof Promise);
  const article = await fetched;
  assert.equal(article.pmid, "39918244");
});

test("literature API: search errors surface as 502, import creates session material", async (t) => {
  const { fixture } = await import("./helpers.mjs");
  const f = await fixture(t, {
    literature: new LiteratureService(new Store(":memory:"), {
      retryDelayMs: 0,
      fetchImpl: async (url) => {
        if (!url.includes("EXT_ID")) return { ok: false, status: 500, json: async () => ({}) };
        return await coreArticleResponse();
      },
    }),
  });
  const failed = await f.json("/api/literature/search?query=heart+failure");
  assert.equal(failed.status, 502);
  assert.equal(failed.data.code, "LITERATURE_UNAVAILABLE");

  const session = await f.session();
  const imported = await f.json("/api/literature/import", "POST", {
    sessionId: session.id,
    pmid: "39918244",
  });
  assert.equal(imported.status, 201);
  assert.match(imported.data.file.name, /PMID-39918244\.md/);
  const updated = (await f.json(`/api/sessions/${session.id}`)).data;
  assert.equal(updated.files.length, 1);
  assert.match(updated.files[0].text, /SGLT2 inhibitors/);
  assert.ok(updated.files[0].hash);
});


test("transient response retries once; 400 is never retried or switched", async (t) => {
  const store = new Store(":memory:"); t.after(() => store.close());
  let calls = 0;
  const service = new LiteratureService(store, {retryDelayMs:0, fetchImpl:async()=>{
    calls++; return calls === 1 ? {ok:false,status:503} : europeResponse();
  }});
  assert.equal((await service.search({query:"diabetes",source:"europepmc"})).count,1);
  assert.equal(calls,2);
  calls=0;service.fetchImpl=async()=>{calls++;return {ok:false,status:400};};
  await assert.rejects(service.search({query:"other query"}), /HTTP 400/);
  assert.equal(calls,1);
});

test("timeout switches source, preserves filters and provenance, and retries primary next search", async(t)=>{
  const store=new Store(":memory:");t.after(()=>store.close());
  const urls=[];
  const service=new LiteratureService(store,{retryDelayMs:0,fetchImpl:async(url)=>{
    urls.push(url);
    if(url.includes("ncbi"))throw new DOMException("timeout","TimeoutError");
    return europeResponse();
  }});
  const result=await service.search({query:"diabetes",yearFrom:2020,yearTo:2025,sort:"date",limit:3});
  assert.equal(result.source,"europepmc");assert.equal(result.requestedSource,"pubmed");
  assert.equal(result.fallback,true);assert.match(result.fallbackReason,/PubMed 请求超时/);
  assert.equal(urls.length,3);assert.match(decodeURIComponent(urls[2]),/FIRST_PDATE:\[2020 TO 2025\]/);
  assert.match(urls[2],/pageSize=3/);assert.match(urls[2],/sort=/);
  service.fetchImpl=pubmedResponses([]);
  const recovered=await service.search({query:"diabetes",yearFrom:2020,yearTo:2025,sort:"date",limit:3});
  assert.equal(recovered.source,"pubmed");assert.equal(recovered.fallback,undefined);
});

test("both sources failing yields actionable failure, never an empty success",async(t)=>{
  const store=new Store(":memory:");t.after(()=>store.close());let calls=0;
  const service=new LiteratureService(store,{retryDelayMs:0,fetchImpl:async()=>{calls++;throw new TypeError("network");}});
  await assert.rejects(service.search({query:"diabetes"}),e=>e.code==="LITERATURE_UNAVAILABLE" && /PubMed/.test(e.message) && /Europe PMC/.test(e.message));
  assert.equal(calls,4);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM literature_cache").get().n,0);
});

test("body timeout is caught and retried, and valid zero results do not switch sources",async(t)=>{
  const store=new Store(":memory:");t.after(()=>store.close());let calls=0;
  const service=new LiteratureService(store,{timeoutMs:20,retryDelayMs:0,fetchImpl:async(_url,{signal})=>{
    calls++;
    if(calls>1)return {ok:true,json:async()=>({resultList:{result:[]}})};
    return {ok:true,json:()=>new Promise((_resolve,reject)=>{
      const keepAlive=setTimeout(()=>reject(new Error("timeout not enforced")),200);
      signal.addEventListener("abort",()=>{clearTimeout(keepAlive);reject(signal.reason);},{once:true});
    })};
  }});
  const result=await service.search({query:"diabetes",source:"europepmc"});
  assert.equal(calls,2);assert.equal(result.count,0);assert.equal(result.fallback,undefined);
});

test('agent rejects untranslated input before network and requests reformulation', async(t)=>{
  let calls=0;const service=newLiterature(t,async()=>{calls++;return europeResponse();});
  const result=await literatureTools(service)[0].execute({query:'颞叶癫痫感知性症状'});
  assert.equal(result.code,'LITERATURE_REWRITE_REQUIRED');assert.equal(calls,0);
  assert.match(result.error,/尚未执行检索/);
});

test('grouped searches deduplicate identifiers and retain queries, source and partial failures',async(t)=>{
  const service=newLiterature(t,europeResponse);
  const seen=[];
  service.search=async({query,yearFrom,limit})=>{
    seen.push({query,yearFrom,limit});
    if(query==='failed search')throw new Error('network timeout');
    return {source:'europepmc',count:1,articles:[{pmid:'123',doi:'10.1/TEST',title:'Example'}]};
  };
  const result=await literatureTools(service)[0].execute({queries:['temporal epilepsy aura','temporal epilepsy sensory','failed search'],yearFrom:2020,limit:3});
  assert.equal(result.count,1);assert.equal(result.partial,true);
  assert.equal(result.searches.length,3);assert.equal(result.searches[2].status,'failed');
  assert.equal(result.articles[0].matchedQueries.length,2);assert.deepEqual(result.articles[0].sources,['europepmc']);
  assert.ok(seen.every(s=>s.yearFrom===2020&&s.limit===3));
});

test('group validation is bounded, zero is distinct from failure, all-failed never reports zero',async(t)=>{
  const service=newLiterature(t,europeResponse);let calls=0;
  service.search=async()=>{calls++;return {source:'pubmed',count:0,articles:[]};};
  for(const queries of [['one'],['same','same'],['中文','English'],['a','b','c','d','e']])
    await assert.rejects(service.searchGroups({queries}),e=>e.code==='INVALID_INPUT');
  assert.equal(calls,0);
  const result=await service.searchGroups({queries:['core terms','broader terms']});
  assert.equal(result.count,0);assert.equal(result.partial,false);assert.ok(result.searches.every(s=>s.status==='ok'));
  service.search=async()=>{throw new Error('offline');};
  await assert.rejects(service.searchGroups({queries:['core terms','broader terms']}),e=>e.code==='LITERATURE_UNAVAILABLE');
});

test('English medical search terms may retain accents such as déjà vu',async(t)=>{
  const service=newLiterature(t,europeResponse);
  service.search=async()=>({source:'pubmed',count:0,articles:[]});
  const result=await service.searchGroups({queries:['temporal epilepsy déjà vu','temporal epilepsy aura']});
  assert.equal(result.searches.length,2);
});
