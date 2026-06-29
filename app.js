const themes = [
  {
    id: "apple",
    name: "苹果备忘录",
    cardClass: "theme-apple",
    colors: ["#ffffff", "#f5e8bd", "#202124"],
  },
  {
    id: "instagram",
    name: "Instagram风格",
    cardClass: "theme-instagram",
    colors: ["#ff385c", "#7c4dff", "#ff9b21", "#32d3c6", "#ffe16a"],
  },
  {
    id: "minimal-gray",
    name: "简约高级灰",
    cardClass: "theme-minimal-gray",
    colors: ["#eff2f6", "#c7d0dc", "#526071"],
  },
  {
    id: "minimalist",
    name: "极简黑白",
    cardClass: "theme-minimalist",
    colors: ["#f8fafc", "#111827", "#ffffff"],
  },
  {
    id: "business",
    name: "商务简报",
    cardClass: "theme-business",
    colors: ["#f6f9ff", "#2d63da", "#143568"],
  },
  {
    id: "darktech",
    name: "暗黑科技",
    cardClass: "theme-darktech",
    colors: ["#0a1020", "#2563eb", "#22d3ee"],
  },
];

const flows = {
  library: {
    label: "素材库改写",
    desc: "素材已通过入库价值评估，本次从合规预检开始生成卡片。",
    steps: [
      ["compliance", "合规预检", "在改写前生成风险规避约束"],
      ["rewrite", "内容改写", "按平台语气缩写为可发布内容"],
      ["split", "图文切分", "拆分为封面、认知页、干货页和总结页"],
      ["render", "卡片生成", "根据封面与内页主题生成预览"],
      ["output", "输出结果", "整理标题、概述、标签和导出包"],
    ],
  },
  instant: {
    label: "即时生成",
    desc: "链接或正文会先做价值评估，通过后进入合规预检和卡片生成。",
    steps: [
      ["value", "价值评估", "判断素材是否值得进入内容生产"],
      ["compliance", "合规预检", "在改写前生成风险规避约束"],
      ["rewrite", "内容改写", "按平台语气缩写为可发布内容"],
      ["split", "图文切分", "拆分为封面、认知页、干货页和总结页"],
      ["render", "卡片生成", "根据封面与内页主题生成预览"],
      ["output", "输出结果", "整理标题、概述、标签和导出包"],
    ],
  },
  fetch: {
    label: "关键词抓取",
    desc: "关键词抓取只负责筛选并沉淀素材，不直接生成图文卡片。",
    steps: [
      ["fetch", "抓取文章", "根据关键词和平台获取候选文章"],
      ["rough", "粗筛", "过滤无效链接、低字数和不匹配主题"],
      ["value", "价值评估", "判断是否值得写入素材库"],
      ["dedupe", "去重", "用标题相似度过滤重复文章"],
      ["store", "写入素材库", "沉淀为待改写素材"],
    ],
  },
};

const state = {
  materialTab: "todo",
  instantTab: "link",
  coverTheme: "darktech",
  innerTheme: "apple",
  materials: [],
  rewritten: [],
  selectedMaterialId: null,
  activeFlow: "library",
  output: null,
  isRunning: false,
  pendingUnreplacedMaterialId: null,
  pageSize: 5,
  pages: {
    todo: 1,
    done: 1,
  },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function init() {
  renderThemeGroup("coverThemeGroup", "coverTheme");
  renderThemeGroup("innerThemeGroup", "innerTheme");
  renderMaterialLists();
  renderFlow("library");
  bindEvents();
  loadMaterialsFromBackend();
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.data = data;
    error.status = response.status;
    throw error;
  }
  return data;
}

async function loadMaterialsFromBackend({ silent = false } = {}) {
  try {
    const data = await apiRequest("/api/materials");
    state.materials = normalizeBackendMaterials(data.todo || []);
    state.rewritten = normalizeBackendMaterials(data.done || []);
    renderMaterialLists();
    if (silent) return;
    if (data.cloud?.enabled && !data.cloud.ok) {
      $("#flowDescription").textContent = `云端素材库暂不可用，当前显示本地素材：${data.cloud.error}`;
    } else if (data.storage === "cloud") {
      $("#flowDescription").textContent = "已连接云端素材库，刷新后素材仍会保留。";
    }
  } catch {
    // Static file mode keeps the prototype usable without a local backend.
  }
}

function normalizeBackendMaterials(items) {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    shortTitle: item.shortTitle || item.title,
    platform: item.platform || "gzh",
    value: item.value || "未标注",
    heat: item.heat || "未标注",
    priority: item.priority || "未标注",
    linkStatus: item.linkStatus || "未标注",
    url: item.url || "",
    folderName: item.folderName || "",
    storage: item.storage || "local",
    sourceType: item.sourceType || "",
  }));
}

function renderThemeGroup(containerId, stateKey) {
  const container = document.getElementById(containerId);
  container.innerHTML = themes
    .map((theme) => {
      const active = state[stateKey] === theme.id ? " active" : "";
      const swatches = theme.colors
        .map((color) => `<span class="swatch" style="background:${color}"></span>`)
        .join("");

      return `
        <button class="theme-option${active}" data-theme-key="${stateKey}" data-theme-id="${theme.id}" type="button">
          <span class="theme-name">${theme.name}</span>
          <span class="swatches">${swatches}</span>
        </button>
      `;
    })
    .join("");
}

function renderFlow(flowKey, activeKey = null, doneKeys = []) {
  const flow = flows[flowKey];
  state.activeFlow = flowKey;
  $("#flowDescription").textContent = flow.desc;
  $("#taskSummary").textContent = `任务：${flow.label}`;

  $("#pipelineList").innerHTML = flow.steps
    .map(([key, title]) => {
      const done = doneKeys.includes(key);
      const running = activeKey === key;
      const cls = done ? " done" : running ? " running" : "";

      return `
        <span class="compact-step${cls}">${title}</span>
      `;
    })
    .join("");

  if (activeKey) {
    const activeStep = flow.steps.find(([key]) => key === activeKey);
    $("#compactTaskBadge").textContent = activeStep ? `正在${activeStep[1]}` : "进行中";
  } else if (doneKeys.length === flow.steps.length && doneKeys.length > 0) {
    $("#compactTaskBadge").textContent = "已完成";
  } else {
    $("#compactTaskBadge").textContent = "等待开始";
  }
}

