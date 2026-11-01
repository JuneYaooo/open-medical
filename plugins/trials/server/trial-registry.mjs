import { AppError, check, string } from "../../../server/errors.mjs";

import {splitEligibility} from "../../../shared/trial-protocol.mjs";
export {splitEligibility};

const STATUS_LABELS = {
  RECRUITING: "正在招募",
  NOT_YET_RECRUITING: "尚未开始招募",
  ACTIVE_NOT_RECRUITING: "进行中，不再招募",
  COMPLETED: "已完成",
  TERMINATED: "已终止",
  SUSPENDED: "已暂停",
  WITHDRAWN: "已撤回",
  UNKNOWN: "状态未知",
  ENROLLING_BY_INVITATION: "邀请入组",
};
export const SEARCH_STATUSES = Object.freeze(["RECRUITING", "NOT_YET_RECRUITING", "ENROLLING_BY_INVITATION", "ACTIVE_NOT_RECRUITING", "COMPLETED"]);
const EXCERPT = 1500;
const optional = (value, name, max) => (value === undefined || value === null || value === "" ? "" : string(value, name, max).trim());

export class TrialRegistry {
  constructor({ fetchImpl = fetch, timeoutMs = 15000 } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }
  async lookup(value) {
    const id = string(value, "NCT 注册号", 20).toUpperCase();
    check(
      /^NCT\d{8}$/.test(id),
      "INVALID_INPUT",
      "请输入 NCT 加 8 位数字的注册号",
    );
    let data;
    try {
      const response = await this.fetchImpl(
        `https://clinicaltrials.gov/api/v2/studies/${id}?format=json`,
        {
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: "error",
          headers: { Accept: "application/json" },
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(
          "TRIAL_REGISTRY",
          response.status === 404
            ? "未找到该注册号"
            : "注册平台暂时不可用，请稍后重试或上传方案",
          response.status === 404 ? 404 : 502,
        );
      }
      const text = await response.text();
      check(
        text.length <= 2000000,
        "TRIAL_REGISTRY",
        "注册记录过大，请打开原网页核对",
        502,
      );
      data = JSON.parse(text);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "TRIAL_REGISTRY",
        "注册平台连接失败或返回数据异常，可稍后重试或上传方案",
        502,
      );
    }
    const p = data.protocolSection;
    check(
      p?.identificationModule?.nctId === id,
      "TRIAL_REGISTRY",
      "注册平台返回记录与查询不一致",
      502,
    );
    const status = p.statusModule || {},
      eligibility = p.eligibilityModule || {},
      protocolText = eligibility.eligibilityCriteria || "";
    const labels = STATUS_LABELS;
    const parsed=splitEligibility(protocolText);
    const extraCriteria=[
      eligibility.minimumAge || eligibility.maximumAge ? `注册年龄要求：下限 ${eligibility.minimumAge||'未提供'}；上限 ${eligibility.maximumAge||'未提供'}（保留注册原值，请结合方案核对）。` : '',
      eligibility.sex ? `注册性别要求：${({ALL:'所有性别',MALE:'男性',FEMALE:'女性'})[eligibility.sex]||eligibility.sex}。` : '',
    ].filter(Boolean);
    return {
      title:
        p.identificationModule.briefTitle ||
        p.identificationModule.officialTitle ||
        id,
      registration: id,
      version: `注册记录更新：${status.lastUpdatePostDateStruct?.date || "未注明"}`,
      sourceUrl: `https://clinicaltrials.gov/study/${id}`,
      site: (p.contactsLocationsModule?.locations || [])
        .slice(0, 5)
        .map((l) => [l.facility, l.city, l.country].filter(Boolean).join(" · "))
        .join("；")
        .slice(0, 300),
      recruitment: labels[status.overallStatus] || "待研究中心确认",
      protocolText: [extraCriteria.join('\n'),protocolText].filter(Boolean).join('\n\n'),
      ...parsed,
      inclusion: parsed.inclusion ? [...extraCriteria,parsed.inclusion].join('\n') : '',
      fetchedAt: new Date().toISOString(),
      demographics: {
        sex: eligibility.sex,
        minimumAge: eligibility.minimumAge,
        maximumAge: eligibility.maximumAge,
      },
      notice:
        "这是注册信息快照，可能与研究中心现行方案不同。请核实方案版本、中心招募状态及完整资格标准。",
    };
  }
  // ClinicalTrials.gov v2 检索：只发送检索词（疾病、关键词、国家），不含患者资料。
  // 返回注册号、标题、状态、疾病、地点和入排标准节选；失败如实报错。
  async search(input = {}) {
    const condition = optional(input.condition, "疾病或适应证", 200);
    const term = optional(input.term, "关键词", 200);
    check(condition || term, "INVALID_INPUT", "请至少提供疾病（condition）或关键词（term），用英文检索效果更好");
    const country = optional(input.country, "国家", 60);
    const statuses = (Array.isArray(input.status) ? input.status : [input.status || "RECRUITING"]).map((x) => String(x).toUpperCase());
    check(statuses.every((x) => SEARCH_STATUSES.includes(x)), "INVALID_INPUT", `招募状态须为：${SEARCH_STATUSES.join("/")}`);
    const pageSize = Math.min(Math.max(Number.parseInt(input.pageSize, 10) || 10, 1), 20);
    const params = new URLSearchParams({ format: "json", pageSize: String(pageSize), countTotal: "true", "filter.overallStatus": statuses.join(",") });
    if (condition) params.set("query.cond", condition);
    if (term) params.set("query.term", term);
    if (country && input.countryOnly) params.set("query.locn", country);
    let data;
    try {
      const response = await this.fetchImpl(`https://clinicaltrials.gov/api/v2/studies?${params}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError("TRIAL_REGISTRY", response.status === 400 ? "注册平台不接受该检索条件，请改用英文疾病名或简化关键词" : `注册平台暂时不可用（HTTP ${response.status}），请稍后重试`, 502);
      }
      const text = await response.text();
      check(text.length <= 8000000, "TRIAL_REGISTRY", "检索结果过大，请缩小检索范围", 502);
      data = JSON.parse(text);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("TRIAL_REGISTRY", error?.name === "TimeoutError" ? "注册平台响应超时，请稍后重试" : "注册平台连接失败或返回数据异常，请稍后重试", 502);
    }
    check(Array.isArray(data?.studies), "TRIAL_REGISTRY", "注册平台返回数据格式异常", 502);
    const wanted = country.toLowerCase();
    const studies = data.studies.map((study) => {
      const p = study.protocolSection || {};
      const id = p.identificationModule?.nctId || "";
      const eligibility = p.eligibilityModule || {};
      const all = p.contactsLocationsModule?.locations || [];
      const inCountry = wanted ? all.filter((l) => String(l.country || "").toLowerCase() === wanted) : [];
      const ordered = wanted ? [...inCountry, ...all.filter((l) => !inCountry.includes(l))] : all;
      const criteria = eligibility.eligibilityCriteria || "";
      return {
        registration: id,
        title: p.identificationModule?.briefTitle || p.identificationModule?.officialTitle || id,
        status: p.statusModule?.overallStatus || "",
        statusLabel: STATUS_LABELS[p.statusModule?.overallStatus] || "状态未知",
        phases: p.designModule?.phases || [],
        conditions: (p.conditionsModule?.conditions || []).slice(0, 8),
        sponsor: p.sponsorCollaboratorsModule?.leadSponsor?.name || "",
        locationCount: all.length,
        ...(wanted ? { countryLocations: inCountry.length } : {}),
        locations: ordered.slice(0, 6).map((l) => [l.facility, l.city, l.country].filter(Boolean).join(" · ")),
        eligibility: {
          sex: eligibility.sex || "", minimumAge: eligibility.minimumAge || "", maximumAge: eligibility.maximumAge || "",
          excerpt: criteria.slice(0, EXCERPT), truncated: criteria.length > EXCERPT,
        },
        lastUpdate: p.statusModule?.lastUpdatePostDateStruct?.date || "",
        sourceUrl: id ? `https://clinicaltrials.gov/study/${id}` : "",
      };
    }).filter((x) => /^NCT\d{8}$/.test(x.registration));
    if (wanted) studies.sort((a, b) => (b.countryLocations > 0) - (a.countryLocations > 0));
    return {
      source: "ClinicalTrials.gov",
      query: { condition, term, country, countryOnly: Boolean(input.countryOnly), status: statuses },
      total: Number.isInteger(data.totalCount) ? data.totalCount : null,
      studies,
      hasMore: Boolean(data.nextPageToken),
      fetchedAt: new Date().toISOString(),
      notice: "注册信息快照，可能与研究中心现行方案不同；入排标准为节选。导入时用 trial_protocol_propose 传 registryId，会读取完整注册记录。",
    };
  }
}
