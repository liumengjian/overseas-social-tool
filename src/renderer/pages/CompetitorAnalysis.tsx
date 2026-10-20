import React, { useEffect, useState } from "react";
import {
  Card,
  Badge,
  Empty,
  platformLabel,
  Pipeline,
  StructuredText,
} from "../components/ui";
import {
  Platform,
  SocialAccount,
  SocialVideo,
  AppConfig,
  platformConfigured,
} from "../../shared/types";
import { useWorkflow } from "../workflowStore";
import { parseVideoUrl } from "../../data/parse-url";
import { accountCacheKey } from "../../shared/cache-keys";
import { filterAccountVideos } from "../../shared/account-videos";

export default function CompetitorAnalysis() {
  const [inputs, setInputs] = useState<{ platform: Platform; url: string }[]>(
    [],
  );
  const [url, setUrl] = useState("");
  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState("");
  const [cacheNote, setCacheNote] = useState("");
  const [busy, setBusy] = useState(false);
  const pipe = useWorkflow("竞对账号分析");

  useEffect(() => {
    window.api.getConfig().then(setConfig);
  }, []);

  // 跨重启恢复上次操作数据
  useEffect(() => {
    window.api
      .getJson("competitor")
      .then((s: any) => {
        if (!s) return;
        if (Array.isArray(s.inputs)) setInputs(s.inputs);
        if (Array.isArray(s.accounts)) setAccounts(s.accounts);
      })
      .catch(() => {});
  }, []);

  function add() {
    if (!url.trim()) return;
    // 竞对分析不再手动选平台：直接从链接识别平台
    const parsed = parseVideoUrl(url.trim());
    // 微信视频号账号接口接受 channel_id，可直接输入 sph... ID；非 URL 输入按视频号 ID 处理。
    if (!parsed && !/^https?:\/\//i.test(url.trim())) {
      setError("");
      setInputs((p) => [
        ...p,
        { platform: "wechat_channels", url: url.trim() },
      ]);
      setUrl("");
      return;
    }
    if (!parsed) {
      setError(
        "无法识别该链接所属平台，请粘贴对应平台账号链接（支持 TikTok / Instagram / YouTube / 小红书 / 微信视频号）。",
      );
      return;
    }
    if (parsed.platform === "facebook") {
      setError("暂不支持 Facebook 平台的数据抓取与业务分析。");
      return;
    }
    setError("");
    setInputs((p) => [...p, { platform: parsed.platform, url: url.trim() }]);
    setUrl("");
  }

  async function analyze() {
    const latestConfig = await window.api.getConfig();
    setConfig(latestConfig);
    setBusy(true);
    setCacheNote("");
    pipe.enqueue("竞对账号分析", async (runId, signal) => {
      setError("");
      setAccounts(null);
      try {
        const results: SocialAccount[] = [];
        // 抓取上限与「自身账号分析」一致，保证两个模块对同一账号的样本完全相同
        const crawlLimit = Math.min(
          50,
          Math.max(1, latestConfig.fetchVideoCount),
        );
        // 账号分析缓存天数（0 = 禁用缓存，每次重新分析）
        const cacheDays = latestConfig.accountCacheDays;
        let cacheHits = 0;
        for (const i of inputs) {
          if (signal.aborted) return;
          // 先查云端缓存：同一账号在缓存期内分析过 → 直接使用已保存的分析结果（不消耗接口额度 / AI）
          if (cacheDays > 0) {
            const q = await window.api.queryCache({
              key: accountCacheKey(i.platform, i.url, "cmp"),
              type: "competitor_account",
              maxDays: cacheDays,
              runId,
            });
            if (signal.aborted) return;
            if (q.hit && q.data && q.data.id) {
              results.push(q.data as SocialAccount);
              cacheHits++;
              continue;
            }
          }
          const acc = await window.api.fetchAccount({
            platform: i.platform,
            url: i.url,
            runId,
          });
          if (signal.aborted) return;
          let vids: SocialVideo[] = [];
          try {
            // 微信视频号资料查询已完成 ID -> finder username，后续作品抓取直接复用 username，避免重复转换。
            const fetchAccountRef =
              i.platform === "wechat_channels" ? acc.uniqueId : i.url;
            const fetched = await window.api.fetchVideos({
              platform: i.platform,
              url: fetchAccountRef,
              limit: crawlLimit,
              runId,
            });
            if (signal.aborted) return;
            vids = filterAccountVideos(
              fetched,
              i.platform,
              acc.uniqueId,
              acc.name,
            );
          } catch (ve: any) {
            if (signal.aborted) return;
            setError((prev) =>
              prev
                ? `${prev}\n拉取 ${acc.name} 视频失败：${ve?.message ?? ve}`
                : `拉取 ${acc.name} 视频失败：${ve?.message ?? ve}`,
            );
          }
          // 高流量 / 代表性作品：与「自身账号分析」口径一致，按播放量（高流量）降序取前 5，
          // 播放量相同/缺失时以点赞兜底，作为 grounded 分析的真实依据
          const topPosts = vids
            .filter((v) => (v.likes ?? 0) > 0 || (v.views ?? 0) > 0)
            .sort(
              (a, b) =>
                (b.views ?? 0) - (a.views ?? 0) ||
                (b.likes ?? 0) - (a.likes ?? 0),
            )
            .slice(0, 5);
          const posts = topPosts.map((v) => ({
            title: v.title || v.caption || v.hook || "",
            caption: (v.caption || v.title || "").slice(0, 200),
            views: v.views ?? 0,
            likes: v.likes ?? 0,
            comments: v.comments ?? 0,
          }));
          const videoCount =
            acc.videoCount && acc.videoCount > 0 ? acc.videoCount : vids.length;
          // 模块一：用视频解析大模型多模态分析账号（依据简介 + 基础数据 + 高赞作品样本）
          const analysis = await window.api.runAiTask({
            task: "analyzeAccount",
            payload: {
              bio: acc.bio ?? "",
              posts,
              followers:
                acc.followersKnown === false ? undefined : acc.followers,
              videoCount,
              platform: i.platform,
            },
            runId,
          });
          if (signal.aborted) return;
          const isConv = analysis?.account_type === "转化型账号";
          const resultAccount: SocialAccount = {
            ...acc,
            videoCount,
            category: isConv ? "conversion" : "traffic",
            categoryReason: analysis?.reason ?? "AI 未返回分类依据",
            businessPosition: analysis?.account_business_position ?? "",
            targetAudience: analysis?.target_audience ?? "",
            drainageMethod: analysis?.drainage_method ?? "",
            workInsight: analysis?.work_insight ?? "",
            conversionContentInsight:
              analysis?.conversion_content_insight ?? undefined,
            conversionTriggers: analysis?.conversion_triggers ?? undefined,
            conversionFriction: analysis?.conversion_friction ?? undefined,
            contentOptimization: analysis?.content_optimization ?? undefined,
            audienceFavoriteContent:
              analysis?.audience_favorite_content ?? undefined,
            popularContentPattern:
              analysis?.popular_content_pattern ?? undefined,
            contentOpportunity: analysis?.content_opportunity ?? undefined,
            worksSample: topPosts.map((v) => ({
              title: v.title || v.caption || v.hook || "",
              likes: v.likes ?? 0,
              views: v.views ?? 0,
              viewsKnown: v.viewsKnown,
              url: v.url,
            })),
            categoryEvidence: [
              `粉丝：${acc.followersKnown === false || (acc.platform === "wechat_channels" && acc.followers === 0) ? "-" : (acc.followers ?? 0).toLocaleString()}`,
              `作品：${videoCount} 条`,
              topPosts.length
                ? `已分析高流量作品 ${topPosts.length} 条（按播放量排序）`
                : "未抓到作品样本",
            ],
          };
          results.push(resultAccount);
          // 分析结果入库（云端缓存）：同一账号在缓存期内再次分析直接命中，不再消耗接口额度 / AI
          if (cacheDays > 0) {
            await window.api
              .saveCache({
                key: accountCacheKey(i.platform, i.url, "cmp"),
                type: "competitor_account",
                data: resultAccount,
                refUrl: i.url,
              })
              .catch(() => {});
          }
        }
        if (signal.aborted) return;
        setAccounts(results);
        setCacheNote(
          cacheHits > 0
            ? `${cacheHits} 个账号在缓存期内（${cacheDays} 天）已有分析结果，已直接展示；如需强制重新分析，请在「设置」页将账号缓存天数设为 0。`
            : "",
        );
        // 持久化本次操作数据，下次打开直接展示
        window.api
          .setJson("competitor", { inputs, accounts: results })
          .catch(() => {});
      } catch (e: any) {
        if (signal.aborted) return;
        setError(e?.message ?? String(e));
        throw e;
      } finally {
        setBusy(false);
      }
    });
  }

  const conv = accounts?.filter((a) => a.category === "conversion").length ?? 0;
  // 数据接口按平台判断：所有支持的平台均使用 TiKhub。
  const dataConfigured =
    inputs.length > 0 &&
    inputs.every((i) => platformConfigured(config, i.platform));

  return (
    <div className="page">
      <h1>一、竞对账号智能分析</h1>
      <p className="muted">
        粘贴竞对账号链接后点击「开始分析」：系统先精确判断「转化型 /
        流量型」账号，再按类型做专项分析——转化型账号重点看「什么内容带来了客户咨询和订单」，流量型账号重点看「海外用户喜欢看的中国旅游内容」。
      </p>

      <Card title="添加竞对账号">
        <div className="row">
          <input
            placeholder="粘贴账号链接，或输入微信视频号 ID（如 sph...）"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            style={{ flex: 1 }}
          />
          <button onClick={add} disabled={!url.trim()}>
            添加
          </button>
        </div>
        {inputs.length === 0 ? (
          <p className="muted" style={{ marginTop: 10 }}>
            暂无竞对账号，粘贴链接后点击「添加」。
          </p>
        ) : (
          <ul className="kv">
            {inputs.map((i, idx) => (
              <li key={idx}>
                <span className="muted">{platformLabel(i.platform)}</span>{" "}
                <code>{i.url}</code>
                <button
                  className="link"
                  onClick={() =>
                    setInputs((s) => s.filter((_, k) => k !== idx))
                  }
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          className="primary"
          onClick={analyze}
          disabled={
            busy ||
            inputs.length === 0 ||
            !config?.minimaxConfigured ||
            !dataConfigured
          }
        >
          {busy ? "分析中…" : "开始分析"}
        </button>
        <p className="muted small" style={{ marginTop: 10 }}>
          分析时会自动拉取该账号的视频作为分析依据（消耗接口额度）。
        </p>
        {config && !config.minimaxConfigured && (
          <p className="muted" style={{ marginTop: 10 }}>
            未配置视频解析大模型（请在 .env 配置模型 API Key，用于 AI
            账号分类）。
          </p>
        )}
        {config && config.minimaxConfigured && !dataConfigured && (
          <p className="muted" style={{ marginTop: 10 }}>
            以下平台尚未配置对应数据接口：
            {Array.from(
              new Set(
                inputs
                  .filter((i) => !platformConfigured(config, i.platform))
                  .map((i) => platformLabel(i.platform)),
              ),
            ).join(" / ")}
            。请在「设置」页填写 TIKHUB_API_TOKEN；Facebook
            平台当前不支持数据抓取与业务分析。
          </p>
        )}
      </Card>

      {error && <p className="err">{error}</p>}
      {cacheNote && (
        <p className="muted" style={{ marginTop: 10 }}>
          {cacheNote}
        </p>
      )}
      {accounts && accounts.length === 0 && (
        <Empty text="未获取到竞对账号数据" />
      )}
      {accounts && accounts.length > 0 && (
        <>
          <div className="stat-row">
            <Card>
              <div className="stat">
                <div className="stat-value">{accounts.length}</div>
                <div className="stat-label">竞对账号</div>
              </div>
            </Card>
            <Card>
              <div className="stat">
                <div className="stat-value">{conv}</div>
                <div className="stat-label">转化型账号</div>
              </div>
            </Card>
            <Card>
              <div className="stat">
                <div className="stat-value">{accounts.length - conv}</div>
                <div className="stat-label">流量型账号</div>
              </div>
            </Card>
          </div>

          {/* 每个账号一张分析卡片（与「爆款视频拆解」的结果区风格一致）：上方输入链接，下方展示该账号的具体分析 */}
          {accounts.map((a) => (
            <Card
              key={a.id}
              title={`${platformLabel(a.platform)} · ${a.name}`}
              right={
                a.category === "conversion" ? (
                  <Badge kind="conv">转化型账号</Badge>
                ) : (
                  <Badge kind="traffic">流量型账号</Badge>
                )
              }
            >
              <div className="info-grid">
                <div className="info-item">
                  <span className="info-label">粉丝</span>
                  <span className="info-value">
                    {a.followersKnown === false ||
                    (a.platform === "wechat_channels" && a.followers === 0)
                      ? "-"
                      : (a.followers ?? 0).toLocaleString()}
                  </span>
                </div>
                <div className="info-item">
                  <span className="info-label">分类依据</span>
                  <div className="info-value col-detail">
                    <StructuredText text={a.categoryReason} />
                  </div>
                </div>
              </div>

              <div className="muted small col-detail" style={{ marginTop: 12 }}>
                <div className="struct-field">
                  <b>业务定位：</b>
                  <StructuredText text={a.businessPosition} />
                </div>
                <div className="struct-field">
                  <b>目标客群：</b>
                  <StructuredText text={a.targetAudience} />
                </div>
                <div className="struct-field">
                  <b>引流方式：</b>
                  <StructuredText text={a.drainageMethod} />
                </div>
                {a.workInsight && (
                  <div className="struct-field" style={{ marginTop: 6 }}>
                    <b>作品洞察：</b>
                    <StructuredText text={a.workInsight} />
                  </div>
                )}

                {a.category === "conversion" ? (
                  <div
                    style={{
                      marginTop: 10,
                      borderTop: "1px dashed var(--panel2)",
                      paddingTop: 8,
                    }}
                  >
                    <div className="muted small" style={{ marginBottom: 4 }}>
                      【转化型专项】什么内容带来了客户咨询和订单？
                    </div>
                    <div className="struct-field">
                      <b>带来咨询/订单的内容：</b>
                      <StructuredText text={a.conversionContentInsight} />
                    </div>
                    <div className="struct-field">
                      <b>转化触发点：</b>
                      <StructuredText text={a.conversionTriggers} />
                    </div>
                    <div className="struct-field">
                      <b>转化阻碍：</b>
                      <StructuredText text={a.conversionFriction} />
                    </div>
                    {a.contentOptimization &&
                      a.contentOptimization.length > 0 && (
                        <div className="struct-field">
                          <b>优化建议：</b>
                          <StructuredText
                            text={a.contentOptimization.join("\n")}
                          />
                        </div>
                      )}
                  </div>
                ) : (
                  <div
                    style={{
                      marginTop: 10,
                      borderTop: "1px dashed var(--panel2)",
                      paddingTop: 8,
                    }}
                  >
                    <div className="muted small" style={{ marginBottom: 4 }}>
                      【流量型专项】海外用户喜欢看的中国旅游内容
                    </div>
                    <div className="struct-field">
                      <b>海外用户爱看的内容：</b>
                      <StructuredText text={a.audienceFavoriteContent} />
                    </div>
                    <div className="struct-field">
                      <b>高播放共性模式：</b>
                      <StructuredText text={a.popularContentPattern} />
                    </div>
                    {a.contentOpportunity &&
                      a.contentOpportunity.length > 0 && (
                        <div className="struct-field">
                          <b>可复制选题：</b>
                          <StructuredText
                            text={a.contentOpportunity.join("\n")}
                          />
                        </div>
                      )}
                  </div>
                )}
              </div>

              <div style={{ marginTop: 12 }}>
                <div className="muted small" style={{ marginBottom: 4 }}>
                  作品样本（高流量 Top，按播放量排序）
                </div>
                {a.worksSample && a.worksSample.length > 0 ? (
                  <ul className="ev">
                    {a.worksSample.map((w, k) => (
                      <li key={k}>
                        {w.title
                          ? `${w.title.slice(0, 40)}${w.title.length > 40 ? "…" : ""}`
                          : "（无标题）"}
                        <span className="muted">
                          {" "}
                          · 👁
                          {w.viewsKnown === false ||
                          (a.platform === "wechat_channels" && w.views === 0)
                            ? "-"
                            : w.views.toLocaleString()}{" "}
                          · 👍{w.likes.toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="muted">无作品样本</span>
                )}
              </div>

              {a.categoryEvidence && a.categoryEvidence.length > 0 && (
                <ul className="ev" style={{ marginTop: 8 }}>
                  {a.categoryEvidence.map((e, k) => (
                    <li key={k}>{e}</li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