function bindEvents() {
  $$("[data-material-tab]").forEach((button) => {
    button.addEventListener("click", () => switchMaterialTab(button.dataset.materialTab));
  });

  $$("[data-instant-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.instantTab = button.dataset.instantTab;
      $$("[data-instant-tab]").forEach((item) => item.classList.remove("active"));
      $$("[data-instant-pane]").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      $(`[data-instant-pane="${state.instantTab}"]`).classList.add("active");
    });
  });

  $$("[data-result-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      $$("[data-result-tab]").forEach((item) => item.classList.remove("active"));
      $$("[data-result-pane]").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      $(`[data-result-pane="${button.dataset.resultTab}"]`).classList.add("active");
    });
  });

  document.addEventListener("click", (event) => {
    const themeOption = event.target.closest("[data-theme-id]");
    if (themeOption) {
      const key = themeOption.dataset.themeKey;
      state[key] = themeOption.dataset.themeId;
      renderThemeGroup(key === "coverTheme" ? "coverThemeGroup" : "innerThemeGroup", key);
      if (state.output) renderResult(state.output);
      return;
    }

    const selectButton = event.target.closest("[data-select-material]");
    if (selectButton) {
      selectMaterial(selectButton.dataset.selectMaterial);
      return;
    }

    const rewriteButton = event.target.closest("[data-rewrite-material]");
    if (rewriteButton) {
      selectMaterial(rewriteButton.dataset.rewriteMaterial);
      runLibraryPipeline();
      return;
    }

    const viewButton = event.target.closest("[data-view-original]");
    if (viewButton) {
      viewOriginal(viewButton.dataset.viewOriginal);
      return;
    }

    const viewGenerationButton = event.target.closest("[data-view-generation]");
    if (viewGenerationButton) {
      loadGenerationForMaterial(viewGenerationButton.dataset.viewGeneration);
      return;
    }

    const cardImage = event.target.closest("[data-card-image]");
    if (cardImage) {
      openImageLightbox(cardImage.dataset.cardImage, cardImage.dataset.cardTitle || "卡片图片");
      return;
    }

    const replaceButton = event.target.closest("[data-replace-link]");
    if (replaceButton) {
      replaceMaterialLink(replaceButton.dataset.replaceLink);
      return;
    }

    const autoReplaceButton = event.target.closest("[data-auto-replace-link]");
    if (autoReplaceButton) {
      autoReplaceMaterialLink(autoReplaceButton.dataset.autoReplaceLink);
      return;
    }

    const deleteButton = event.target.closest("[data-delete-material]");
    if (deleteButton) {
      deleteMaterial(deleteButton.dataset.deleteMaterial);
      return;
    }

    const pageButton = event.target.closest("[data-page-target]");
    if (pageButton) {
      changeMaterialPage(pageButton.dataset.pageTarget, pageButton.dataset.pageAction);
    }
  });

  $("#mainActionButton").addEventListener("click", runCurrentTask);
  $("#fetchMaterialsButton").addEventListener("click", runFetchPipeline);
  $("#instantGenerateButton").addEventListener("click", runInstantPipeline);
  $("#lightboxCloseButton").addEventListener("click", closeImageLightbox);
  $("#imageLightbox").addEventListener("click", (event) => {
    if (event.target.id === "imageLightbox") closeImageLightbox();
  });
  $("#cancelUnreplacedButton").addEventListener("click", closeUnreplacedLinkDialog);
  $("#manualReplaceFromDialogButton").addEventListener("click", () => {
    const id = state.pendingUnreplacedMaterialId;
    closeUnreplacedLinkDialog();
    if (id) replaceMaterialLink(id);
  });
  $("#continueUnreplacedButton").addEventListener("click", () => {
    closeUnreplacedLinkDialog();
    runLibraryPipelineConfirmed();
  });
  $("#materialSearchInput").addEventListener("input", () => {
    resetMaterialPages();
    renderMaterialLists();
  });
  $("#materialFilterInput").addEventListener("change", () => {
    resetMaterialPages();
    renderMaterialLists();
  });
  $("#copyButton").addEventListener("click", copyPackage);
  $("#downloadButton").addEventListener("click", downloadMarkdown);
}

function switchMaterialTab(tab) {
  state.materialTab = tab;
  $$("[data-material-tab]").forEach((item) => item.classList.remove("active"));
  $$("[data-material-pane]").forEach((item) => item.classList.remove("active"));
  $(`[data-material-tab="${tab}"]`).classList.add("active");
  $(`[data-material-pane="${tab}"]`).classList.add("active");

  if (tab === "fetch") renderFlow("fetch");
  if (tab === "instant") renderFlow("instant");
  if (tab === "todo" || tab === "done") renderFlow("library");

  if (tab === "fetch") setCompactTask("关键词抓取", "等待开始");
  if (tab === "instant") setCompactTask("即时输入", "等待开始");
  if (tab === "todo") setCompactTask(getSelectedMaterial()?.title || "未选择素材", "等待开始");
  if (tab === "done") setCompactTask("已改写素材", "仅查看");
}

function setCompactTask(title, badge = "等待开始") {
  $("#compactTaskTitle").textContent = title;
  $("#compactTaskBadge").textContent = badge;
}

