const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const https = require("https");
const httpClient = require("http");
const crypto = require("crypto");
const cheerio = require("cheerio");

const PORT = Number(process.env.PORT || 5177);
const ROOT = __dirname;
const WORKSPACE_ROOT = path.resolve(ROOT, "..");
const MATERIAL_OUTPUT_DIR = path.join(WORKSPACE_ROOT, "skills", "文章抓取筛选", "output");
const PROJECT_WECHAT_SCRIPT = path.join(ROOT, "scripts", "search_wechat.js");
const LEGACY_WECHAT_SCRIPT = path.join(WORKSPACE_ROOT, "skills", "文章抓取筛选", "scripts", "search_wechat.js");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

loadEnvFile();

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const HAS_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const CLOUD_ID_PREFIX = "cloud:";
const GENERATION_ID_PREFIX = "generation:";
const MD2CARD_API_KEY = process.env.MD2CARD_API_KEY || "";
const MATERIAL_STATUS = {
  TODO: "todo",
  PENDING_PUBLISH: "pending_publish",
  PUBLISHED: "published",
  ARCHIVED: "archived",
  CANDIDATE: "candidate",
  REWRITTEN: "rewritten",
};

function canonicalMaterialStatus(status) {
  const normalized = String(status || "").trim();
  if (!normalized) return MATERIAL_STATUS.TODO;
  if (["todo", "待改写"].includes(normalized)) return MATERIAL_STATUS.TODO;
  if (["pending_publish", "待发布", MATERIAL_STATUS.REWRITTEN].includes(normalized)) return MATERIAL_STATUS.PENDING_PUBLISH;
  if (["published", "已发布"].includes(normalized)) return MATERIAL_STATUS.PUBLISHED;
  if (["archived", "已归档"].includes(normalized)) return MATERIAL_STATUS.ARCHIVED;
  if (["candidate", "候选"].includes(normalized)) return MATERIAL_STATUS.CANDIDATE;
  return MATERIAL_STATUS.TODO;
}

function materialStatusLabel(status) {
  switch (canonicalMaterialStatus(status)) {
    case MATERIAL_STATUS.PENDING_PUBLISH:
      return "待发布";
    case MATERIAL_STATUS.PUBLISHED:
      return "已发布";
    case MATERIAL_STATUS.ARCHIVED:
      return "已归档";
    case MATERIAL_STATUS.CANDIDATE:
      return "候选";
    default:
      return "待改写";
  }
}

function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(text);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function firstMarkdownTitle(markdown, fallback) {
  const line = markdown
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith("# "));
  return line ? line.replace(/^#\s+/, "").trim() : fallback;
}

function extractSectionValue(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (index < 0) return "";

  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("## ")) return "";
    if (line) return line;
  }
  return "";
}

function replaceSectionValue(markdown, heading, value) {
  const lines = String(markdown || "").split(/\r?\n/);
  const sectionHeading = `## ${heading}`;
  const index = lines.findIndex((line) => line.trim() === sectionHeading);
  const normalizedValue = String(value || "").trim();

  if (index < 0) {
    const next = lines.slice();
    if (next.length && next[next.length - 1].trim()) next.push("");
    next.push(sectionHeading, normalizedValue);
    return next.join("\n").trimEnd();
  }

  let valueIndex = -1;
  let insertIndex = lines.length;
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("## ")) {
      insertIndex = i;
      break;
    }
    if (line && valueIndex < 0) valueIndex = i;
  }

  if (valueIndex >= 0) {
    lines[valueIndex] = normalizedValue;
    return lines.join("\n").trimEnd();
  }

  lines.splice(insertIndex, 0, normalizedValue);
  return lines.join("\n").trimEnd();
}

function updateLocalReportStatus(reportMd, status, extra = {}) {
  let next = replaceSectionValue(reportMd, "发布状态", status);
  if (extra.rewrittenAt) {
    next = replaceSectionValue(next, "改写时间", extra.rewrittenAt);
  }
  if (extra.publishedAt) {
    next = replaceSectionValue(next, "发布时间", extra.publishedAt);
  }
  return next;
}

function parseFolderMeta(folderName) {
  const cleanName = folderName.replace(/^❌/, "");
  const [platform = "gzh", rest = cleanName] = cleanName.split("-", 2);

  const value = cleanName.includes("高价值")
    ? "高价值"
    : cleanName.includes("中等价值")
      ? "中等价值"
      : cleanName.includes("低价值")
        ? "低价值"
        : "未标注";
  const heatMatch = cleanName.match(/[SAB]热度/);
  const heat = heatMatch ? heatMatch[0] : "未标注";
  const priority = cleanName.includes("近期热点")
    ? "近期热点"
    : cleanName.includes("过期热点")
      ? "过期热点"
      : cleanName.includes("长尾话题")
        ? "长尾话题"
        : "未标注";
  const linkStatus = cleanName.includes("已替换")
    ? "已替换"
    : cleanName.includes("未替换")
      ? "未替换"
      : "未标注";
  const shortTitle = cleanName.replace(/^.*-\d+-/, "") || rest;

  return { platform, value, heat, priority, linkStatus, shortTitle, legacyPending: folderName.startsWith("❌") };
}

function scanMaterials() {
  if (!fs.existsSync(MATERIAL_OUTPUT_DIR)) return { todo: [], pendingPublish: [], published: [] };

  const folders = fs
    .readdirSync(MATERIAL_OUTPUT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const materials = folders
    .map((folderName) => {
      const reportPath = path.join(MATERIAL_OUTPUT_DIR, folderName, "report.md");
      const markdown = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf-8") : "";
      const meta = parseFolderMeta(folderName);
      const status = canonicalMaterialStatus(
        extractSectionValue(markdown, "发布状态") || (meta.legacyPending ? MATERIAL_STATUS.PENDING_PUBLISH : MATERIAL_STATUS.TODO),
      );
      const title = firstMarkdownTitle(markdown, meta.shortTitle);
      const url = extractSectionValue(markdown, "原文链接");

      return {
        id: encodeURIComponent(folderName),
        folderName,
        title,
        url,
        platform: meta.platform,
        value: meta.value,
        heat: meta.heat,
        priority: meta.priority,
        linkStatus: meta.linkStatus,
        shortTitle: meta.shortTitle,
        status,
      };
    })
    .sort((a, b) => a.folderName.localeCompare(b.folderName, "zh-Hans-CN"));

  return {
    todo: materials.filter((item) => item.status === MATERIAL_STATUS.TODO),
    pendingPublish: materials.filter((item) => item.status === MATERIAL_STATUS.PENDING_PUBLISH),
    published: materials.filter((item) => item.status === MATERIAL_STATUS.PUBLISHED),
  };
}

function normalizeTitleForKey(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "")
    .trim();
}

function hashText(text) {
  return crypto.createHash("sha1").update(String(text || "")).digest("hex").slice(0, 16);
}

