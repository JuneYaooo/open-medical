import { AppError, check, string } from "../errors.mjs";

import {splitEligibility} from "../../shared/trial-protocol.mjs";
export {splitEligibility};

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
    const labels = {
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
}