function runCurrentTask() {
  if (state.materialTab === "fetch") return runFetchPipeline();
  if (state.materialTab === "instant") return runInstantPipeline();
  if (state.materialTab === "todo") return runLibraryPipeline();
  return switchMaterialTab("todo");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runFlow(flowKey, onStepDone) {
  if (state.isRunning) return false;
  state.isRunning = true;
  setButtonsDisabled(true);

  const doneKeys = [];
  for (const [key] of flows[flowKey].steps) {
    renderFlow(flowKey, key, doneKeys);
    await wait(key === "render" ? 720 : 520);
    doneKeys.push(key);
    onStepDone?.(key);
  }

  renderFlow(flowKey, null, doneKeys);
  setButtonsDisabled(false);
  state.isRunning = false;
  return true;
}

function setButtonsDisabled(disabled) {
  ["mainActionButton", "fetchMaterialsButton", "instantGenerateButton"].forEach((id) => {
    const button = document.getElementById(id);
    if (button) button.disabled = disabled;
  });
}

function setFlowProgress(flowKey, activeKey, doneKeys = []) {
  renderFlow(flowKey, activeKey, doneKeys);
}

function finishFlowProgress(flowKey) {
  renderFlow(flowKey, null, flows[flowKey].steps.map(([key]) => key));
}

async function runFetchPipeline() {
  const keyword = $("#keywordInput").value.trim();
  if (!keyword) {
    switchMaterialTab("fetch");
    $("#flowDescription").textContent = "请先输入关键词。关键词会作为本次抓取和价值评估的目标领域。";
    return;
  }

  const platform = $("#platformInput").value;
  if (platform !== "微信公众号") {
    switchMaterialTab("fetch");
    $("#flowDescription").textContent = "当前线上版已接入微信公众号真实抓取；小红书和 X 需要登录态/Cookie，暂未在网页端启用。";
    return;
  }

  resetOutput("抓取任务执行中，完成后会写入待改写素材。");
  setCompactTask("关键词抓取", "准备抓取");
  $("#complianceSummary").textContent = "合规：生成阶段执行";
  $("#cardSummary").textContent = "卡片：不生成";
  $("#resultSourceBadge").textContent = "来源：关键词抓取";
  $("#resultComplianceBadge").textContent = "合规：生成阶段执行";

  const ok = await runFlow("fetch");
  if (!ok) return;

  let fetchResult;
  try {
    fetchResult = await fetchMaterialsFromBackend();
  } catch (error) {
    $("#titleOutput").value = "抓取失败";
    $("#summaryOutput").value = error.message;
    $("#tagOutput").innerHTML = "<span>未入库</span>";
    $("#exportPreview").textContent = `# 关键词抓取失败\n\n${error.message}`;
    $("#flowDescription").textContent = `抓取失败：${error.message}`;
    return;
  }

  const newMaterials = fetchResult.materials;
  if (newMaterials.length) {
    state.materials = [...newMaterials, ...state.materials.filter((item) => !newMaterials.some((next) => next.id === item.id))];
  }
  await loadMaterialsFromBackend();
  renderMaterialLists();
  switchMaterialTab("todo");

  const summary = fetchResult.summary || {};
  $("#titleOutput").value = `已新增 ${summary.inserted ?? newMaterials.length} 篇待改写素材`;
  $("#summaryOutput").value =
    `关键词抓取已完成：抓到 ${summary.fetched ?? 0} 篇，通过 ${summary.passed ?? newMaterials.length} 篇，新增 ${summary.inserted ?? newMaterials.length} 篇，重复 ${summary.duplicates ?? 0} 篇，淘汰 ${summary.rejected ?? 0} 篇。`;
  $("#tagOutput").innerHTML = newMaterials.length
    ? newMaterials.map((item) => `<span>${item.shortTitle}</span>`).join("")
    : "<span>暂无新增</span>";
  $("#exportPreview").textContent = buildFetchSummary(fetchResult);
}

async function fetchMaterialsFromBackend() {
  const keyword = $("#keywordInput").value.trim();
  const platform = $("#platformInput").value;
  const count = Number.parseInt($("#fetchCountInput").value, 10) || 5;

  if (platform !== "微信公众号") {
    throw new Error("当前网页端仅启用微信公众号真实抓取。");
  }

  const result = await apiRequest("/api/fetch/wechat", {
    method: "POST",
    body: JSON.stringify({ keyword, count }),
  });
  if (result.cloud?.enabled && !result.cloud.ok) {
    $("#flowDescription").textContent = `抓取完成，但云端写入失败：${result.cloud.error}`;
  } else {
    const providerText = result.summary?.provider === "local-rules" ? "本地规则预评估" : result.summary?.provider || "价值评估";
    $("#flowDescription").textContent = `抓取完成，已执行${providerText}。`;
  }

  return {
    ...result,
    materials: normalizeBackendMaterials(result.materials || []),
  };
}

async function runLibraryPipeline() {
  const material = getSelectedMaterial();
  if (!material) {
    setCompactTask("未选择素材", "等待选择");
    $("#flowDescription").textContent = "请先在“待改写”中选择一篇素材。";
    switchMaterialTab("todo");
    return;
  }

  if (material.linkStatus === "未替换") {
    openUnreplacedLinkDialog(material.id);
    return;
  }

  await runLibraryPipelineConfirmed();
}

async function runLibraryPipelineConfirmed() {
  const material = getSelectedMaterial();
  if (!material) return;

  resetOutput("正在基于素材库文章生成卡片。");
  setCompactTask(material.title, "准备生成");
  $("#resultSourceBadge").textContent = "来源：素材库";
  if (state.isRunning) return;
  state.isRunning = true;
  setButtonsDisabled(true);
  setFlowProgress("library", "compliance", []);

  try {
    const output = await createGeneratedOutputWithBackend({
      sourceType: "素材库",
      sourceValue: material.title,
      material,
    }).catch((error) => handleGenerationBlocked(error));
    if (!output) return;
    setFlowProgress("library", "render", ["compliance", "rewrite", "split"]);
    state.output = output;
    renderResult(output);
    const md2cardOk = await renderMd2CardForOutput(output);
    if (!md2cardOk) return;
    setFlowProgress("library", "output", ["compliance", "rewrite", "split", "render"]);
    $("#flowDescription").textContent = "卡片已生成，正在保存结果和更新素材状态。";
    await saveGenerationRecord(output, material.id);
    await markMaterialAsRewritten(material.id);
    finishFlowProgress("library");
  } finally {
    state.isRunning = false;
    setButtonsDisabled(false);
  }
}

function openUnreplacedLinkDialog(id) {
  state.pendingUnreplacedMaterialId = id;
  $("#flowDescription").textContent = "当前素材链接未替换，建议先替换为永久原文链接后再生成。";
  const dialog = $("#unreplacedLinkDialog");
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else if (window.confirm("当前链接未替换，继续生成可能只基于已沉淀摘要。是否继续生成？")) {
    runLibraryPipelineConfirmed();
  }
}

function closeUnreplacedLinkDialog() {
  const dialog = $("#unreplacedLinkDialog");
  if (dialog.open) dialog.close();
}

async function runInstantPipeline() {
  const instantValue = getInstantValue();
  if (!instantValue) {
    switchMaterialTab("instant");
    $("#flowDescription").textContent = state.instantTab === "link" ? "请先粘贴文章链接。" : "请先粘贴文章正文。";
    return;
  }
  if (state.instantTab === "link" && !/^https?:\/\//i.test(instantValue)) {
    switchMaterialTab("instant");
    $("#flowDescription").textContent = "文章链接需要以 http:// 或 https:// 开头。";
    return;
  }

  resetOutput("即时输入正在生成卡片。");
  setCompactTask(state.instantTab === "link" ? "即时输入：文章链接" : "即时输入：粘贴正文", "准备生成");
  $("#resultSourceBadge").textContent = state.instantTab === "link" ? "来源：文章链接" : "来源：粘贴正文";
  if (state.isRunning) return;
  state.isRunning = true;
  setButtonsDisabled(true);
  setFlowProgress("instant", "value", []);

  try {
    const output = await createGeneratedOutputWithBackend({
      sourceType: state.instantTab === "link" ? "文章链接" : "粘贴正文",
      sourceValue: instantValue,
    }).catch((error) => handleGenerationBlocked(error));
    if (!output) return;
    setFlowProgress("instant", "render", ["value", "compliance", "rewrite", "split"]);
    state.output = output;
    renderResult(output);
    const md2cardOk = await renderMd2CardForOutput(output);
    if (!md2cardOk) return;
    setFlowProgress("instant", "output", ["value", "compliance", "rewrite", "split", "render"]);
    $("#flowDescription").textContent = "卡片已生成，正在保存即时生成历史。";
    await saveGenerationRecord(output);
    await loadMaterialsFromBackend({ silent: true });
    finishFlowProgress("instant");
    $("#flowDescription").textContent = "即时生成已保存到已改写素材，可在“已改写”中查看历史结果。";
  } finally {
    state.isRunning = false;
    setButtonsDisabled(false);
  }
}

function handleGenerationBlocked(error) {
  if (error.status === 422 && error.data?.evaluation) {
    const evaluation = error.data.evaluation;
    const message = `${evaluation.valueLabel}${evaluation.heatLabel}｜${evaluation.priorityLabel}：${evaluation.reason}`;
    $("#titleOutput").value = "价值评估未通过";
    $("#summaryOutput").value = "系统已在改写前停止生成，避免低价值素材进入卡片生产。";
    $("#tagOutput").innerHTML = `<span>${evaluation.valueLabel}</span><span>${evaluation.heatLabel}</span><span>${evaluation.priorityLabel}</span>`;
    $("#cardPreviewGrid").innerHTML = `<div class="empty-state">${message}</div>`;
    $("#editLinkList").innerHTML = '<div class="empty-state compact">未进入 md2card 生成。</div>';
    $("#exportPreview").textContent = `# 价值评估未通过\n\n${message}\n\n建议：${evaluation.recommendedAction || "更换素材或补充更明确的领域上下文。"}`;
    $("#flowDescription").textContent = `生成已停止：${message}`;
    $("#resultComplianceBadge").textContent = "合规：未进入";
    $("#complianceSummary").textContent = "合规：未进入";
    $("#cardSummary").textContent = "卡片：未生成";
    return null;
  }
  throw error;
}

function applyGenerationStepOutput(stepKey) {
  if (stepKey === "value") {
    $("#taskSummary").textContent = `任务：${flows[state.activeFlow].label} · 价值通过`;
  }
  if (stepKey === "compliance") {
    $("#complianceSummary").textContent = "合规：已通过";
    $("#resultComplianceBadge").textContent = "合规：已预检";
  }
  if (stepKey === "split") {
    $("#cardSummary").textContent = `卡片：${getPageCountLabel()}`;
  }
}

function resetOutput(message) {
  state.output = null;
  $("#titleOutput").value = "处理中";
  $("#summaryOutput").value = message;
  $("#tagOutput").innerHTML = "<span>处理中</span>";
  $("#cardPreviewGrid").innerHTML = `<div class="empty-state">${message}</div>`;
  $("#editLinkList").innerHTML =
    '<div class="empty-state compact">真实接入 md2card 后，每页会在这里显示在线编辑链接。</div>';
  $("#exportPreview").textContent = message;
  $("#complianceSummary").textContent = "合规：未执行";
  $("#cardSummary").textContent = "卡片：待生成";
  $("#resultComplianceBadge").textContent = "合规：待执行";
}

function renderMaterialLists() {
  const todo = $("#todoMaterialList");
  const done = $("#doneMaterialList");
  const visibleMaterials = filterMaterials(state.materials);
  const visibleRewritten = filterMaterials(state.rewritten);
  const todoPage = normalizePage("todo", visibleMaterials.length);
  const donePage = normalizePage("done", visibleRewritten.length);
  const todoItems = paginateItems(visibleMaterials, todoPage);
  const doneItems = paginateItems(visibleRewritten, donePage);

  todo.innerHTML = visibleMaterials.length
    ? todoItems.map((item) => renderMaterialCard(item, false)).join("")
    : '<div class="empty-state compact">暂无匹配的待改写素材。可以调整筛选或执行关键词抓取。</div>';

  done.innerHTML = visibleRewritten.length
    ? doneItems.map((item) => renderMaterialCard(item, true)).join("")
    : '<div class="empty-state compact">暂无匹配的已改写素材。</div>';

  renderPagination("todoPagination", "todo", visibleMaterials.length, todoPage);
  renderPagination("donePagination", "done", visibleRewritten.length, donePage);
}

function resetMaterialPages() {
  state.pages.todo = 1;
  state.pages.done = 1;
}

function normalizePage(type, total) {
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  state.pages[type] = Math.min(Math.max(1, state.pages[type] || 1), totalPages);
  return state.pages[type];
}

function paginateItems(items, page) {
  const start = (page - 1) * state.pageSize;
  return items.slice(start, start + state.pageSize);
}

function renderPagination(containerId, type, total, page) {
  const container = document.getElementById(containerId);
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));

  if (!total || totalPages <= 1) {
    container.innerHTML = total ? `<span class="pagination-info">共 ${total} 篇</span>` : "";
    return;
  }

  container.innerHTML = `
    <button class="tiny-button" data-page-target="${type}" data-page-action="prev" type="button" ${page <= 1 ? "disabled" : ""}>上一页</button>
    <span class="pagination-info">第 ${page} / ${totalPages} 页 · 共 ${total} 篇</span>
    <button class="tiny-button" data-page-target="${type}" data-page-action="next" type="button" ${page >= totalPages ? "disabled" : ""}>下一页</button>
  `;
}