function materialSourceKey(material) {
  if (material.sourceKey) return material.sourceKey;
  if (material.folderName) return `local:${material.folderName.replace(/^❌/, "")}`;
  const normalizedTitle = normalizeTitleForKey(material.title);
  if (normalizedTitle) return `${material.platform || "unknown"}:title:${normalizedTitle}`;
  return `${material.platform || "unknown"}:url:${hashText(material.url)}`;
}

function localMaterialToCloudPayload(material) {
  const reportPath = path.join(MATERIAL_OUTPUT_DIR, material.folderName, "report.md");
  const reportMd = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf-8") : "";
  const status = canonicalMaterialStatus(material.status || (material.done ? MATERIAL_STATUS.PENDING_PUBLISH : MATERIAL_STATUS.TODO));
  const cloudStatus = cloudWritableMaterialStatus(status);

  return {
    source_key: materialSourceKey(material),
    title: material.title,
    short_title: material.shortTitle || material.title,
    url: material.url || null,
    platform: material.platform || "gzh",
    value_label: material.value || "未标注",
    heat_label: material.heat || "未标注",
    priority_label: material.priority || "未标注",
    link_status: material.linkStatus || "未标注",
    status: cloudStatus,
    folder_name: material.folderName,
    report_md: reportMd || null,
    raw: {
      importedFrom: "local-output",
      publish_status: status === MATERIAL_STATUS.PUBLISHED ? MATERIAL_STATUS.PUBLISHED : undefined,
    },
    rewritten_at: status === MATERIAL_STATUS.PENDING_PUBLISH || status === MATERIAL_STATUS.PUBLISHED ? new Date().toISOString() : null,
  };
}

function buildFetchedReport(article, evaluation, keyword) {
  const lines = [
    `# ${article.title || "未命名素材"}`,
    "",
    "## 原文链接",
    article.url || "",
    "",
    "## 价值判断结果",
    `- 评估模式：${evaluation.mode}`,
    `- 内容价值：${evaluation.valueLabel}`,
    `- 话题热度：${evaluation.heatLabel}`,
    `- 优先级：${evaluation.priorityLabel}`,
    `- 入库结论：${evaluation.pass ? "通过" : "不入库"}`,
    `- 简要原因：${evaluation.reason || "已完成自动评估"}`,
    "",
    "## 摘要",
    article.summary || "暂无摘要",
    "",
    "## 元数据",
    `- 抓取平台：微信公众号`,
    `- 抓取关键词：${keyword || "未指定"}`,
    `- 发布时间：${article.datetime || article.date_text || article.date_description || "未知"}`,
    `- 公众号账号：${article.source || "未知"}`,
  ];
  return lines.join("\n");
}

function fetchedArticleToMaterial(article, keyword = "", evaluation = null) {
  const title = String(article.title || "未命名素材").trim();
  const summary = String(article.summary || "").trim();
  const url = String(article.url || "").trim();
  const platform = "gzh";
  const linkStatus = /mp\.weixin\.qq\.com\/s\//i.test(url) ? "已替换" : "未替换";
  const result = evaluation || buildPendingEvaluation(article, keyword);

  return {
    source_key: materialSourceKey({ platform, title, url }),
    title,
    short_title: title.slice(0, 18),
    url: url || null,
    platform,
    value_label: result.valueLabel,
    heat_label: result.heatLabel,
    priority_label: result.priorityLabel,
    link_status: linkStatus,
    status: "todo",
    source: article.source || "",
    source_text: [title, summary, url].filter(Boolean).join("\n\n"),
    report_md: buildFetchedReport(article, result, keyword),
    raw: {
      importedFrom: "wechat-search",
      keyword,
      summary,
      datetime: article.datetime || "",
      dateText: article.date_text || "",
      dateDescription: article.date_description || "",
      source: article.source || "",
      evaluation: result,
    },
  };
}

function cloudWritableMaterialStatus(status) {
  const normalized = canonicalMaterialStatus(status);
  if (normalized === MATERIAL_STATUS.PENDING_PUBLISH || normalized === MATERIAL_STATUS.PUBLISHED) {
    return MATERIAL_STATUS.REWRITTEN;
  }
  return normalized;
}

function publicMaterialStatusFromCloudRow(row) {
  const raw = row.raw && typeof row.raw === "object" ? row.raw : {};
  const status = canonicalMaterialStatus(row.status);
  if (status === MATERIAL_STATUS.PENDING_PUBLISH && raw.publish_status === MATERIAL_STATUS.PUBLISHED) {
    return MATERIAL_STATUS.PUBLISHED;
  }
  return status;
}

function mapCloudMaterial(row) {
  const status = publicMaterialStatusFromCloudRow(row);
  return {
    id: `${CLOUD_ID_PREFIX}${row.id}`,
    cloudId: row.id,
    sourceKey: row.source_key,
    folderName: row.folder_name || "",
    title: row.title || "未命名素材",
    url: row.url || "",
    platform: row.platform || "gzh",
    value: row.value_label || "未标注",
    heat: row.heat_label || "未标注",
    priority: row.priority_label || "未标注",
    linkStatus: row.link_status || "未标注",
    shortTitle: row.short_title || row.title || "未命名素材",
    done: status !== MATERIAL_STATUS.TODO,
    status,
    storage: "cloud",
  };
}

function isCloudMaterialId(id) {
  return String(id || "").startsWith(CLOUD_ID_PREFIX);
}

function getCloudId(id) {
  return String(id || "").slice(CLOUD_ID_PREFIX.length);
}

function isGenerationId(id) {
  return String(id || "").startsWith(GENERATION_ID_PREFIX);
}

