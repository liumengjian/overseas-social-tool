import React, { useState } from "react";
import { Card, platformLabel, StructuredText } from "../components/ui";
import {
  SocialVideo,
  SocialAccount,
  AppConfig,
  platformConfigured,
} from "../../shared/types";
import { useWorkflow } from "../workflowStore";
import { parseVideoUrl } from "../../data/parse-url";
import { splitOwnWorksByTraffic } from "../../shared/own-works";
import { filterAccountVideos } from "../../shared/account-videos";
import { accountCacheKey } from "../../shared/cache-keys";

export default function OwnAccount() {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [account, setAccount] = useState<SocialAccount | null>(null);
  const [ownVideos, setOwnVideos] = useState<SocialVideo[]>([]);
  const [analysis, setAnalysis] = useState<any>(null);
  const [cacheNote, setCacheNote] = useState("");
  const [busy, setBusy] = useState(false);
  const pipe = useWorkflow("自身账号分析");

  React.useEffect(() => {
    window.api.getConfig().then(setConfig);
  }, []);

  // 跨重启恢复上次操作数据（输入 + 结果）
  React.useEffect(() => {
    window.api
      .getJson("own_account")
      .then((s: any) => {
        if (!s) return;
        if (typeof s.url === "string") setUrl(s.url);
        if (s.account) setAccount(s.account);
        if (Array.isArray(s.ownVideos)) setOwnVideos(s.ownVideos);
        if (s.analysis) setAnalysis(s.analysis);
      })
      .catch(() => {});
  }, []);

  // 渲染期预校验：直接从链接识别平台，用于启用按钮与密钥提示（账号分析不再手动选平台）
  const detected = url.trim()
    ? (parseVideoUrl(url.trim())?.platform ??
      (!/^https?:\/\//i.test(url.trim()) ? "wechat_channels" : undefined))
    : undefined;
  const dataReady = detected ? platformConfigured(config, detected) : false;
  const canAnalyze = (config?.minimaxConfigured ?? false) && dataReady;

  async function run() {
    if (!url.trim()) return;
    const latestConfig = await window.api.getConfig();
    setConfig(latestConfig);
    // 账号分析不再手动选平台：直接从链接识别平台
    let parsed = parseVideoUrl(url.trim());
    if (!parsed && !/^https?:\/\//i.test(url.trim())) {
      parsed = {
        platform: "wechat_channels",
        videoId: url.trim(),
        cleanUrl: url.trim(),
      };
    }
    if (!parsed) {
      setError(
        "无法识别该链接所属平台，请粘贴对应平台的账号主页链接（支持 TikTok / Instagram / YouTube / 小红书 / 微信视频号）。",
      );
      return;
    }
    const platform = parsed.platform;
    if (platform === "facebook") {
      setError("暂不支持 Facebook 平台的数据抓取与业务分析。");
      return;
    }
    if (!platformConfigured(latestConfig, platform)) {
      setError(
        `未配置 ${platformLabel(platform)} 的数据接口，请在「设置」页填写 TIKHUB_API_TOKEN。`,
      );
      return;
    }
    setBusy(true);
    pipe.enqueue("自身账号分析", async (runId, signal) => {
      setError("");
      setAccount(null);
      setOwnVideos([]);
      setAnalysis(null);
      try {
        // 先查云端缓存：同一账号在缓存期内分析过 → 直接展示保存的结果（不消耗接口额度 / AI）
        const cacheDays = latestConfig.accountCacheDays;
        if (cacheDays > 0) {
          const q = await window.api.queryCache({
            key: accountCacheKey(platform, url.trim(), "own"),
            type: "own_account",
            maxDays: cacheDays,
            runId,
          });
          if (signal.aborted) return;
          if (q.hit && q.data && q.data.account) {
            setAccount(q.data.account);
            setOwnVideos(q.data.ownVideos ?? []);
            setAnalysis(q.data.analysis);
            setCacheNote(
              `该账号在缓存期内（${cacheDays} 天）已有分析结果，已直接展示；如需重新分析，请在「设置」页将账号缓存天数设为 0。`,
            );
            window.api
              .setJson("own_account", {
                platform,
                url: url.trim(),
                account: q.data.account,
                ownVideos: q.data.ownVideos ?? [],
                analysis: q.data.analysis,
              })
              .catch(() => {});
            return;
          }
        }
        setCacheNote("");
        // 仅输入账号链接：粉丝/简介/作品全部来自对应接口实时拉取
        const acc: SocialAccount = await window.api.fetchAccount({
          platform,
          url: url.trim(),
          runId,
        });
        if (signal.aborted) return;
        // 抓取上限取设置中的「默认抓取视频数量」（1~50，默认 50）；不足则全部抓取
        const crawlLimit = Math.min(
          50,
          Math.max(1, latestConfig.fetchVideoCount),
        );
        // 账号资料接口已经把视频号 ID 转成 finder username；复用该结果，避免再次转换原始 ID。
        const fetchAccountRef =
          platform === "wechat_channels" ? acc.uniqueId : url.trim();
        const fetched: SocialVideo[] = await window.api.fetchVideos({
          platform,
          url: fetchAccountRef,
          limit: crawlLimit,
          runId,
        });
        if (signal.aborted) return;
        const videos = filterAccountVideos(
          fetched,
          platform,
          acc.uniqueId,
          acc.name,
        );
        setAccount(acc);
        setOwnVideos(videos);

        // 模块六：把真实作品按播放量拆成「高流量组 / 低流量组」，分别归因
        const { high, low } = splitOwnWorksByTraffic(videos);
        const toSample = (v: SocialVideo) => ({
          title: v.title || v.caption || "",
          caption: v.caption,
          views: v.views,
          likes: v.likes,
          comments: v.comments,
          shares: v.shares,
          tags: v.tags,
          durationSec: v.durationSec,
        });
        const res = await window.api.runAiTask({
          task: "analyzeOwnAccount",
          payload: {
            accountName: acc.name,
            followers: acc.followersKnown === false ? undefined : acc.followers,
            videoCount: videos.length,
            highTrafficWorks: high.map(toSample),
            lowTrafficWorks: low.map(toSample),
          },
          runId,
        });
        if (signal.aborted) return;
        setAnalysis(res);
        // 分析结果入库（云端缓存）：同一账号在缓存期内再次分析直接命中
        if (cacheDays > 0) {
          await window.api
            .saveCache({
              key: accountCacheKey(platform, url.trim(), "own"),
              type: "own_account",
              data: {
                platform,
                account: acc,
                ownVideos: videos,
                analysis: res,
              },
              refUrl: url.trim(),
            })
            .catch(() => {});
        }
        // 持久化本次操作数据（输入 + 结果），下次打开直接展示
        window.api
          .setJson("own_account", {
            platform,
            url: url.trim(),
            account: acc,
            ownVideos: videos,
            analysis: res,
          })
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

  const videoSamples = ownVideos.filter((video) => video.isVideo !== false);
  const publishedCount =
    account?.videoCount && account.videoCount > 0
      ? account.videoCount
      : ownVideos.length;
  const averageBase = ownVideos;
  const hasKnownViews = averageBase.some(
    (video) =>
      video.viewsKnown !== false &&
      !(video.platform === "wechat_channels" && video.views === 0),
  );
  const averageViews = averageBase.length
    ? Math.round(
        averageBase
          .filter((video) => video.viewsKnown !== false)
          .reduce(
            (sum, video) =>
              sum + (Number.isFinite(video.views) ? video.views : 0),
            0,
          ) /
          Math.max(
            averageBase.filter((video) => video.viewsKnown !== false).length,
            1,
          ),
      )
    : 0;

  return (
    <div className="page">
      <h1>六、自身账号数据分析</h1>
      <p className="muted">
        只需粘贴自身账号链接，系统自动识别平台并实时拉取粉丝、简介与视频数据，再由视频解析大模型聚合分析内容特征、输出运营优化建议。
      </p>

      <Card title="输入自身账号">
        <div className="row">
          <input
            placeholder="粘贴自身账号链接，或输入微信视频号 ID（如 sph...）"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            className="primary"
            onClick={run}
            disabled={busy || !canAnalyze}
          >
            {busy ? "拉取中…" : "开始分析"}
          </button>
        </div>
        {!config?.minimaxConfigured ? (
          <p className="muted" style={{ marginTop: 10 }}>
            未配置视频解析大模型（请在 .env 配置模型 API Key 后重启即可启用 AI
            分析）。
          </p>
        ) : url.trim() && !detected ? (
          <p className="muted" style={{ marginTop: 10 }}>
            无法识别该链接所属平台，仅支持 TikTok / Instagram / YouTube / 小红书
            / 微信视频号 的账号主页链接。
          </p>
        ) : detected && !dataReady ? (
          <p className="muted" style={{ marginTop: 10 }}>
            {detected === "facebook"
              ? "暂不支持 Facebook 平台的数据抓取与业务分析。"
              : `未配置 ${platformLabel(detected)} 的数据接口（在 .env 填写 TIKHUB_API_TOKEN）。`}
          </p>
        ) : null}
        {error && (
          <p className="err" style={{ marginTop: 10 }}>
            {error}
          </p>
        )}
        {cacheNote && (
          <p className="muted" style={{ marginTop: 10 }}>
            {cacheNote}
          </p>
        )}
      </Card>

      {account && (
        <div className="stat-row">
          <Card>
            <div className="stat">
              <div className="stat-value">
                {account.followersKnown === false ||
                (account.platform === "wechat_channels" &&
                  account.followers === 0)
                  ? "-"
                  : (account.followers?.toLocaleString() ?? 0)}
              </div>
              <div className="stat-label">{account.name} 粉丝</div>
            </div>
          </Card>
          <Card>
            <div className="stat">
              <div className="stat-value">
                {publishedCount.toLocaleString()}
              </div>
              <div className="stat-label">发布视频数</div>
            </div>
          </Card>
          <Card>
            <div className="stat">
              <div className="stat-value">
                {hasKnownViews ? averageViews.toLocaleString() : "-"}
              </div>
              <div className="stat-label">平均播放</div>
            </div>
          </Card>
        </div>
      )}

      {analysis && (
        <>
          <Card title="流量好的原因分析">
            <StructuredText text={analysis.highTrafficReason} />
          </Card>
          <Card title="流量差的原因分析">
            <StructuredText text={analysis.lowTrafficReason} />
          </Card>
          <Card title="AI 运营优化建议">
            <ul className="kv">
              {(analysis.optimizationSuggest || []).map(
                (s: string, i: number) => (
                  <li key={i}>{s}</li>
                ),
              )}
              {(analysis.optimizationSuggest || []).length === 0 && (
                <li className="muted">—</li>
              )}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