function changeMaterialPage(type, action) {
  const source = type === "done" ? state.rewritten : state.materials;
  const total = filterMaterials(source).length;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  if (action === "prev") state.pages[type] = Math.max(1, state.pages[type] - 1);
  if (action === "next") state.pages[type] = Math.min(totalPages, state.pages[type] + 1);
  renderMaterialLists();
}

function filterMaterials(items) {
  const keyword = ($("#materialSearchInput")?.value || "").trim().toLowerCase();
  const filter = $("#materialFilterInput")?.value || "全部素材";

  return items.filter((item) => {
    const haystack = [item.title, item.shortTitle, item.platform, item.value, item.heat, item.priority, item.linkStatus]
      .join(" ")
      .toLowerCase();
    const keywordMatched = !keyword || haystack.includes(keyword);
    const filterMatched =
      filter === "全部素材" ||
      (filter === "高价值" && item.value === "高价值") ||
      (filter === "近期热点" && item.priority === "近期热点") ||
      (filter === "长尾话题" && item.priority === "长尾话题");
    return keywordMatched && filterMatched;
  });
}

function renderMaterialCard(item, isDone) {
  const selected = state.selectedMaterialId === item.id ? " selected" : "";
  const originalButton = item.url
    ? `<button class="tiny-button" data-view-original="${item.id}" type="button">查看原文</button>`
    : '<button class="tiny-button" type="button" disabled>暂无原文</button>';
  const replaceButtons =
    !isDone && item.linkStatus === "未替换"
      ? `<button class="tiny-button" data-auto-replace-link="${item.id}" type="button">自动替换</button>
         <button class="tiny-button" data-replace-link="${item.id}" type="button">手动替换</button>`
      : "";
  const action = isDone
    ? `<span class="material-primary-actions">
         ${originalButton}
         <button class="tiny-button primary" data-view-generation="${item.id}" type="button">查看结果</button>
       </span>
       <span class="status-pill">已生成</span>`
    : `<span class="material-primary-actions">
         ${originalButton}
         ${replaceButtons}
         <button class="tiny-button primary" data-rewrite-material="${item.id}" type="button">生成卡片</button>
       </span>
       <button class="tiny-button danger material-delete-button" data-delete-material="${item.id}" type="button">删除</button>`;

  return `
    <article class="material-card${selected}">
      <h3 class="material-title">${isDone ? "❌" : ""}${item.title}</h3>
      <div class="material-meta">
        ${renderMetaTag(item.platform, "platform")}
        ${renderMetaTag(item.value, "value")}
        ${renderMetaTag(item.heat, "heat")}
        ${renderMetaTag(item.priority, "priority")}
        ${renderMetaTag(item.linkStatus, "link")}
      </div>
      <div class="material-actions">${action}</div>
    </article>
  `;
}