function getGenerationId(id) {
  return String(id || "").slice(GENERATION_ID_PREFIX.length);
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function supabaseRequest(pathname, options = {}) {
  if (!HAS_SUPABASE) {
    throw new Error("Supabase is not configured");
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1${pathname}`, {
    ...options,
    headers: supabaseHeaders(options.headers || {}),
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message = data?.message || data?.hint || data?.details || text || `Supabase request failed: ${response.status}`;
    throw new Error(message);
  }

  return data;
}

async function upsertCloudMaterials(payloads) {
  if (!payloads.length) return [];

  return supabaseRequest("/materials?on_conflict=source_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(payloads),
  });
}

async function insertCloudMaterialsIfMissing(payloads) {
  if (!payloads.length) return [];

  return supabaseRequest("/materials?on_conflict=source_key", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify(payloads),
  });
}

async function syncLocalMaterialsToCloud() {
  if (!HAS_SUPABASE) return;

  const local = scanMaterials();
  const payloads = [...local.todo, ...local.pendingPublish, ...local.published].map(localMaterialToCloudPayload);
  if (payloads.length) await insertCloudMaterialsIfMissing(payloads);
}

async function listCloudMaterials({ syncLocal = false } = {}) {
  if (syncLocal) await syncLocalMaterialsToCloud();

  const rows = await supabaseRequest("/materials?select=*&order=created_at.desc", {
    method: "GET",
  });
  const materials = rows.map(mapCloudMaterial);
  return {
    todo: materials.filter((item) => item.status === MATERIAL_STATUS.TODO),
    pendingPublish: materials.filter((item) => item.status === MATERIAL_STATUS.PENDING_PUBLISH),
    published: materials.filter((item) => item.status === MATERIAL_STATUS.PUBLISHED),
  };
}

async function getCloudMaterialsOrLocal() {
  if (!HAS_SUPABASE) {
    return { ...scanMaterials(), storage: "local", cloud: { enabled: false, ok: false } };
  }

  try {
    const cloudMaterials = await listCloudMaterials({ syncLocal: false });
    const instantHistory = await listInstantGenerationHistory();
    cloudMaterials.published = [...instantHistory, ...cloudMaterials.published];
    return { ...cloudMaterials, storage: "cloud", cloud: { enabled: true, ok: true } };
  } catch (error) {
    return {
      ...scanMaterials(),
      storage: "local",
      cloud: {
        enabled: true,
        ok: false,
        error: error.message,
      },
    };
  }
}

async function getCloudMaterialRow(id) {
  const cloudId = getCloudId(id);
  const rows = await supabaseRequest(`/materials?select=*&id=eq.${encodeURIComponent(cloudId)}&limit=1`, {
    method: "GET",
  });
  if (!rows.length) throw new Error("Cloud material not found");
  return rows[0];
}

async function getCloudMaterialText(id) {
  const row = await getCloudMaterialRow(id);
  return (
    row.report_md ||
    row.source_text ||
    [row.title, row.raw?.summary, row.url].filter(Boolean).join("\n\n")
  );
}

async function updateCloudMaterialLink(id, newUrl) {
  if (!/^https?:\/\//i.test(newUrl)) {
    throw new Error("URL must start with http:// or https://");
  }

  const row = await getCloudMaterialRow(id);
  const linkStatus = /mp\.weixin\.qq\.com\/s\//i.test(newUrl) ? "已替换" : row.link_status || "未替换";
  const patch = { url: newUrl, link_status: linkStatus };

  if (row.report_md) {
    patch.report_md = replaceReportLink(row.report_md, newUrl);
  }

  const updated = await supabaseRequest(`/materials?id=eq.${encodeURIComponent(row.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });

  return mapCloudMaterial(updated[0]);
}

async function updateCloudMaterialStatus(id, status, extra = {}) {
  const cloudId = getCloudId(id);
  const publicStatus = canonicalMaterialStatus(status);
  const row = await getCloudMaterialRow(id);
  const raw = row.raw && typeof row.raw === "object" ? row.raw : {};
  const nextRaw = { ...raw };
  if (publicStatus === MATERIAL_STATUS.PUBLISHED) {
    nextRaw.publish_status = MATERIAL_STATUS.PUBLISHED;
    nextRaw.published_at = extra.published_at || new Date().toISOString();
  } else {
    delete nextRaw.publish_status;
    delete nextRaw.published_at;
  }

  const updated = await supabaseRequest(`/materials?id=eq.${encodeURIComponent(cloudId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      status: cloudWritableMaterialStatus(publicStatus),
      rewritten_at: extra.rewritten_at || row.rewritten_at || null,
      raw: nextRaw,
      report_md: extra.report_md || undefined,
    }),
  });
  if (!updated.length) throw new Error("Cloud material not found");
  return mapCloudMaterial(updated[0]);
}

async function markCloudMaterialAsPendingPublish(id) {
  return updateCloudMaterialStatus(id, MATERIAL_STATUS.PENDING_PUBLISH, {
    rewritten_at: new Date().toISOString(),
  });
}

async function markCloudMaterialAsPublished(id) {
  return updateCloudMaterialStatus(id, MATERIAL_STATUS.PUBLISHED, {
    published_at: new Date().toISOString(),
  });
}

function updateLocalMaterialReportStatus(id, status, extra = {}) {
  const { folderName, folderPath } = getMaterialFolderPath(id);
  const reportPath = path.join(folderPath, "report.md");
  if (!fs.existsSync(reportPath)) {
    throw new Error("report.md not found");
  }

  const reportMd = fs.readFileSync(reportPath, "utf-8");
  const nextReport = updateLocalReportStatus(reportMd, materialStatusLabel(status), {
    rewrittenAt: extra.rewritten_at || extra.rewrittenAt,
    publishedAt: extra.published_at || extra.publishedAt,
  });
  fs.writeFileSync(reportPath, `${nextReport.trimEnd()}\n`, "utf-8");
  return {
    id: encodeURIComponent(folderName),
    folderName,
    status: canonicalMaterialStatus(status),
  };
}

function markLocalMaterialAsPendingPublish(id) {
  return updateLocalMaterialReportStatus(id, MATERIAL_STATUS.PENDING_PUBLISH, {
    rewritten_at: new Date().toISOString(),
  });
}

function markLocalMaterialAsPublished(id) {
  return updateLocalMaterialReportStatus(id, MATERIAL_STATUS.PUBLISHED, {
    published_at: new Date().toISOString(),
  });
}

async function createCloudGeneration(payload) {
  if (!HAS_SUPABASE) return null;

  const materialId = isCloudMaterialId(payload.materialId) ? getCloudId(payload.materialId) : null;
  const rows = await supabaseRequest("/generations", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      material_id: materialId,
      source_type: payload.sourceType || "",
      source_value: payload.sourceValue || "",
      title: payload.title || "",
      summary: payload.summary || "",
      tags: payload.tags || [],
      cards: payload.cards || [],
      markdown: payload.markdown || "",
      provider: payload.provider || "",
      settings: payload.settings || {},
    }),
  });
  return rows[0] || null;
}

async function getLatestCloudGenerationForMaterial(id) {
  if (!HAS_SUPABASE) {
    throw new Error("Supabase is not configured");
  }
  if (!isCloudMaterialId(id)) {
    throw new Error("Only cloud materials have saved generation history");
  }

  const cloudId = getCloudId(id);
  const rows = await supabaseRequest(
    `/generations?select=*&material_id=eq.${encodeURIComponent(cloudId)}&order=created_at.desc&limit=1`,
    { method: "GET" },
  );
  if (!rows.length) {
    const error = new Error("No generation found for this material");
    error.statusCode = 404;
    throw error;
  }
  return rows[0];
}

async function getCloudGenerationById(id) {
  if (!HAS_SUPABASE) {
    throw new Error("Supabase is not configured");
  }
  if (!isGenerationId(id)) {
    throw new Error("Invalid generation id");
  }

  const generationId = getGenerationId(id);
  const rows = await supabaseRequest(`/generations?select=*&id=eq.${encodeURIComponent(generationId)}&limit=1`, {
    method: "GET",
  });
  if (!rows.length) {
    const error = new Error("Generation not found");
    error.statusCode = 404;
    throw error;
  }
  return rows[0];
}

async function listInstantGenerationHistory() {
  if (!HAS_SUPABASE) return [];

  const rows = await supabaseRequest(
    "/generations?select=*&material_id=is.null&order=created_at.desc&limit=50",
    { method: "GET" },
  );
  return rows.map(mapGenerationHistoryItem);
}

function mapGenerationHistoryItem(row) {
  const sourceType = row.source_type || "即时输入";
  const sourceValue = row.source_value || "";
  const title = row.title || inferTitleFromText(sourceValue) || "即时生成记录";
  const createdAt = row.created_at ? new Date(row.created_at) : null;
  const dateLabel = createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toLocaleDateString("zh-CN") : "历史记录";

  return {
    id: `${GENERATION_ID_PREFIX}${row.id}`,
    generationId: row.id,
    title,
    shortTitle: title.slice(0, 18),
    url: looksLikeUrl(sourceValue) ? sourceValue : "",
    platform: sourceType,
    value: "即时生成",
    heat: "已生成",
    priority: dateLabel,
    linkStatus: "可回看",
    done: true,
    status: MATERIAL_STATUS.PUBLISHED,
    storage: "cloud",
    sourceType,
  };
}

function getMaterialFolderPath(id) {
  const folderName = decodeURIComponent(String(id || ""));
  if (!folderName || folderName.includes("/") || folderName.includes("\\") || folderName.includes("..")) {
    throw new Error("Invalid material id");
  }

  const folderPath = path.resolve(MATERIAL_OUTPUT_DIR, folderName);
  const rootWithSep = `${path.resolve(MATERIAL_OUTPUT_DIR)}${path.sep}`;
  if (!folderPath.startsWith(rootWithSep)) {
    throw new Error("Material path is outside output directory");
  }
  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    throw new Error("Material folder not found");
  }

  return { folderName, folderPath };
}

function replaceReportLink(markdown, newUrl) {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === "## 原文链接");
  if (headingIndex < 0) {
    return `${markdown.trim()}\n\n## 原文链接\n${newUrl}\n`;
  }

  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("## ")) {
      lines.splice(i, 0, newUrl);
      return lines.join("\n");
    }
    if (line) {
      lines[i] = newUrl;
      return lines.join("\n");
    }
  }

  lines.push(newUrl);
  return lines.join("\n");
}

