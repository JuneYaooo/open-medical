import { useEffect, useState } from "react";
import { api } from "../../../src/agent-runtime";
import { FeishuBinding } from "../../../src/feishu-binding";
import "../../../src/doctor-notifications.css";
import "../../../src/message-channels.css";

const states = {
  disabled: "已停用",
  stopped: "网关未运行",
  connecting: "正在连接",
  connected: "收消息连接正常",
  reconnecting: "正在重连",
  failed: "连接失败，请重试或重新扫码",
  conflict: "应用已被飞书分身使用",
};
const deliveryStates = {
  ignored: "未授权，仅登记账号",
  queued: "排队中",
  running: "处理中",
  ready: "等待发送",
  sending: "正在发送",
  sent: "平台已接受回复",
  unknown: "送达不确定，请先核对聊天",
  failed: "发送失败",
  revoked: "授权已变更，已停止",
  cancelled: "已取消",
};
const stamp = (at) => (at ? new Date(at).toLocaleString("zh-CN") : "");

function Channel({ channel, model, action, refresh }) {
  const [form, setForm] = useState(() => ({
    ...channel,
    authorizeModel: false,
  }));
  useEffect(() => {
    setForm({ ...channel, authorizeModel: false });
  }, [channel.id, channel.revision]);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  return (
    <section
      className="notification-channel message-channel"
      aria-label={channel.name}
    >
      <header>
        <div>
          <h3>{channel.name}</h3>
          <p role="status"><span className={`om-chip ${channel.state === "connected" ? "is-ok" : ["failed", "conflict"].includes(channel.state) ? "is-danger" : channel.state === "disabled" ? "" : "is-caution"}`}>{states[channel.state] || "尚未连接"}</span></p>
        </div>
        <span>{channel.platform === "feishu" ? "飞书" : "微信"}</span>
      </header>
      {channel.platform === "feishu" && (
        <>
          <a
            className="chat-next-link"
            href={`https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(channel.appId)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            打开飞书助手 ↗
          </a>
          {channel.boundUserId && (
            <p>
              扫码账号已绑定。打开助手发送「连接测试」，收到回复即可开始使用。
            </p>
          )}
        </>
      )}
      <details open={channel.needsConsent || !channel.enabled}>
        <summary>
          连接与模型设置{channel.needsConsent ? " · 待授权模型" : ""}
        </summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action(() =>
              api("/api/message-channels", "PUT", {
                ...form,
                expectedRevision: channel.revision,
              }),
            );
          }}
        >
          <label>
            连接名称
            <input
              value={form.name}
              maxLength={60}
              onChange={(e) => set("name", e.target.value)}
            />
          </label>
          <p>
            当前模型：
            {model
              ? `${model.provider} · ${model.model}${model.local ? "（本地）" : ""}`
              : "尚未配置"}
          </p>
          <label className="notification-checkbox">
            <input
              type="checkbox"
              checked={form.authorizeModel}
              onChange={(e) => set("authorizeModel", e.target.checked)}
            />
            授权此渠道使用当前模型处理医生消息、历史及任务所需资料，并将回答发送到已授权的私聊
          </label>
          <p className="muted">
            {channel.needsConsent
              ? "模型尚未授权或已更换，任务会暂停并提示重新授权。"
              : "当前模型已授权。"}{" "}
            外部模型会接收任务所需内容。账号仅供医生本人使用；患者档案和随访提案请在工作台核对后执行。
          </p>
          <label className="notification-checkbox">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => set("enabled", e.target.checked)}
            />
            启用接收医生私聊
          </label>
          <div className="toolbar-actions">
            <button type="submit">保存连接</button>
            <button
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    "断开并删除此连接？连接凭据和账号授权会删除，工作台会话历史保留。",
                  )
                )
                  action(() =>
                    api(`/api/message-channels/${channel.id}`, "DELETE", {
                      expectedRevision: channel.revision,
                    }),
                  );
              }}
            >
              断开并删除
            </button>
          </div>
        </form>
      </details>
      <details open={!channel.boundUserId}>
        <summary>管理使用账号</summary>
        <h4>授权医生账号</h4>
        <p>
          {channel.boundUserId
            ? "扫码账号的首条私聊会自动识别。仅绑定账号可以启用；取消勾选可停止该账号使用。"
            : "已有授权仍然有效。需要更换使用账号时，请断开并重新扫码。"}
        </p>
        {!channel.peers.length && (
          <p className="muted">尚未发现账号。未授权的消息不会交给模型。</p>
        )}
        {channel.peers.map((peer) => (
          <div className="message-peer" key={peer.id}>
            <label className="notification-checkbox">
              <input
                type="checkbox"
                checked={peer.allowed}
                disabled={!peer.allowed && peer.senderId !== channel.boundUserId}
                onChange={(e) =>
                  action(() =>
                    api(`/api/message-channels/peers/${peer.id}`, "PUT", {
                      allowed: e.target.checked,
                      expectedRevision: peer.revision,
                    }),
                  )
                }
              />
              <span>
                {peer.senderId === channel.boundUserId ? '我的扫码账号' : '已发现的账号'}
                <small>首次联系：{stamp(peer.firstSeen)}</small>
              </span>
            </label>
            <p>
              {peer.lastVerifiedAt
                ? `最近收发成功：${stamp(peer.lastVerifiedAt)}`
                : "尚未完成收发验证"}
            </p>
            {peer.sessionId && (
              <a
                href={`/?view=workbench&session=${encodeURIComponent(peer.sessionId)}`}
              >
                在工作台打开会话
              </a>
            )}
          </div>
        ))}
        <button onClick={refresh}>刷新账号与连接状态</button>
      </details>
      {!!channel.deliveries.length && (
        <details>
          <summary>最近任务与发送记录</summary>
          <ul className="message-deliveries">
            {channel.deliveries.map((d) => (
              <li key={d.id}>
                <span>
                  {stamp(d.at)} · {deliveryStates[d.status] || d.status}
                </span>
                {d.sessionId && (
                  <a
                    href={`/?view=workbench&session=${encodeURIComponent(d.sessionId)}`}
                  >
                    查看任务
                  </a>
                )}
                {["failed", "unknown", "ready"].includes(d.status) && (
                  <button
                    onClick={() => {
                      if (
                        d.status !== "unknown" ||
                        window.confirm(
                          "请先核对聊天，确认没有收到完整回复。重试可能重复发送，但不会重新执行任务。",
                        )
                      )
                        action(() =>
                          api(
                            `/api/message-channels/deliveries/${d.id}`,
                            "POST",
                            {},
                          ),
                        );
                    }}
                  >
                    重发已保存的回复
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export function MessageChannelSettings() {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [qr, setQr] = useState(null),
    [qrState, setQrState] = useState("");
  const refresh = () => api("/api/message-channels").then(setData);
  useEffect(() => {
    let active = true;
    const load = () =>
      api("/api/message-channels")
        .then((v) => {
          if (active) setData(v);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!qr) return;
    let active = true,
      timer;
    const poll = async () => {
      try {
        const result = await api(
          "/api/message-channels/qrcode-status",
          "POST",
          { id: qr.id },
        );
        if (!active) return;
        if (result.status === "confirmed") {
          setQr(null);
          setData(result);
          setNotice(
            "微信已绑定。启用连接并授权模型后，即可用扫码账号发送任务。",
          );
          return;
        }
        if (result.status === "expired") {
          setQr(null);
          setError("二维码已过期，请重新生成。");
          return;
        }
        setQrState(
          ["scaned", "scanned"].includes(result.status)
            ? "请在手机上确认"
            : "等待扫码",
        );
        timer = setTimeout(poll, 1500);
      } catch (e) {
        if (active) {
          setQr(null);
          setError(e.message);
        }
      }
    };
    poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [qr]);
  async function action(fn) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await fn();
      if (result?.channels) setData(result);
      setNotice("设置已保存，请查看连接状态。");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="doctor-notifications message-channels"
      aria-label="私聊助手"
    >
      <h2>私聊助手</h2>
      <p>
        通过飞书或微信私聊使用医生助手。任务与历史保存在工作台，回答回到原聊天。
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!data ? (
        <button onClick={() => action(refresh)}>重新加载</button>
      ) : (
        <fieldset disabled={busy}>
          {data.channels.map((c) => (
            <Channel
              key={c.id}
              channel={c}
              model={data.model}
              action={action}
              refresh={() => action(refresh)}
            />
          ))}
          {!data.channels.some((c) => c.platform === "feishu") && (
            <section className="notification-channel">
              <h3>飞书医生助手 <span className="om-chip is-caution">未连接</span></h3>
              <FeishuBinding
                binding={data.feishuBinding}
                model={data.model}
                modelFingerprint={data.modelFingerprint}
                onUpdated={refresh}
              />

            </section>
          )}
          {!data.channels.some((c) => c.platform === "wechat") && (
            <section className="notification-channel">
              <h3>微信医生助手 <span className="om-chip is-caution">未连接</span></h3>
              <p>
                使用 iLink
                机器人私聊，扫码不读取个人微信历史或普通群聊。当前支持文字任务，图片和文件请在工作台添加。
              </p>
              <button
                className="primary"
                disabled={!!qr}
                onClick={() =>
                  action(async () => {
                    const value = await api(
                      "/api/message-channels/qrcode",
                      "POST",
                      {},
                    );
                    setQr(value);
                    setQrState("等待扫码");
                  })
                }
              >
                微信扫码连接助手
              </button>
              {qr && (
                <div>
                  <img
                    src={qr.image}
                    alt="微信医生助手连接二维码"
                    width="240"
                    height="240"
                  />
                  <p role="status">{qrState}</p>
                  <button
                    onClick={() => {
                      const id = qr.id;
                      setQr(null);
                      action(() =>
                        api("/api/message-channels/qrcode-cancel", "POST", {
                          id,
                        }),
                      );
                    }}
                  >
                    取消扫码
                  </button>
                </div>
              )}
            </section>
          )}
          <details>
            <summary>使用与运行说明</summary>
            <p>
              仅接收已授权医生的文字私聊。发送 /new 开启新会话，/status
              查看状态，/stop
              停止任务。电脑需保持运行并联网；关闭窗口可在后台运行，退出应用后停止。需要核对的医疗或文件修改回到工作台确认。
            </p>
            <p>
              飞书分身与医生助手使用独立的飞书应用和授权。微信历史导入、患者消息归档在「患者随访连接」管理。
            </p>
          </details>
        </fieldset>
      )}
    </section>
  );
}

export default MessageChannelSettings;