function renderMetaTag(text, type) {
  return `<span class="meta-tag ${type} ${metaClass(text)}">${text}</span>`;
}

function metaClass(text) {
  const value = String(text || "");
  if (value === "未替换" || value === "未入库") return "danger";
  if (value === "已替换") return "success";
  if (value === "近期热点") return "hot";
  if (value === "长尾话题") return "tail";
  if (value === "过期热点") return "stale";
  if (value === "高价值") return "high";
  if (value === "中等价值") return "medium";
  if (value === "S热度") return "hot";
  if (value === "A热度") return "high";
  if (value === "B热度") return "medium";
  return "";
}

function findMaterialById(id) {
  return [...state.materials, ...state.rewritten].find((item) => item.id === id);
}

function viewOriginal(id) {
  const material = findMaterialById(id);
  if (!material?.url) return;
  window.open(material.url, "_blank", "noopener,noreferrer");
}

async function loadGenerationForMaterial(id) {
  const material = findMaterialById(id);
  try {
    $("#flowDescription").textContent = "正在读取该素材的历史生成结果。";
    setCompactTask(material?.title || "已改写素材", "读取结果");

    const data = await apiRequest(`/api/materials/latest-generation?id=${encodeURIComponent(id)}`);
    const output = generationToOutput(data.generation, material);
    state.output = output;
    state.selectedMaterialId = id;
    renderMaterialLists();
    renderResult(output);
    renderFlow("library", null, flows.library.steps.map(([key]) => key));
    setCompactTask(material?.title || output.title, "已恢复");
    $("#flowDescription").textContent = "已在右侧恢复这篇素材最近一次生成结果。";
  } catch (error) {
    alert(`读取历史结果失败：${error.message}`);
    $("#flowDescription").textContent = `读取历史结果失败：${error.message}`;
  }
}

function generationToOutput(generation, material = null) {
  const settings = generation?.settings || {};
  const coverTheme = getTheme(settings.coverTheme || state.coverTheme);
  const innerTheme = getTheme(settings.innerTheme || state.innerTheme);
  const rawCards = Array.isArray(generation?.cards) ? generation.cards : [];
  const cards = rawCards.map((card, index) => ({
    page: Number(card.page || index + 1),
    label: String(card.label || (index === 0 ? "封面" : "内容页")),
    title: String(card.title || `第 ${index + 1} 页`),
    body: String(card.body || ""),
    theme: getTheme(card.theme || (index === 0 ? coverTheme.id : innerTheme.id)),
    md2card: card.md2card || null,
  }));

  return {
    sourceType: generation?.source_type || "素材库",
    sourceValue: generation?.source_value || material?.title || "",
    title: generation?.title || material?.title || "历史生成结果",
    summary: generation?.summary || "",
    tags: Array.isArray(generation?.tags) ? generation.tags.map(String) : [],
    cards,
    coverTheme,
    innerTheme,
    domain: settings.domain || "",
    audience: settings.audience || "",
    markdown: generation?.markdown || buildMarkdown({
      sourceType: generation?.source_type || "素材库",
      sourceValue: generation?.source_value || material?.title || "",
      title: generation?.title || material?.title || "历史生成结果",
      summary: generation?.summary || "",
      tags: Array.isArray(generation?.tags) ? generation.tags.map(String) : [],
      cards,
      coverTheme,
      innerTheme,
      domain: settings.domain || "",
      audience: settings.audience || "",
    }),
    md2card: settings.md2card || null,
  };
}

async function replaceMaterialLink(id) {
  const material = findMaterialById(id);
  const nextUrl = window.prompt("粘贴永久原文链接，建议使用 mp.weixin.qq.com/s/...：", material?.url || "");
  if (!nextUrl) return;

  try {
    const data = await apiRequest("/api/materials/replace-link", {
      method: "POST",
      body: JSON.stringify({ id, url: nextUrl }),
    });
    state.materials = normalizeBackendMaterials(data.materials.todo || []);
    state.rewritten = normalizeBackendMaterials(data.materials.done || []);
    state.selectedMaterialId = data.material?.id || null;
    renderMaterialLists();
    $("#flowDescription").textContent = "链接已替换，素材状态已更新。";
  } catch (error) {
    alert(`替换失败：${error.message}`);
  }
}