function updateMaterialLink(id, newUrl) {
  if (!/^https?:\/\//i.test(newUrl)) {
    throw new Error("URL must start with http:// or https://");
  }

  const { folderName, folderPath } = getMaterialFolderPath(id);
  const reportPath = path.join(folderPath, "report.md");
  if (!fs.existsSync(reportPath)) {
    throw new Error("report.md not found");
  }

  const report = fs.readFileSync(reportPath, "utf-8");
  fs.writeFileSync(reportPath, replaceReportLink(report, newUrl), "utf-8");

  let nextFolderName = folderName;
  if (folderName.includes("未替换") && /mp\.weixin\.qq\.com\/s\//i.test(newUrl)) {
    nextFolderName = folderName.replace("未替换", "已替换");
    const nextFolderPath = path.resolve(MATERIAL_OUTPUT_DIR, nextFolderName);
    const rootWithSep = `${path.resolve(MATERIAL_OUTPUT_DIR)}${path.sep}`;
    if (!nextFolderPath.startsWith(rootWithSep)) {
      throw new Error("Target path is outside output directory");
    }
    if (!fs.existsSync(nextFolderPath)) {
      fs.renameSync(folderPath, nextFolderPath);
    }
  }

  return { id: encodeURIComponent(nextFolderName), folderName: nextFolderName, url: newUrl };
}

function resolveRedirectOnce(targetUrl) {
  return new Promise((resolve, reject) => {
    const client = targetUrl.startsWith("https:") ? https : httpClient;
    const req = client.request(
      targetUrl,
      {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
        },
      },
      (resp) => {
        const location = resp.headers.location;
        resp.resume();
        if (location && resp.statusCode >= 300 && resp.statusCode < 400) {
          resolve(new URL(location, targetUrl).toString());
          return;
        }
        resolve(targetUrl);
      },
    );
    req.setTimeout(12000, () => {
      req.destroy();
      reject(new Error("Resolve timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

async function resolvePermanentUrl(startUrl) {
  let current = startUrl;
  for (let i = 0; i < 6; i++) {
    const next = await resolveRedirectOnce(current);
    if (next === current) return current;
    current = next;
    if (/mp\.weixin\.qq\.com\/s\//i.test(current)) return current;
  }
  return current;
}

function runWechatSearch({ keyword, count }) {
  const scriptPath = fs.existsSync(PROJECT_WECHAT_SCRIPT)
    ? PROJECT_WECHAT_SCRIPT
    : fs.existsSync(LEGACY_WECHAT_SCRIPT)
      ? LEGACY_WECHAT_SCRIPT
      : "";
  if (!scriptPath) {
    return Promise.reject(new Error("search_wechat.js not found"));
  }

  try {
    const { searchWechatArticles } = require(scriptPath);
    return searchWechatArticles(keyword, count || 5).then((articles) => ({
      query: keyword,
      total: articles.length,
      articles,
    }));
  } catch (error) {
    return Promise.reject(error);
  }
}

function getMaterialReport(id) {
  if (isCloudMaterialId(id)) {
    throw new Error("Cloud material requires async loading");
  }

  const { folderPath } = getMaterialFolderPath(id);
  const reportPath = path.join(folderPath, "report.md");
  if (!fs.existsSync(reportPath)) {
    throw new Error("report.md not found");
  }
  return fs.readFileSync(reportPath, "utf-8");
}

async function getMaterialSourceText(id) {
  if (isCloudMaterialId(id)) {
    return getCloudMaterialText(id);
  }
  return getMaterialReport(id);
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("AI response did not contain JSON");
  }
  return JSON.parse(raw.slice(start, end + 1));
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function getArticleText(article) {
  return [article.title, article.summary, article.source_text, article.url].filter(Boolean).join("\n");
}

function includesAny(text, words) {
  return words.some((word) => word && text.includes(word));
}

function splitKeywordTerms(keyword) {
  const raw = String(keyword || "").trim();
  if (!raw) return [];
  const terms = raw
    .split(/[\s,，、/+|]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set([raw, ...terms]));
}

function parseArticleAgeDays(article) {
  const datetime = article.datetime || article.date_text || "";
  if (datetime) {
    const normalized = String(datetime).replace(/\./g, "-").replace(/年|月/g, "-").replace(/日/g, "");
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) {
      return Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 86400000));
    }
  }

  const desc = String(article.date_description || "");
  const number = Number((desc.match(/\d+/) || [])[0]);
  if (!Number.isFinite(number)) return null;
  if (desc.includes("分钟前") || desc.includes("小时前") || desc.includes("刚刚")) return 0;
  if (desc.includes("天前")) return number;
  if (desc.includes("月前")) return number * 30;
  if (desc.includes("年前")) return number * 365;
  return null;
}

function isEventDrivenArticle(article) {
  const text = getArticleText(article);
  return includesAny(text, [
    "发布",
    "上线",
    "下架",
    "融资",
    "倒闭",
    "政策",
    "禁令",
    "封号",
    "新功能",
    "首发",
    "突破",
    "爆雷",
    "宣布",
    "最新",
    "今日",
    "官宣",
    "裁员",
    "精简",
    "大会",
  ]);
}

function inferPriorityLabel(article) {
  const eventDriven = isEventDrivenArticle(article);
  const ageDays = parseArticleAgeDays(article);
  if (!eventDriven) return "长尾话题";
  if (ageDays === null || ageDays <= 90) return "近期热点";
  if (ageDays <= 180) return "过期热点";
  return "过期热点";
}

function heatLabelFromSignals(article, targetDomain) {
  const text = getArticleText(article);
  const ageDays = parseArticleAgeDays(article);
  const strongHot = includesAny(text, ["爆", "大涨", "裁员", "风口", "红利", "新规", "最新", "首发", "官宣", "趋势", "变革"]);
  const practical = includesAny(text, ["指南", "实战", "教程", "方法", "SOP", "清单", "案例", "拆解", "复盘", "步骤"]);
  const domainHit = splitKeywordTerms(targetDomain).some((term) => text.includes(term));

  if ((strongHot && (ageDays === null || ageDays <= 30)) || (domainHit && strongHot)) return "S热度";
  if (domainHit || practical || (ageDays !== null && ageDays <= 90)) return "A热度";
  return "B热度";
}

function valueLabelFromScore(total) {
  if (total >= 80) return "高价值";
  if (total >= 60) return "中等价值";
  if (total >= 40) return "低价值";
  return "不推荐";
}

function shouldStoreEvaluation(valueLabel, heatLabel) {
  if (valueLabel === "高价值") return ["S热度", "A热度", "B热度"].includes(heatLabel);
  if (valueLabel === "中等价值") return ["S热度", "A热度"].includes(heatLabel);
  return false;
}

function buildLocalValueEvaluation(article, { keyword = "", domain = "", provider = "local-rules" } = {}) {
  const targetDomain = String(domain || keyword || "").trim();
  const text = getArticleText(article);
  const terms = splitKeywordTerms(targetDomain);
  const mode = targetDomain ? `指定领域(${targetDomain})` : "通用模式";
  const domainHit = !targetDomain || terms.some((term) => text.includes(term));
  const partialHit = !targetDomain || terms.some((term) => term.length >= 2 && text.includes(term.slice(0, 2)));
  const practicalWords = ["指南", "实战", "教程", "方法", "步骤", "SOP", "清单", "案例", "拆解", "复盘", "经验", "工具", "模板"];
  const valueWords = ["提升", "降低", "增长", "效率", "成本", "转化", "避坑", "解决", "判断", "选择", "规划", "执行"];
  const hasNumbers = /\d+/.test(text);
  const practicalHits = practicalWords.filter((word) => text.includes(word)).length;
  const valueHits = valueWords.filter((word) => text.includes(word)).length;

  const focusScore = targetDomain
    ? domainHit
      ? 28
      : partialHit
        ? 18
        : 6
    : clampNumber(16 + practicalHits * 2 + (String(article.summary || "").length > 60 ? 4 : 0), 0, 30);
  const userValueScore = clampNumber(16 + practicalHits * 4 + valueHits * 3 + (hasNumbers ? 5 : 0), 0, 40);
  const transformScore = clampNumber(12 + practicalHits * 3 + (hasNumbers ? 4 : 0) + (String(article.summary || "").length > 80 ? 5 : 0), 0, 30);
  const total = focusScore + userValueScore + transformScore;
  const valueLabel = valueLabelFromScore(total);
  const heatLabel = heatLabelFromSignals(article, targetDomain);
  const priorityLabel = inferPriorityLabel(article);
  const ageDays = parseArticleAgeDays(article);
  const tooOld = isEventDrivenArticle(article) ? ageDays !== null && ageDays > 180 : ageDays !== null && ageDays > 730;
  const hardMismatch = Boolean(targetDomain && focusScore < 10);
  const pass = !tooOld && !hardMismatch && shouldStoreEvaluation(valueLabel, heatLabel);
  const reason = pass
    ? "素材与目标方向匹配，具备可改写价值，已进入素材库。"
    : hardMismatch
      ? "素材与本次关键词方向弱相关，暂不写入素材库。"
      : tooOld
        ? "素材时效性不足，暂不写入素材库。"
        : "素材价值或热度组合不足，暂不写入素材库。";

  return {
    mode,
    pass,
    valueLabel,
    heatLabel,
    priorityLabel,
    scores: {
      focus: focusScore,
      userValue: userValueScore,
      transformability: transformScore,
      total,
    },
    reason,
    recommendedAction: pass ? "可进入待改写素材库" : "建议跳过或更换关键词继续抓取",
    provider,
  };
}

function buildPendingEvaluation(article, keyword = "") {
  return buildLocalValueEvaluation(article, { keyword });
}

function normalizeEvaluation(data, article, { keyword = "", domain = "", provider = "ai" } = {}) {
  const fallback = buildLocalValueEvaluation(article, { keyword, domain, provider });
  const valueLabel = ["高价值", "中等价值", "低价值", "不推荐"].includes(data.valueLabel)
    ? data.valueLabel
    : fallback.valueLabel;
  const heatLabel = ["S热度", "A热度", "B热度"].includes(data.heatLabel) ? data.heatLabel : fallback.heatLabel;
  const priorityLabel = ["近期热点", "过期热点", "长尾话题"].includes(data.priorityLabel)
    ? data.priorityLabel
    : fallback.priorityLabel;
  const scores = {
    focus: clampNumber(data.scores?.focus ?? data.scores?.a ?? fallback.scores.focus, 0, 30),
    userValue: clampNumber(data.scores?.userValue ?? data.scores?.b ?? fallback.scores.userValue, 0, 40),
    transformability: clampNumber(
      data.scores?.transformability ?? data.scores?.c ?? fallback.scores.transformability,
      0,
      30,
    ),
  };
  scores.total = clampNumber(data.scores?.total ?? scores.focus + scores.userValue + scores.transformability, 0, 100);
  const pass = typeof data.pass === "boolean" ? data.pass : shouldStoreEvaluation(valueLabel, heatLabel);

  return {
    mode: String(data.mode || fallback.mode),
    pass,
    valueLabel,
    heatLabel,
    priorityLabel,
    scores,
    reason: String(data.reason || fallback.reason).slice(0, 120),
    recommendedAction: String(data.recommendedAction || fallback.recommendedAction).slice(0, 120),
    provider,
  };
}

function buildValueEvaluationPrompt({ article, keyword = "", domain = "", sourceType = "fetch" }) {
  const targetDomain = String(domain || keyword || "").trim();
  const modeText = targetDomain ? `指定领域模式，目标领域为「${targetDomain}」` : "通用模式，不设置领域硬筛";
  const articleText = getArticleText(article).slice(0, 6000);

  return `
你是长文内容价值评估师。请按通用版文章二创价值判断流程评估素材是否值得进入小红书图文生产。

评估模式：${modeText}
来源：${sourceType}

只输出合法 JSON，不要输出解释。不要展开你的详细判断链路，只给短原因。

JSON 结构：
{
  "mode": "指定领域(领域名) 或 通用模式",
  "pass": true,
  "valueLabel": "高价值|中等价值|低价值|不推荐",
  "heatLabel": "S热度|A热度|B热度",
  "priorityLabel": "近期热点|过期热点|长尾话题",
  "scores": {"focus": 0, "userValue": 0, "transformability": 0, "total": 0},
  "reason": "不超过40字，说明是否入库",
  "recommendedAction": "不超过40字"
}

入库口径：高价值+S/A/B热度可入库；中等价值+S/A热度可入库；其他默认不入库。

素材：
${articleText}
`.trim();
}

async function evaluateArticleValue(article, options = {}) {
  const hasAiKey = Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);
  if (!hasAiKey) return buildLocalValueEvaluation(article, options);

  try {
    const prompt = buildValueEvaluationPrompt({ article, ...options });
    if (process.env.OPENAI_API_KEY) {
      return normalizeEvaluation(extractJson(await callOpenAI(prompt)), article, { ...options, provider: "openai" });
    }
    return normalizeEvaluation(extractJson(await callAnthropic(prompt)), article, { ...options, provider: "anthropic" });
  } catch (error) {
    const fallback = buildLocalValueEvaluation(article, options);
    return {
      ...fallback,
      provider: "local-rules",
      reason: `${fallback.reason}（AI评估失败，已用本地预评估）`.slice(0, 120),
      aiError: error.message,
    };
  }
}

async function evaluateArticles(articles, options = {}) {
  const results = [];
  for (const article of articles) {
    const evaluation = await evaluateArticleValue(article, options);
    results.push({ article, evaluation });
  }
  return results;
}

function mapMaterialPayload(payload) {
  return {
    id: `session:${hashText(payload.source_key)}`,
    sourceKey: payload.source_key,
    folderName: payload.folder_name || "",
    title: payload.title || "未命名素材",
    url: payload.url || "",
    platform: payload.platform || "gzh",
    value: payload.value_label || "未标注",
    heat: payload.heat_label || "未标注",
    priority: payload.priority_label || "未标注",
    linkStatus: payload.link_status || "未标注",
    shortTitle: payload.short_title || payload.title || "未命名素材",
    done: payload.status === "rewritten",
    status: payload.status || "todo",
    storage: "session",
  };
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function stripHtmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchUrlAsArticle(targetUrl) {
  const response = await fetch(targetUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
    },
  });
  if (!response.ok) throw new Error(`URL fetch failed: ${response.status}`);
  const html = await response.text();
  const $ = cheerio.load(html);
  const title =
    $('meta[property="og:title"]').attr("content") ||
    $('meta[name="twitter:title"]').attr("content") ||
    $("title").first().text() ||
    "";
  return {
    title: String(title || "").trim(),
    text: stripHtmlToText(html).slice(0, 12000),
    url: response.url || targetUrl,
  };
}

function inferTitleFromText(text) {
  const firstLine = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^#+\s*/, ""))
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 80) : "即时输入素材";
}

function normalizePageCountSetting(pageCount) {
  const value = String(pageCount || "").trim();
  if (value === "3 页") return { label: "3 页", instruction: "cards 必须生成 3 页，不要多页也不要少页。" };
  if (value === "5 页") return { label: "5 页", instruction: "cards 必须生成 5 页，不要多页也不要少页。" };
  if (value === "7 页") return { label: "7 页", instruction: "cards 必须生成 7 页，不要多页也不要少页。" };
  return {
    label: "自动（3-5 页）",
    instruction: "cards 请根据素材信息密度自动生成 3 到 5 页，不能少于 3 页，不能多于 5 页。",
  };
}

function buildGenerationPrompt(payload) {
  const pageCountSetting = normalizePageCountSetting(payload.pageCount);
  const domain = payload.domain || "未指定，由素材自动判断";
  const audience = payload.audience || "未指定，由素材自动判断";

  return `
你是一个专业的小红书内容运营专家。请基于用户提供的素材，先在内部完成「长文分析 → 小红书风格改写 → 动态切分 → 合规自查」，再输出适合直接生成图文卡片的发布资产。

基础信息：
- 内容领域：${domain}
- 目标受众：${audience}
- 目标平台：小红书
- 页数设置：${pageCountSetting.label}

内部执行流程：
1. 原文分析
- 识别核心主题、主要观点、最有价值的 3-5 个信息点。
- 判断内容类型，可复合命中教程、方法论、行动清单、分析、案例或观点。
- 若用户未指定内容领域或目标受众，请根据素材自动判断；若已指定，则标题、正文语气和案例选择要贴近该方向。

2. 小红书风格改写
- 先将原始素材改写成一篇小红书笔记正文，再从改写后的正文切分卡片，不要直接把原文机械切段。
- 推荐结构为「痛点/反差 - 原因 - 方法 - 案例/场景 - 总结」，但要根据素材自然调整。
- 语言口语化、对话式，多用“你”，适度使用疑问句和短句。
- 教程/步骤/行动清单类：直接给方法，少铺垫。
- 案例/结果类：可以用第一人称表达“我测了/我用过/我观察到”，增强真实感。
- 观点/判断类：可以用“我觉得/我发现”，但要给出原因和可执行建议。
- 避免第三人称故事腔，不要用“他/她/他们/别人/有个人/某家公司”编造叙事。
- 保留原文核心干货和关键事实，但表达方式要明显不同，不直接复制原文段落。

3. 标题规则
- 只输出 1 个最终推荐标题，不要输出 3 个备选标题，不要输出标题分析过程。
- title 严格控制在 20 个中文字符以内，像真人随口说出的短句，避免商务汇报风和一眼 AI 感。
- 标题必须包含具体锚点：数字、工具/方法名、反常识结论、强情绪词或具体场景，不能用“某方法”“这个技巧”等模糊表达代替。
- 可使用情绪宣泄、反常识质疑、利益直给等表达方式，但不能夸大承诺。
- 禁止使用“赋能、助力、策略、矩阵、协同、闭环、全方位、一站式、提升、优化”等商务空话。

4. 正文概述规则
- summary 是小红书发布时标题下方的正文概述，不是完整正文。
- 控制在 50-80 字，说明这篇笔记讲什么、对读者有什么用。
- 可以包含关键数字、工具名、方法名或核心卖点；可以使用 1-2 个 emoji；不要与标题完全重复。

5. 卡片切分规则
- ${pageCountSetting.instruction}
- 第 1 页 label 使用“封面”：负责吸引点击，title 要抓住最痛痛点或最大利益点，body 用一句副标题补充场景。
- 第 2 页 label 使用“认知对齐”：交代背景、痛点或核心判断，让读者知道为什么要继续看。
- 第 3 页至倒数第 2 页：作为核心干货页，每页承载 1-2 个论点、步骤或方法，使用小标题 + 结构化正文。
- 最后 1 页 label 使用“总结”：收束全文，给出行动提醒、方法复盘或判断边界。
- label 只是系统内部元数据，严禁把“封面 / 认知对齐 / 核心干货 / 总结”等 label 文字写入 title 或 body。
- 每页 body 尽量使用短段落、列表、加粗重点或 emoji 增加阅读节奏。
- 内容完整优先，不要遗漏原文中的关键论点、数据、步骤和方法。
- 严禁出现“点赞/收藏/关注/评论区见”等互动引导语。

6. 标签规则
- tags 输出 5-8 个。
- 包含 1-2 个泛领域标签、2-3 个精准垂直标签、1-2 个长尾搜索标签，以及可选的账号/系列定位标签。

7. 合规预检
- 生成前先规避：低门槛高收入诱导、夸大金额收益、第三方背书、平台背书、纯焦虑无解决方案、绝对化表达。
- 标题、summary 和每页 cards 文案都要避开违禁词或高风险表达；如原文含高风险收益案例，改成更稳妥的场景表达，并提示其不具备普遍复制性。
- complianceSummary 只需概述“已规避哪些类型风险”，不要暴露具体内部判断细节。

输出要求：
- 输出必须是合法 JSON，不要输出 Markdown 代码块之外的解释。
- 不要输出 titleOptions、备选标题、改写过程、切分预览或任何额外说明。

JSON 结构：
{
  "title": "推荐标题",
  "summary": "50-80字正文概述",
  "tags": ["标签1", "标签2", "标签3", "标签4", "标签5"],
  "complianceSummary": "合规预检摘要",
  "cards": [
    {"page": 1, "label": "封面", "title": "卡片标题", "body": "卡片正文"},
    {"page": 2, "label": "认知对齐", "title": "卡片标题", "body": "卡片正文"}
  ]
}

素材：
${payload.sourceText}
`.trim();
}

async function callOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const endpoint = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "你只输出合法 JSON。" },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `OpenAI request failed: ${response.status}`);
  }
  return data.choices?.[0]?.message?.content || "";
}