async function autoReplaceMaterialLink(id) {
  try {
    $("#flowDescription").textContent = "正在尝试解析永久链接，如果遇到平台跳转限制可能失败。";
    const data = await apiRequest("/api/materials/auto-replace-link", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    state.materials = normalizeBackendMaterials(data.materials.todo || []);
    state.rewritten = normalizeBackendMaterials(data.materials.done || []);
    state.selectedMaterialId = data.material?.id || null;
    renderMaterialLists();
    $("#flowDescription").textContent = "已自动替换为永久链接。";
  } catch (error) {
    alert(`自动替换失败：${error.message}\n\n可以点击“手动替换”粘贴永久链接。`);
  }
}

async function deleteMaterial(id) {
  const material = findMaterialById(id);
  if (!material) return;

  const confirmed = window.confirm(`确定从待改写素材中删除这篇文章吗？\n\n${material.title}\n\n删除后将从当前列表移除。`);
  if (!confirmed) return;

  try {
    const data = await apiRequest("/api/materials/archive", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    state.materials = normalizeBackendMaterials(data.materials.todo || []);
    state.rewritten = normalizeBackendMaterials(data.materials.done || []);
    if (state.selectedMaterialId === id) state.selectedMaterialId = null;
    renderMaterialLists();
    $("#flowDescription").textContent = "素材已删除，已从待改写列表移除。";
  } catch (error) {
    alert(`删除失败：${error.message}`);
  }
}

function selectMaterial(id) {
  state.selectedMaterialId = id;
  const material = getSelectedMaterial();
  renderMaterialLists();
  if (!material) return;

  $("#flowDescription").textContent = `${material.platform} · ${material.value}${material.heat} · ${material.priority} · ${material.linkStatus}`;
  renderFlow("library");
  setCompactTask(material.title, "已选择");
}

function getSelectedMaterial() {
  return state.materials.find((item) => item.id === state.selectedMaterialId);
}

async function markMaterialAsRewritten(id) {
  try {
    const data = await apiRequest("/api/materials/mark-rewritten", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    state.materials = normalizeBackendMaterials(data.materials.todo || []);
    state.rewritten = normalizeBackendMaterials(data.materials.done || []);
    state.selectedMaterialId = null;
    renderMaterialLists();
    return;
  } catch (error) {
    $("#flowDescription").textContent = `云端状态更新失败，已先在当前页面移动：${error.message}`;
  }

  const index = state.materials.findIndex((item) => item.id === id);
  if (index < 0) return;
  const [material] = state.materials.splice(index, 1);
  state.rewritten = [{ ...material, rewrittenAt: new Date().toISOString() }, ...state.rewritten];
  state.selectedMaterialId = null;
  renderMaterialLists();
}

async function saveGenerationRecord(output, materialId = null) {
  try {
    await apiRequest("/api/generations", {
      method: "POST",
      body: JSON.stringify({
        materialId,
        sourceType: output.sourceType,
        sourceValue: output.sourceValue,
        title: output.title,
        summary: output.summary,
        tags: output.tags,
        cards: output.cards.map((card) => ({
          page: card.page,
          label: card.label,
          title: card.title,
          body: card.body,
          theme: card.theme?.id,
          md2card: card.md2card || null,
        })),
        markdown: output.markdown,
        settings: {
          coverTheme: output.coverTheme?.id,
          innerTheme: output.innerTheme?.id,
          domain: output.domain,
          audience: output.audience,
          pageCount: $("#pageCountInput").value,
          md2card: output.md2card || null,
        },
      }),
    });
  } catch (error) {
    console.warn("Generation record was not saved:", error.message);
  }
}

async function renderMd2CardForOutput(output) {
  try {
    $("#flowDescription").textContent = "正在调用 md2card 生成卡片图片和在线编辑链接。";
    $("#editLinkList").innerHTML = '<div class="empty-state compact">md2card 正在生成在线编辑链接和图片，请稍候...</div>';
    const response = await apiRequest("/api/md2card/render", {
      method: "POST",
      body: JSON.stringify({
        coverTheme: output.coverTheme?.id,
        innerTheme: output.innerTheme?.id,
        cards: output.cards.map((card) => ({
          page: card.page,
          label: card.label,
          title: card.title,
          body: card.body,
          themeId: card.theme?.id,
        })),
      }),
    });

    output.md2card = response;
    output.cards = output.cards.map((card) => ({
      ...card,
      md2card: response.cards?.find((item) => Number(item.page) === Number(card.page)) || null,
    }));
    state.output = output;
    renderResult(output);
    $("#flowDescription").textContent = `md2card 已生成，消耗积分 ${response.totalCost || 0}`;
    return true;
  } catch (error) {
    output.md2cardError = error.message;
    state.output = output;
    renderResult(output);
    $("#flowDescription").textContent = `md2card 生成失败：${error.message}`;
    alert(`md2card 生成失败，可能是积分不足、接口额度不足或服务异常。\n\n已保留本次 AI 生成的标题、正文概述和卡片文案，你可以稍后重新生成图片。\n\n错误信息：${error.message}`);
    return false;
  }
}

function getInstantValue() {
  if (state.instantTab === "link") {
    return $("#linkInput").value.trim();
  }
  return $("#articleInput").value.trim();
}

function getPageCount() {
  return getPageCountSetting().target;
}

function getPageCountSetting() {
  const setting = $("#pageCountInput").value;
  if (setting === "3 页") return { mode: "fixed", min: 3, max: 3, target: 3, label: "3 张" };
  if (setting === "5 页") return { mode: "fixed", min: 5, max: 5, target: 5, label: "5 张" };
  if (setting === "7 页") return { mode: "fixed", min: 7, max: 7, target: 7, label: "7 张" };
  return { mode: "auto", min: 3, max: 5, target: 5, label: "3-5 张" };
}

function getPageCountLabel() {
  return getPageCountSetting().label;
}

function normalizeCardTargetCount(rawCount) {
  const setting = getPageCountSetting();
  if (setting.mode === "fixed") return setting.target;
  const count = Number.isFinite(rawCount) ? rawCount : 0;
  return Math.min(setting.max, Math.max(setting.min, count || setting.min));
}

function getTheme(id) {
  return themes.find((theme) => theme.id === id) || themes[0];
}

async function createGeneratedOutputWithBackend(params) {
  const domain = getOptionalContext("domainInput", "");
  const audience = getOptionalContext("audienceInput", "");

  try {
    const response = await apiRequest("/api/generate", {
      method: "POST",
      body: JSON.stringify({
        materialId: params.material?.id,
        sourceText: params.material ? params.material.title : params.sourceValue,
        sourceType: params.sourceType,
        domain,
        audience,
        pageCount: $("#pageCountInput").value,
      }),
    });
    const evaluationText = response.evaluation
      ? `，价值评估：${response.evaluation.valueLabel}${response.evaluation.heatLabel}`
      : "";
    $("#flowDescription").textContent = `已调用真实 AI 生成：${response.provider}${evaluationText}`;
    return createGeneratedOutputFromAi(params, response.result, response.evaluation);
  } catch (error) {
    if (error.status === 422 && error.data?.evaluation) {
      throw error;
    }
    const message = `AI 生成失败，可能是大模型额度不足、Key 无效或接口异常。\n\n本次已停止生成，不会使用演示模板代替真实改写。\n\n错误信息：${error.message}`;
    $("#titleOutput").value = "AI 生成失败";
    $("#summaryOutput").value = "本次未完成真实 AI 改写，请检查大模型额度、Key 或接口配置后重试。";
    $("#tagOutput").innerHTML = "<span>生成失败</span>";
    $("#cardPreviewGrid").innerHTML = `<div class="empty-state">${escapeHtml(message).replace(/\n/g, "<br>")}</div>`;
    $("#editLinkList").innerHTML = '<div class="empty-state compact">未进入 md2card 生成。</div>';
    $("#exportPreview").textContent = message;
    $("#flowDescription").textContent = "AI 生成失败，已停止任务。";
    $("#resultComplianceBadge").textContent = "合规：未完成";
    $("#complianceSummary").textContent = "合规：未完成";
    $("#cardSummary").textContent = "卡片：未生成";
    alert(message);
    return null;
  }
}

function createGeneratedOutputFromAi(params, aiResult, evaluation = null) {
  const coverTheme = getTheme(state.coverTheme);
  const innerTheme = getTheme(state.innerTheme);
  const domain = getOptionalContext("domainInput", "未指定，系统按素材自动判断");
  const audience = getOptionalContext("audienceInput", "未指定，系统按素材自动判断");
  const rawCards = Array.isArray(aiResult.cards) ? aiResult.cards : [];
  const pageCount = normalizeCardTargetCount(rawCards.length);
  const cards = rawCards.slice(0, pageCount).map((card, index) => ({
    page: Number(card.page || index + 1),
    theme: index === 0 ? coverTheme : innerTheme,
    title: String(card.title || `第 ${index + 1} 页`),
    body: String(card.body || ""),
    label: String(card.label || (index === 0 ? "封面" : "内容页")),
  }));

  const fallbackCards = createGeneratedOutput(params).cards;
  const normalizedCards = cards.length === pageCount ? cards : [...cards, ...fallbackCards.slice(cards.length)].slice(0, pageCount);
  const output = {
    sourceType: params.sourceType,
    sourceValue: params.sourceValue,
    title: String(aiResult.title || "等待人工确认标题"),
    summary: String(aiResult.summary || ""),
    tags: Array.isArray(aiResult.tags) ? aiResult.tags.map(String).slice(0, 8) : [],
    cards: normalizedCards,
    coverTheme,
    innerTheme,
    domain,
    audience,
    evaluation,
  };

  output.markdown = buildMarkdown(output);
  if (evaluation) {
    output.markdown += `\n\n## 价值评估摘要\n${evaluation.mode}｜${evaluation.valueLabel}${evaluation.heatLabel}｜${evaluation.priorityLabel}\n${evaluation.reason}`;
  }
  if (aiResult.complianceSummary) {
    output.markdown += `\n\n## AI 合规预检\n${aiResult.complianceSummary}`;
  }
  return output;
}

function createGeneratedOutput({ sourceType, sourceValue, material }) {
  const coverTheme = getTheme(state.coverTheme);
  const innerTheme = getTheme(state.innerTheme);
  const pageCount = getPageCount();
  const domain = getOptionalContext("domainInput", "未指定，系统按素材自动判断");
  const audience = getOptionalContext("audienceInput", "未指定，系统按素材自动判断");
  const sourceTitle = material?.title || sourceValue || "这篇内容";
  const shortSource = String(sourceTitle).replace(/^https?:\/\/\S+/i, "这篇文章").slice(0, 16);
  const title = `${shortSource}怎么改`;
  const summary =
    audience.startsWith("未指定")
      ? "把素材拆成问题、方法、行动和提醒四层，先判断读者为什么需要，再改写成更适合图文卡片传播的内容。"
      : `面向${audience}，把素材拆成问题、方法、行动和提醒四层，让内容更贴近真实使用场景。`;
  const domainTag = domain.startsWith("未指定") ? "内容改写" : domain.replace(/[^\p{Letter}\p{Number}]+/gu, "").slice(0, 8);
  const tags = [domainTag, "图文卡片", "方法论", "行动清单", "内容自动化", "ClaudeCode"].filter(Boolean);

  const cards = [
    {
      page: 1,
      theme: coverTheme,
      title: shortSource,
      body: "别急着照搬原文。先把它拆成读者关心的问题、能复用的方法和需要规避的表达风险。",
      label: "封面",
    },
    {
      page: 2,
      theme: innerTheme,
      title: "先找核心问题",
      body: "一篇素材能不能改，先看它是否有明确对象、明确痛点和明确场景。三者越清楚，越适合切成图文。",
      label: "认知对齐",
    },
    {
      page: 3,
      theme: innerTheme,
      title: "再提炼方法",
      body: "把原文里的观点、步骤、案例和数据拆出来，保留可执行部分，弱化空泛判断和重复铺垫。",
      label: "核心干货",
    },
    {
      page: 4,
      theme: innerTheme,
      title: "然后改成行动",
      body: "每一页都尽量回答一个问题：读者看完这一页，下一步能做什么、判断什么或避免什么。",
      label: "核心干货",
    },
    {
      page: 5,
      theme: innerTheme,
      title: "流程比工具重要",
      body: "稳定的价值评估、合规预检和卡片切分流程，比单次灵感更可靠，也更适合长期沉淀素材库。",
      label: "总结",
    },
  ].slice(0, pageCount);

  if (pageCount === 3) {
    cards[1].title = "三步改写";
    cards[1].body = "先找核心问题，再提炼方法，最后改成行动清单。少做无效堆叠，多保留读者能用的部分。";
    cards[2].title = "用流程提效";
    cards[2].body = "AI 负责整理信息，人负责判断取舍。这个分工更适合持续运营素材库。";
  }

  if (pageCount === 7) {
    cards.splice(
      4,
      0,
      {
        page: 5,
        theme: innerTheme,
        title: "检查风险点",
        body: "如果原文依赖夸张承诺、绝对化表达或低门槛高收益叙事，就先停下来，改成更稳妥的事实表达。",
        label: "风险过滤",
      },
      {
        page: 6,
        theme: innerTheme,
        title: "形成团队模板",
        body: "把提示词、评估表和输出格式固化下来，新同事也能按同一套标准处理素材。",
        label: "流程沉淀",
      },
    );
    cards[6].page = 7;
  }

  return {
    sourceType,
    sourceValue,
    title,
    summary,
    tags,
    cards,
    coverTheme,
    innerTheme,
    domain,
    audience,
    markdown: buildMarkdown({
      sourceType,
      sourceValue,
      title,
      summary,
      tags,
      cards,
      coverTheme,
      innerTheme,
      domain,
      audience,
    }),
  };
}

function getOptionalContext(inputId, fallback) {
  const value = document.getElementById(inputId)?.value.trim();
  return value || fallback;
}

function renderResult(output) {
  $("#titleOutput").value = output.title;
  $("#summaryOutput").value = output.summary;
  $("#tagOutput").innerHTML = output.tags.map((tag) => `<span>${tag}</span>`).join("");
  $("#cardPreviewGrid").innerHTML = output.cards.map(renderCard).join("");
  $("#editLinkList").innerHTML = renderMd2CardLinks(output);
  $("#exportPreview").textContent = output.markdown;
  $("#resultSourceBadge").textContent = `来源：${output.sourceType}`;
  $("#resultComplianceBadge").textContent = "合规：已预检";
  $("#complianceSummary").textContent = "合规：已通过";
  $("#cardSummary").textContent = `卡片：${output.cards.length} 张`;
}

function renderMd2CardLinks(output) {
  if (output.md2cardError) {
    return `<div class="empty-state compact">md2card 生成失败：${output.md2cardError}</div>`;
  }

  if (!output.md2card) {
    return '<div class="empty-state compact">md2card 正在等待生成。</div>';
  }

  return `
    <div class="edit-link-list">
      ${output.cards
        .map((card) => {
          const result = card.md2card || {};
          const imageLinks = (result.images || [])
            .map((image) => `<a href="${image.url}" target="_blank" rel="noopener noreferrer">${image.fileName || "下载图片"}</a>`)
            .join("");
          return `
            <div class="edit-link-item">
              <span>第 ${card.page} 页 · ${card.label}</span>
              <div class="md2card-actions">
                ${
                  result.previewUrl
                    ? `<a href="${result.previewUrl}" target="_blank" rel="noopener noreferrer">在线编辑</a>`
                    : "<span>暂无编辑链接</span>"
                }
                ${imageLinks}
              </div>
            </div>
          `;
        })
        .join("")}
      <div class="md2card-cost">md2card 消耗积分：${output.md2card.totalCost || 0}</div>
    </div>
  `;
}

function renderCard(card) {
  const images = getCardImages(card);
  if (images.length) {
    return images.map((image, index) => renderMd2CardImage(card, image, index)).join("");
  }

  return `
    <article class="preview-card ${card.theme.cardClass}">
      <span class="card-label">第 ${card.page} 页 · ${card.label}</span>
      <div>
        <h4>${card.title}</h4>
        <p>${card.body}</p>
      </div>
      <span class="card-label">${card.theme.name}</span>
    </article>
  `;
}

function getCardImages(card) {
  return (card.md2card?.images || []).filter((image) => image?.url);
}

function renderMd2CardImage(card, image, index) {
  const label = image.fileName || `第 ${card.page}${index ? `-${index + 1}` : ""} 张`;
  const title = `第 ${card.page} 页 · ${card.label || card.title}`;
  return `
    <figure class="md2card-image-card">
      <img
        src="${escapeAttribute(image.url)}"
        alt="${escapeAttribute(title)}"
        data-card-image="${escapeAttribute(image.url)}"
        data-card-title="${escapeAttribute(title)}"
        loading="lazy"
      />
      <figcaption>
        <span>${escapeHtml(title)}</span>
        <a href="${escapeAttribute(image.url)}" target="_blank" rel="noopener noreferrer">${label}</a>
      </figcaption>
    </figure>
  `;
}

function openImageLightbox(url, title) {
  if (!url) return;
  const dialog = $("#imageLightbox");
  const image = $("#lightboxImage");
  image.src = url;
  image.alt = title;
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function closeImageLightbox() {
  const dialog = $("#imageLightbox");
  if (dialog.open) dialog.close();
}

function escapeAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildFetchSummary(fetchResult) {
  const materials = fetchResult.materials || [];
  const summary = fetchResult.summary || {};
  const evaluations = fetchResult.evaluations || [];

  return `# 关键词抓取摘要

本次抓到 ${summary.fetched ?? 0} 篇，通过 ${summary.passed ?? materials.length} 篇，新增 ${summary.inserted ?? materials.length} 篇，重复 ${summary.duplicates ?? 0} 篇，淘汰 ${summary.rejected ?? 0} 篇。

${materials.map((item, index) => `${index + 1}. ${item.title}｜${item.value}${item.heat}｜${item.priority}`).join("\n")}

## 评估明细
${evaluations
  .map((item, index) => `${index + 1}. ${item.pass ? "通过" : "淘汰"}｜${item.title}｜${item.valueLabel}${item.heatLabel}｜${item.reason}`)
  .join("\n")}

下一步：在“待改写”中选择文章，开始合规预检和图文生成。`;
}

function buildMarkdown(output) {
  return `# ${output.title}

## 来源
- 输入方式：${output.sourceType}
- 内容：${output.sourceValue}

## 生成设置
- 内容领域：${output.domain}
- 目标受众：${output.audience}
- 封面主题：${output.coverTheme.name}
- 内页主题：${output.innerTheme.name}
- 卡片数量：${output.cards.length}
- 内容结构：后端自动判断，可能复合命中教程、方法论、行动清单或分析类

## 正文概述
${output.summary}

## 推荐标签
${output.tags.map((tag) => `#${tag}`).join(" ")}

## 卡片文案
${output.cards
  .map((card) => `### 第 ${card.page} 页：${card.title}\n${card.body}`)
  .join("\n\n")}

## 合规摘要
合规预检已在改写前执行，已规避夸张承诺、绝对化表达和平台背书。`;
}

async function copyPackage() {
  const text = state.output ? state.output.markdown : $("#exportPreview").textContent;
  try {
    await navigator.clipboard.writeText(text);
    $("#copyButton").textContent = "已复制";
    setTimeout(() => ($("#copyButton").textContent = "复制发布文案"), 1200);
  } catch {
    $("#exportPreview").focus();
  }
}

function downloadMarkdown() {
  const text = state.output ? state.output.markdown : $("#exportPreview").textContent;
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "ai-content-package.md";
  anchor.click();
  URL.revokeObjectURL(url);
}

init();