async function callAnthropic(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is missing");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2500,
      temperature: 0.7,
      system: "你只输出合法 JSON。",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `Anthropic request failed: ${response.status}`);
  }
  return data.content?.map((item) => item.text || "").join("") || "";
}

async function generateWithAI(payload) {
  const prompt = buildGenerationPrompt(payload);
  if (process.env.OPENAI_API_KEY) {
    return { provider: "openai", data: extractJson(await callOpenAI(prompt)) };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", data: extractJson(await callAnthropic(prompt)) };
  }
  throw new Error("No AI API key configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.");
}

const MD2CARD_THEME_MAP = {
  apple: "apple-notes",
  instagram: "xiaohongshu",
  "minimal-gray": "minimal",
  minimalist: "minimalist",
  business: "business",
  darktech: "darktech",
};

function buildCardMarkdown(card) {
  return [`# ${card.title || `第 ${card.page || 1} 页`}`, card.body || ""].filter(Boolean).join("\n\n");
}

function normalizeMd2CardImages(data) {
  const candidates = [
    data.images,
    data.imageUrls,
    data.image_urls,
    data.urls,
    data.data?.images,
    data.data?.imageUrls,
    data.data?.image_urls,
    data.data?.urls,
    data.result?.images,
    data.result?.imageUrls,
    data.result?.image_urls,
    data.result?.urls,
    data.imageUrl,
    data.image_url,
    data.url,
    data.data?.imageUrl,
    data.data?.image_url,
    data.data?.url,
  ].filter(Boolean);

  const flattened = candidates.flatMap((item) => (Array.isArray(item) ? item : [item]));
  return flattened
    .map((item, index) => {
      if (typeof item === "string") {
        return { url: item, fileName: `第${index + 1}张图片` };
      }
      const url = item.url || item.imageUrl || item.image_url || item.src || item.downloadUrl || item.download_url || "";
      return {
        url,
        fileName: item.fileName || item.filename || item.name || `第${index + 1}张图片`,
      };
    })
    .filter((item) => /^https?:\/\//i.test(item.url));
}

function getMd2CardPreviewUrl(data) {
  return (
    data.previewUrl ||
    data.preview_url ||
    data.editorUrl ||
    data.editor_url ||
    data.url ||
    data.data?.previewUrl ||
    data.data?.preview_url ||
    data.data?.editorUrl ||
    data.data?.editor_url ||
    data.result?.previewUrl ||
    data.result?.preview_url ||
    ""
  );
}

async function callMd2CardApi({ markdown, theme }) {
  if (!MD2CARD_API_KEY) {
    throw new Error("MD2CARD_API_KEY is missing");
  }

  const body = {
    markdown,
    theme,
    width: 440,
    height: 586,
    splitMode: "autoSplit",
    mdxMode: false,
    overHiddenMode: false,
  };

  const response = await fetch("https://md2card.cn/api/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": MD2CARD_API_KEY,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || `md2card request failed: ${response.status}`);
  }
  if (!data.success) {
    throw new Error(data.message || "md2card generation failed");
  }
  return { ...data, request: body };
}

async function renderCardsWithMd2Card(payload) {
  const cards = Array.isArray(payload.cards) ? payload.cards : [];
  if (!cards.length) throw new Error("cards is required");

  const rendered = [];
  for (const card of cards) {
    const themeId = card.themeId || card.theme?.id || (card.page === 1 ? payload.coverTheme : payload.innerTheme);
    const theme = MD2CARD_THEME_MAP[themeId] || themeId || "apple-notes";
    const markdown = buildCardMarkdown(card);
    const data = await callMd2CardApi({ markdown, theme });
    rendered.push({
      page: card.page,
      label: card.label || "",
      title: card.title || "",
      theme,
      previewUrl: getMd2CardPreviewUrl(data),
      images: normalizeMd2CardImages(data),
      cost: data.cost || 0,
      request: data.request || null,
    });
  }

  return {
    ok: true,
    provider: "md2card",
    cards: rendered,
    totalCost: rendered.reduce((sum, item) => sum + Number(item.cost || 0), 0),
  };
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/materials") {
    sendJson(res, 200, await getCloudMaterialsOrLocal());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/cloud/status") {
    if (!HAS_SUPABASE) {
      sendJson(res, 200, { configured: false, ok: false });
      return true;
    }

    try {
      await supabaseRequest("/materials?select=id&limit=1", { method: "GET" });
      sendJson(res, 200, { configured: true, ok: true });
    } catch (error) {
      sendJson(res, 200, { configured: true, ok: false, error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/fetch/wechat") {
    try {
      const body = await readRequestBody(req);
      const keyword = String(body.keyword || "").trim();
      const count = Math.min(Number(body.count || 5), 10);
      if (!keyword) {
        sendJson(res, 400, { error: "keyword is required" });
        return true;
      }

      const result = await runWechatSearch({ keyword, count });
      const evaluated = await evaluateArticles(result.articles || [], {
        keyword,
        sourceType: "wechat-fetch",
      });
      const accepted = evaluated.filter((item) => item.evaluation.pass);
      const rejected = evaluated.filter((item) => !item.evaluation.pass);
      const payloads = accepted.map(({ article, evaluation }) => fetchedArticleToMaterial(article, keyword, evaluation));
      let inserted = [];
      let duplicateCount = 0;
      let cloud = { enabled: HAS_SUPABASE, ok: false };
      if (HAS_SUPABASE) {
        try {
          inserted = (await insertCloudMaterialsIfMissing(payloads)).map(mapCloudMaterial);
          duplicateCount = Math.max(0, payloads.length - inserted.length);
          cloud = { enabled: true, ok: true };
        } catch (error) {
          cloud = { enabled: true, ok: false, error: error.message };
        }
      } else {
        inserted = payloads.map(mapMaterialPayload);
      }

      sendJson(res, 200, {
        ...result,
        materials: inserted,
        summary: {
          fetched: result.articles?.length || 0,
          evaluated: evaluated.length,
          passed: accepted.length,
          inserted: inserted.length,
          duplicates: duplicateCount,
          rejected: rejected.length,
          provider: evaluated.find((item) => item.evaluation.provider)?.evaluation.provider || "none",
        },
        evaluations: evaluated.map(({ article, evaluation }) => ({
          title: article.title,
          pass: evaluation.pass,
          valueLabel: evaluation.valueLabel,
          heatLabel: evaluation.heatLabel,
          priorityLabel: evaluation.priorityLabel,
          reason: evaluation.reason,
          provider: evaluation.provider,
        })),
        cloud,
      });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/materials/replace-link") {
    try {
      const body = await readRequestBody(req);
      const id = String(body.id || "");
      const newUrl = String(body.url || "").trim();
      const result = isCloudMaterialId(id)
        ? await updateCloudMaterialLink(id, newUrl)
        : updateMaterialLink(id, newUrl);
      sendJson(res, 200, { ok: true, material: result, materials: await getCloudMaterialsOrLocal() });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/materials/auto-replace-link") {
    try {
      const body = await readRequestBody(req);
      const id = String(body.id || "");
      let currentUrl = "";
      if (isCloudMaterialId(id)) {
        const row = await getCloudMaterialRow(id);
        currentUrl = row.url || extractSectionValue(row.report_md || "", "原文链接");
      } else {
        const { folderPath } = getMaterialFolderPath(id);
        const reportPath = path.join(folderPath, "report.md");
        const report = fs.readFileSync(reportPath, "utf-8");
        currentUrl = extractSectionValue(report, "原文链接");
      }
      if (!currentUrl) throw new Error("No original link found");

      const resolvedUrl = await resolvePermanentUrl(currentUrl);
      if (!/mp\.weixin\.qq\.com\/s\//i.test(resolvedUrl)) {
        throw new Error("未解析到 mp.weixin.qq.com 永久链接，请手动替换");
      }

      const result = isCloudMaterialId(id)
        ? await updateCloudMaterialLink(id, resolvedUrl)
        : updateMaterialLink(id, resolvedUrl);
      sendJson(res, 200, { ok: true, resolvedUrl, material: result, materials: await getCloudMaterialsOrLocal() });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/materials/mark-rewritten") {
    try {
      const body = await readRequestBody(req);
      const id = String(body.id || "");
      if (!id) {
        sendJson(res, 400, { error: "id is required" });
        return true;
      }

      const material = isCloudMaterialId(id)
        ? await markCloudMaterialAsPendingPublish(id)
        : markLocalMaterialAsPendingPublish(id);
      sendJson(res, 200, { ok: true, material, materials: await getCloudMaterialsOrLocal() });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/materials/mark-published") {
    try {
      const body = await readRequestBody(req);
      const id = String(body.id || "");
      if (!id) {
        sendJson(res, 400, { error: "id is required" });
        return true;
      }

      const material = isCloudMaterialId(id)
        ? await markCloudMaterialAsPublished(id)
        : markLocalMaterialAsPublished(id);
      sendJson(res, 200, { ok: true, material, materials: await getCloudMaterialsOrLocal() });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/materials/archive") {
    try {
      const body = await readRequestBody(req);
      const id = String(body.id || "");
      if (!isCloudMaterialId(id)) {
        sendJson(res, 400, { error: "Only cloud materials can be archived" });
        return true;
      }

      await supabaseRequest(`/materials?id=eq.${encodeURIComponent(getCloudId(id))}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "archived" }),
      });
      sendJson(res, 200, { ok: true, materials: await getCloudMaterialsOrLocal() });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/materials/latest-generation") {
    try {
      const id = String(url.searchParams.get("id") || "");
      if (!id) {
        sendJson(res, 400, { error: "id is required" });
        return true;
      }

      const generation = isGenerationId(id)
        ? await getCloudGenerationById(id)
        : await getLatestCloudGenerationForMaterial(id);
      sendJson(res, 200, { ok: true, generation });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/generations") {
    try {
      const body = await readRequestBody(req);
      const generation = await createCloudGeneration(body);
      sendJson(res, 200, { ok: true, generation });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/md2card/render") {
    try {
      const body = await readRequestBody(req);
      const result = await renderCardsWithMd2Card(body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/generate") {
    try {
      const body = await readRequestBody(req);
      let sourceText = String(body.sourceText || "").trim();
      const originalSource = sourceText;
      let sourceTitle = String(body.sourceTitle || "").trim();

      if (body.materialId) {
        sourceText = await getMaterialSourceText(String(body.materialId));
      }

      if (!sourceText) {
        sendJson(res, 400, { error: "sourceText or materialId is required" });
        return true;
      }

      let evaluation = null;
      if (!body.materialId) {
        if (looksLikeUrl(sourceText)) {
          const fetched = await fetchUrlAsArticle(sourceText);
          sourceText = fetched.text;
          sourceTitle = sourceTitle || fetched.title || "";
        }

        const articleForEvaluation = {
          title: sourceTitle || inferTitleFromText(sourceText),
          summary: sourceText,
          url: looksLikeUrl(originalSource) ? originalSource : "",
          source_text: sourceText,
        };
        evaluation = await evaluateArticleValue(articleForEvaluation, {
          domain: String(body.domain || "").trim(),
          sourceType: String(body.sourceType || "instant"),
        });

        if (!evaluation.pass) {
          sendJson(res, 422, {
            error: "价值评估未通过，已停止生成。",
            blocked: true,
            evaluation,
          });
          return true;
        }
      }

      const result = await generateWithAI({
        sourceText,
        domain: String(body.domain || "").trim(),
        audience: String(body.audience || "").trim(),
        pageCount: String(body.pageCount || "").trim(),
      });
      sendJson(res, 200, {
        ok: true,
        provider: result.provider,
        result: result.data,
        evaluation,
        sourceTitle: sourceTitle || result.data?.title || inferTitleFromText(sourceText),
      });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return true;
  }

  return false;
}

function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.resolve(ROOT, `.${requested}`);

  if (!filePath.startsWith(ROOT)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendText(res, 404, "Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store, max-age=0",
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    const handled = await handleApi(req, res, url);
    if (!handled) sendJson(res, 404, { error: "API not found" });
    return;
  }

  serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log(`AI content workbench running at http://localhost:${PORT}`);
});
