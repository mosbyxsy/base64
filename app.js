"use strict";

/**
 * Pic64 核心脚本
 *
 * 数据流：文件/URL/Base64 → 浏览器 Image 与 Blob → 可选 Canvas 编辑
 *        → 预览、文件信息、下载文件或 Data URL。
 * 所有数据只保存在当前页面内存中，不会提交到服务器。
 */

/** 查询单个 DOM 元素的简写；页面脚本通过 defer 确保此时 DOM 已完成解析。 */
const $ = (selector) => document.querySelector(selector);

/**
 * 页面元素引用表。
 * 集中缓存节点可避免在每次交互时重复查询 DOM，也便于核对 HTML 与脚本绑定关系。
 */
const elements = {
  fileInput: $("#file-input"),
  dropZone: $("#drop-zone"),
  urlConvertForm: $("#url-convert-form"),
  imageUrl: $("#image-url"),
  urlConvertButton: $("#url-convert-button"),
  urlMessage: $("#url-message"),
  editorModal: $("#editor-modal"),
  editorBackdrop: $("#editor-backdrop"),
  imageEditor: $("#image-editor"),
  openEditorButton: $("#open-editor-button"),
  closeEditorButton: $("#close-editor-button"),
  cropStage: $("#crop-stage"),
  cropCanvas: $("#crop-canvas"),
  cropRatio: $("#crop-ratio"),
  outputFormat: $("#output-format"),
  outputWidth: $("#output-width"),
  qualityControl: $("#quality-control"),
  outputQuality: $("#output-quality"),
  qualityValue: $("#quality-value"),
  editStatus: $("#edit-status"),
  resetCropButton: $("#reset-crop-button"),
  applyCloseButton: $("#apply-close-button"),
  encodePreviewPanel: $("#encode-preview-panel"),
  encodePreview: $("#encode-preview"),
  previewStateRow: $("#preview-state-row"),
  previewStateLabel: $("#preview-state-label"),
  restoreOriginalButton: $("#restore-original-button"),
  fileName: $("#file-name"),
  imageDimensions: $("#image-dimensions"),
  fileSize: $("#file-size"),
  fileType: $("#file-type"),
  base64Output: $("#base64-output"),
  outputSize: $("#output-size"),
  copyButton: $("#copy-button"),
  saveTextButton: $("#save-text-button"),
  downloadEditedButton: $("#download-edited-button"),
  encodeClearButton: $("#encode-clear-button"),
  base64Input: $("#base64-input"),
  inputSize: $("#input-size"),
  decodeButton: $("#decode-button"),
  decodeMessage: $("#decode-message"),
  decodeResult: $("#decode-result"),
  decodePreview: $("#decode-preview"),
  decodedDimensions: $("#decoded-dimensions"),
  decodedSize: $("#decoded-size"),
  decodedType: $("#decoded-type"),
  decodedBase64Size: $("#decoded-base64-size"),
  decodedState: $("#decoded-state"),
  decodedStateTitle: $("#decoded-state-title"),
  decodedStateCopy: $("#decoded-state-copy"),
  restoreDecodedButton: $("#restore-decoded-button"),
  convertDecodedButton: $("#convert-decoded-button"),
  editDecodedButton: $("#edit-decoded-button"),
  downloadImageButton: $("#download-image-button"),
  decodeClearButton: $("#decode-clear-button"),
  toast: $("#toast"),
};

/* ---------- 运行时状态 ---------- */

/* 左侧当前输出：用于下载图片和命名 Base64 文本文件。 */
let encodedFileName = "image";
let encodedBlob = null;
let encodedDownloadName = "image.png";

/* 右侧当前解码/编辑结果及其 Object URL；旧 URL 必须及时释放以避免内存泄漏。 */
let decodedBlob = null;
let decodedObjectUrl = "";

/* Toast 定时器保证连续提示时只保留最后一次自动关闭任务。 */
let toastTimer = null;

/* 共享编辑器当前载入的图片、原始体积、文件名和归一化裁剪框。 */
let sourceImage = null;
let sourceFileSize = 0;
let sourceBaseName = "image";
let cropRect = { x: 0, y: 0, width: 1, height: 1 };
let cropDragStart = null;

/* 弹窗关闭后将焦点还给触发按钮，保证键盘操作连续。 */
let editorReturnFocus = null;

/* 左侧原图快照，用于“恢复原图”；Image 对象与 Data URL 保留在内存中。 */
let originalFile = null;
let originalDataUrl = "";
let encodeOriginalImage = null;

/* 编辑器上下文决定应用结果写回左侧编码区还是右侧解码区。 */
let editorContext = "encode";

/* 右侧原始解码结果，用于编辑后还原，并保留原始 Base64 大小。 */
let decodedOriginalBlob = null;
let decodedOriginalBase64Size = "";

/**
 * 将字节数格式化为适合界面显示的 B/KB/MB/GB。
 * @param {number} bytes 原始字节数。
 * @returns {string} 自动选择单位并控制小数位的文本。
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

/** 使用 Blob 的 UTF-8 编码规则计算字符串真实字节数。 */
function stringByteSize(value) {
  return new Blob([value]).size;
}

/** 显示短暂的全局提示；重复调用会重置隐藏计时。 */
function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 2200);
}

/**
 * 触发浏览器下载 Blob。
 * 临时 Object URL 在点击完成后延迟释放，确保浏览器有时间读取内容。
 */
function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 将 URL/Data URL 载入为 Image，并以 Promise 暴露尺寸读取结果。 */
function loadImageSource(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取图片内容"));
    image.src = source;
  });
}

/** 使用 FileReader 将 File 或 Blob 转成包含 MIME 前缀的 Data URL。 */
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("文件读取失败，请重试"));
    reader.readAsDataURL(file);
  });
}

/**
 * 把左侧当前文件完整写入界面：预览、文件信息、Base64 和操作按钮状态。
 * 此函数只更新“当前结果”，不会覆盖用于恢复的原图快照。
 */
function displayEncodedResult(file, dataUrl, image) {
  encodedFileName = file.name.replace(/\.[^.]+$/, "") || "image";
  encodedBlob = file;
  encodedDownloadName = file.name;
  elements.encodePreview.src = dataUrl;
  elements.fileName.textContent = file.name;
  elements.fileName.title = file.name;
  elements.imageDimensions.textContent = `${image.naturalWidth} × ${image.naturalHeight} px`;
  elements.fileSize.textContent = formatBytes(file.size);
  elements.fileType.textContent = file.type || "未知";
  elements.base64Output.value = dataUrl;
  elements.outputSize.textContent = `${formatBytes(stringByteSize(dataUrl))} · ${dataUrl.length.toLocaleString()} 字符`;
  elements.encodePreviewPanel.classList.remove("is-hidden");
  elements.copyButton.disabled = false;
  elements.openEditorButton.disabled = false;
  elements.saveTextButton.disabled = false;
  elements.downloadEditedButton.disabled = false;
  elements.encodeClearButton.disabled = false;
}

/** 切换左侧“原图/已编辑”状态，并控制恢复按钮是否可用。 */
function setPreviewState(isEdited) {
  elements.previewStateRow.classList.toggle("is-edited", isEdited);
  elements.previewStateLabel.textContent = isEdited ? "当前为编辑后的图片" : "当前为原始图片";
  elements.restoreOriginalButton.disabled = !isEdited;
}

/** 将 0~1 的归一化裁剪框换算成当前预览 Canvas 的像素坐标。 */
function cropPixels() {
  return {
    x: cropRect.x * elements.cropCanvas.width,
    y: cropRect.y * elements.cropCanvas.height,
    width: cropRect.width * elements.cropCanvas.width,
    height: cropRect.height * elements.cropCanvas.height,
  };
}

/**
 * 重绘裁剪 Canvas。
 * 图片会等比缩放到弹窗可用区域，并在选区外绘制暗色遮罩、边框和三分线。
 */
function renderCropCanvas() {
  if (!sourceImage) return;
  const availableWidth = Math.max(240, Math.min(520, elements.cropStage.clientWidth - 24 || 480));
  const scale = Math.min(1, availableWidth / sourceImage.naturalWidth, 290 / sourceImage.naturalHeight);
  const width = Math.max(1, Math.round(sourceImage.naturalWidth * scale));
  const height = Math.max(1, Math.round(sourceImage.naturalHeight * scale));
  const canvas = elements.cropCanvas;
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  context.clearRect(0, 0, width, height);
  context.drawImage(sourceImage, 0, 0, width, height);

  const selection = cropPixels();
  context.fillStyle = "rgba(15, 23, 20, 0.58)";
  context.fillRect(0, 0, width, selection.y);
  context.fillRect(0, selection.y, selection.x, selection.height);
  context.fillRect(selection.x + selection.width, selection.y, width - selection.x - selection.width, selection.height);
  context.fillRect(0, selection.y + selection.height, width, height - selection.y - selection.height);

  context.strokeStyle = "#d7f34a";
  context.lineWidth = 2;
  context.strokeRect(selection.x + 1, selection.y + 1, selection.width - 2, selection.height - 2);
  context.strokeStyle = "rgba(255, 255, 255, 0.62)";
  context.lineWidth = 1;
  for (let index = 1; index < 3; index += 1) {
    const vertical = selection.x + (selection.width * index) / 3;
    const horizontal = selection.y + (selection.height * index) / 3;
    context.beginPath();
    context.moveTo(vertical, selection.y);
    context.lineTo(vertical, selection.y + selection.height);
    context.moveTo(selection.x, horizontal);
    context.lineTo(selection.x + selection.width, horizontal);
    context.stroke();
  }
}

/**
 * 按当前比例重置裁剪框。
 * 固定比例会以图片中心为基准取最大可用矩形，自由裁剪则选中整张图片。
 */
function resetCropSelection() {
  const ratio = elements.cropRatio.value === "free" ? 0 : Number(elements.cropRatio.value);
  if (!ratio || !sourceImage) {
    cropRect = { x: 0, y: 0, width: 1, height: 1 };
  } else {
    const imageRatio = sourceImage.naturalWidth / sourceImage.naturalHeight;
    if (imageRatio > ratio) {
      const width = ratio / imageRatio;
      cropRect = { x: (1 - width) / 2, y: 0, width, height: 1 };
    } else {
      const height = imageRatio / ratio;
      cropRect = { x: 0, y: (1 - height) / 2, width: 1, height };
    }
  }
  renderCropCanvas();
  elements.editStatus.textContent = "调整参数后应用，Base64 将同步更新";
}

/** PNG 为无损格式，因此选择 PNG 时禁用质量滑杆。 */
function updateQualityControl() {
  const supportsQuality = elements.outputFormat.value !== "image/png";
  elements.outputQuality.disabled = !supportsQuality;
  elements.qualityControl.classList.toggle("is-disabled", !supportsQuality);
}

/** 打开共享编辑弹窗，记录触发元素并在布局稳定后重绘 Canvas。 */
function openEditorModal(trigger = document.activeElement) {
  if (!sourceImage) return;
  editorReturnFocus = trigger instanceof HTMLElement ? trigger : null;
  elements.editorModal.classList.remove("is-hidden");
  document.body.classList.add("modal-open");
  window.requestAnimationFrame(() => {
    renderCropCanvas();
    elements.closeEditorButton.focus();
  });
}

/** 关闭编辑弹窗、解除页面滚动锁定，并恢复打开前的键盘焦点。 */
function closeEditorModal() {
  if (elements.editorModal.classList.contains("is-hidden")) return;
  elements.editorModal.classList.add("is-hidden");
  document.body.classList.remove("modal-open");
  if (editorReturnFocus?.isConnected) editorReturnFocus.focus();
  editorReturnFocus = null;
}

/**
 * 处理编辑弹窗的键盘交互：Escape 关闭，Tab/Shift+Tab 在弹窗内循环焦点。
 */
function handleEditorKeyboard(event) {
  if (elements.editorModal.classList.contains("is-hidden")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeEditorModal();
    return;
  }
  if (event.key !== "Tab") return;

  const focusable = [...elements.imageEditor.querySelectorAll(
    'button:not(:disabled), select:not(:disabled), input:not(:disabled), canvas[tabindex]',
  )];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * 为共享编辑器装载新的源图片并重置全部编辑参数。
 * @param {File} file 用于类型、体积和输出文件名。
 * @param {HTMLImageElement} image 已成功解码的源图片。
 * @param {string} dataUrl 源图片 Data URL，仅左侧上下文用于恢复。
 * @param {"encode"|"decode"} context 应用结果的目标区域。
 */
function initializeEditor(file, image, dataUrl, context = "encode") {
  sourceImage = image;
  sourceFileSize = file.size;
  sourceBaseName = file.name.replace(/\.[^.]+$/, "") || "image";
  editorContext = context;
  if (context === "encode") {
    originalFile = file;
    originalDataUrl = dataUrl;
    encodeOriginalImage = image;
  }
  const supportedSourceType = ["image/png", "image/jpeg", "image/webp"].includes(file.type);
  elements.outputFormat.value = supportedSourceType ? file.type : "image/png";
  elements.outputWidth.value = "0";
  elements.outputQuality.value = "82";
  elements.qualityValue.value = "82%";
  elements.cropRatio.value = "free";
  updateQualityControl();
  resetCropSelection();
}

/**
 * 读取本地/远程构造的图片 File，生成左侧预览与 Base64，并建立原图快照。
 * @returns {Promise<boolean>} 是否成功完成读取和界面更新。
 */
async function handleImageFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    showToast("请选择有效的图片文件");
    return false;
  }

  try {
    const dataUrl = await readFileAsDataUrl(file);
    const image = await loadImageSource(dataUrl);
    displayEncodedResult(file, dataUrl, image);
    initializeEditor(file, image, dataUrl, "encode");
    setPreviewState(false);
    return true;
  } catch (error) {
    showToast(error.message);
    return false;
  }
}

/** 显示线上图片读取结果，并按成功/错误切换提示样式。 */
function showUrlMessage(message, isError = false) {
  elements.urlMessage.textContent = message;
  elements.urlMessage.classList.toggle("is-error", isError);
  elements.urlMessage.classList.remove("is-hidden");
}

/** 从 URL 路径提取安全文件名；缺少扩展名时根据 MIME 类型补全。 */
function fileNameFromUrl(url, mimeType) {
  let fileName = "online-image";
  const pathName = url.pathname.split("/").filter(Boolean).pop();
  if (pathName) {
    try {
      fileName = decodeURIComponent(pathName);
    } catch {
      fileName = pathName;
    }
  }
  fileName = fileName.replace(/[\\/:*?"<>|]/g, "-");
  if (!/\.[a-z0-9]{2,5}$/i.test(fileName)) fileName += `.${extensionForMime(mimeType)}`;
  return fileName;
}

/**
 * 通过 fetch 读取线上图片并转交给统一文件处理流程。
 * 浏览器 CORS 策略要求远端响应允许当前页面跨域读取。
 */
async function convertImageUrl() {
  const rawUrl = elements.imageUrl.value.trim();
  let url;

  try {
    url = new URL(rawUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch {
    showUrlMessage("请输入以 http:// 或 https:// 开头的有效图片链接", true);
    return;
  }

  const originalLabel = elements.urlConvertButton.textContent;
  elements.urlConvertButton.disabled = true;
  elements.urlConvertButton.textContent = "正在读取…";
  elements.urlMessage.classList.add("is-hidden");

  try {
    const response = await fetch(url.href, {
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) throw new Error(`图片请求失败（HTTP ${response.status}）`);

    const sourceBlob = await response.blob();
    if (!sourceBlob.size) throw new Error("图片内容为空");
    let mimeType = sourceBlob.type.split(";")[0].toLowerCase();

    if (!mimeType.startsWith("image/")) {
      const head = new Uint8Array(await sourceBlob.slice(0, 300).arrayBuffer());
      mimeType = detectImageType(head);
    }
    if (!mimeType) throw new Error("链接返回的内容不是可识别的图片");

    const file = new File([sourceBlob], fileNameFromUrl(url, mimeType), { type: mimeType });
    const succeeded = await handleImageFile(file);
    if (!succeeded) throw new Error("无法读取该链接中的图片");
    showUrlMessage("线上图片已读取并转换为 Base64");
  } catch (error) {
    const isNetworkError = error instanceof TypeError;
    showUrlMessage(
      isNetworkError
        ? "浏览器无法读取该链接，请确认图片可公开访问且网站允许跨域（CORS）"
        : error.message,
      true,
    );
  } finally {
    elements.urlConvertButton.textContent = originalLabel;
    elements.urlConvertButton.disabled = !elements.imageUrl.value.trim();
  }
}

/** 清空左侧全部结果、原图快照和编辑状态，同时关闭可能打开的编辑器。 */
function clearEncode() {
  closeEditorModal();
  elements.fileInput.value = "";
  elements.imageUrl.value = "";
  elements.urlConvertButton.disabled = true;
  elements.urlMessage.classList.add("is-hidden");
  elements.encodePreview.removeAttribute("src");
  elements.encodePreviewPanel.classList.add("is-hidden");
  sourceImage = null;
  sourceFileSize = 0;
  cropDragStart = null;
  encodedBlob = null;
  originalFile = null;
  originalDataUrl = "";
  encodeOriginalImage = null;
  elements.base64Output.value = "";
  elements.outputSize.textContent = "等待选择图片";
  elements.copyButton.disabled = true;
  elements.openEditorButton.disabled = true;
  elements.saveTextButton.disabled = true;
  elements.downloadEditedButton.disabled = true;
  elements.encodeClearButton.disabled = true;
  setPreviewState(false);
}

/** 使用内存中的原始 File/Data URL 恢复左侧预览、信息和 Base64。 */
function restoreOriginalImage() {
  if (!originalFile || !originalDataUrl || !encodeOriginalImage) return;
  displayEncodedResult(originalFile, originalDataUrl, encodeOriginalImage);
  initializeEditor(originalFile, encodeOriginalImage, originalDataUrl, "encode");
  setPreviewState(false);
  elements.editStatus.textContent = "已恢复原图，编辑参数也已重置";
  showToast("已恢复原图");
}

/** 将指针的视口坐标换算为 Canvas 内 0~1 的归一化坐标。 */
function canvasPoint(event) {
  const bounds = elements.cropCanvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
    y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
  };
}

/** 开始新裁剪拖拽，并保存旧选区以便无效拖拽时回退。 */
function beginCropDrag(event) {
  if (!sourceImage) return;
  const point = canvasPoint(event);
  cropDragStart = { ...point, previous: { ...cropRect } };
  elements.cropCanvas.setPointerCapture(event.pointerId);
}

/**
 * 根据指针移动更新裁剪框。
 * 固定比例时会结合源图片宽高比，把视觉比例换算为归一化坐标比例。
 */
function updateCropDrag(event) {
  if (!cropDragStart || !sourceImage) return;
  const point = canvasPoint(event);
  const deltaX = point.x - cropDragStart.x;
  const deltaY = point.y - cropDragStart.y;
  let width = Math.abs(deltaX);
  let height = Math.abs(deltaY);
  const ratio = elements.cropRatio.value === "free" ? 0 : Number(elements.cropRatio.value);

  if (ratio && width > 0 && height > 0) {
    const imageRatio = sourceImage.naturalWidth / sourceImage.naturalHeight;
    const normalizedRatio = ratio / imageRatio;
    if (width / height > normalizedRatio) width = height * normalizedRatio;
    else height = width / normalizedRatio;
  }

  cropRect = {
    x: deltaX < 0 ? cropDragStart.x - width : cropDragStart.x,
    y: deltaY < 0 ? cropDragStart.y - height : cropDragStart.y,
    width,
    height,
  };
  renderCropCanvas();
}

/** 结束裁剪拖拽；过小的误操作选区会恢复为拖拽前状态。 */
function endCropDrag(event) {
  if (!cropDragStart) return;
  if (elements.cropCanvas.hasPointerCapture(event.pointerId)) {
    elements.cropCanvas.releasePointerCapture(event.pointerId);
  }
  if (cropRect.width < 0.015 || cropRect.height < 0.015) cropRect = cropDragStart.previous;
  cropDragStart = null;
  renderCropCanvas();
}

/** 使用方向键移动裁剪框；按住 Shift 时采用更大的移动步长。 */
function moveCropWithKeyboard(event) {
  const directions = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  if (!directions[event.key] || !sourceImage) return;
  event.preventDefault();
  const step = event.shiftKey ? 0.03 : 0.008;
  const [horizontal, vertical] = directions[event.key];
  cropRect.x = Math.min(1 - cropRect.width, Math.max(0, cropRect.x + horizontal * step));
  cropRect.y = Math.min(1 - cropRect.height, Math.max(0, cropRect.y + vertical * step));
  renderCropCanvas();
}

/** 将 Canvas 的回调式 toBlob API 包装为 Promise，便于编辑流程顺序执行。 */
function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("图片处理失败，请尝试减小输出尺寸"))),
      mimeType,
      quality,
    );
  });
}

/**
 * 应用裁剪、缩放、格式和质量设置。
 * JPEG 不支持透明度，因此在绘制前填充白色背景；完成后根据 editorContext
 * 将结果写回左侧编码区或右侧解码区，并关闭弹窗。
 */
async function applyImageEdits() {
  if (!sourceImage) return;
  const closeLabel = elements.applyCloseButton.textContent;
  elements.applyCloseButton.disabled = true;
  elements.applyCloseButton.textContent = "正在处理…";

  try {
    const sourceWidth = sourceImage.naturalWidth;
    const sourceHeight = sourceImage.naturalHeight;
    const sourceX = Math.round(cropRect.x * sourceWidth);
    const sourceY = Math.round(cropRect.y * sourceHeight);
    const cropWidth = Math.max(1, Math.round(cropRect.width * sourceWidth));
    const cropHeight = Math.max(1, Math.round(cropRect.height * sourceHeight));
    const maxWidth = Number(elements.outputWidth.value);
    const outputWidth = maxWidth ? Math.min(cropWidth, maxWidth) : cropWidth;
    const outputHeight = Math.max(1, Math.round((outputWidth / cropWidth) * cropHeight));
    const mimeType = elements.outputFormat.value;
    const quality = Number(elements.outputQuality.value) / 100;

    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = outputWidth;
    outputCanvas.height = outputHeight;
    const context = outputCanvas.getContext("2d");
    if (mimeType === "image/jpeg") {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, outputWidth, outputHeight);
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      sourceImage,
      sourceX,
      sourceY,
      Math.min(cropWidth, sourceWidth - sourceX),
      Math.min(cropHeight, sourceHeight - sourceY),
      0,
      0,
      outputWidth,
      outputHeight,
    );

    const blob = await canvasToBlob(outputCanvas, mimeType, quality);
    const actualType = blob.type || mimeType;
    const fileName = `${sourceBaseName}-edited.${extensionForMime(actualType)}`;
    const file = new File([blob], fileName, { type: actualType });
    const dataUrl = await readFileAsDataUrl(file);
    const outputImage = await loadImageSource(dataUrl);
    if (editorContext === "decode") {
      showDecodedResult(blob, outputImage, "待转换");
      setDecodedState(true);
    } else {
      displayEncodedResult(file, dataUrl, outputImage);
      setPreviewState(true);
    }

    const difference = sourceFileSize ? ((blob.size - sourceFileSize) / sourceFileSize) * 100 : 0;
    const sizeChange = difference <= 0
      ? `比原图小 ${Math.abs(difference).toFixed(1)}%`
      : `比原图大 ${difference.toFixed(1)}%`;
    elements.editStatus.textContent = `已生成 ${outputWidth} × ${outputHeight} px · ${formatBytes(blob.size)} · ${sizeChange}`;
    showToast(editorContext === "decode"
      ? "右侧图片已修改，可还原或转为 Base64"
      : "图片编辑已应用，Base64 已更新");
    closeEditorModal();
  } catch (error) {
    elements.editStatus.textContent = error.message || "图片处理失败，请重试";
    showToast(elements.editStatus.textContent);
  } finally {
    elements.applyCloseButton.textContent = closeLabel;
    elements.applyCloseButton.disabled = false;
  }
}

/**
 * 清理并校验 Base64 输入，兼容 Data URL、纯 Base64 和 URL-safe 字符。
 * 返回解码后的字节数组、最终 MIME 类型和补齐 padding 的载荷。
 */
function normalizeBase64(value) {
  const cleaned = value.trim().replace(/\s/g, "");
  if (!cleaned) throw new Error("请先粘贴 Base64 内容");

  let mimeType = "";
  let payload = cleaned;
  const dataUrlMatch = cleaned.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/i);

  if (dataUrlMatch) {
    mimeType = dataUrlMatch[1] || "";
    payload = dataUrlMatch[2];
  } else if (cleaned.startsWith("data:")) {
    throw new Error("这不是有效的 Base64 Data URL");
  }

  payload = payload.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = payload.length % 4;
  if (remainder === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    throw new Error("Base64 格式有误，请检查内容是否完整");
  }
  if (remainder) payload += "=".repeat(4 - remainder);

  let binary;
  try {
    binary = atob(payload);
  } catch {
    throw new Error("Base64 解码失败，请检查输入内容");
  }

  if (!binary.length) throw new Error("Base64 内容为空");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const detectedType = detectImageType(bytes);
  mimeType = mimeType.toLowerCase();

  if (!mimeType.startsWith("image/")) mimeType = detectedType;
  if (!mimeType) throw new Error("无法识别图片格式，请粘贴带 data:image/... 前缀的内容");

  return { bytes, mimeType, payload };
}

/**
 * 根据文件头魔数识别常见图片格式；SVG 通过前 300 字节文本特征识别。
 * 该检测用于纯 Base64 或服务器返回 application/octet-stream 的场景。
 */
function detectImageType(bytes) {
  const begins = (...values) => values.every((value, index) => bytes[index] === value);
  if (begins(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (begins(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (begins(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (begins(0x42, 0x4d)) return "image/bmp";
  if (
    bytes.length > 11 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) return "image/webp";
  if (begins(0x00, 0x00, 0x01, 0x00)) return "image/x-icon";

  const head = new TextDecoder().decode(bytes.slice(0, 300)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return "";
}

/** 把图片 MIME 类型映射为适合下载文件名的扩展名。 */
function extensionForMime(mimeType) {
  const extensions = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/x-icon": "ico",
    "image/avif": "avif",
  };
  return extensions[mimeType] || mimeType.split("/")[1]?.replace("+xml", "") || "png";
}

/** 显示 Base64 解码错误并隐藏旧结果，避免用户误用过期图片。 */
function showDecodeError(message) {
  elements.decodeMessage.textContent = message;
  elements.decodeMessage.classList.remove("is-hidden");
  elements.decodeResult.classList.add("is-hidden");
}

/**
 * 将右侧当前 Blob 写入预览和信息区。
 * 每次替换图片前释放旧 Object URL，防止连续编辑造成内存累积。
 */
function showDecodedResult(blob, image, base64SizeLabel) {
  if (decodedObjectUrl) URL.revokeObjectURL(decodedObjectUrl);
  decodedObjectUrl = URL.createObjectURL(blob);
  decodedBlob = blob;
  elements.decodePreview.src = decodedObjectUrl;
  elements.decodedDimensions.textContent = `${image.naturalWidth} × ${image.naturalHeight} px`;
  elements.decodedSize.textContent = formatBytes(blob.size);
  elements.decodedType.textContent = blob.type || "未知";
  elements.decodedBase64Size.textContent = base64SizeLabel;
  elements.decodeResult.classList.remove("is-hidden");
}

/** 切换右侧原始/已修改状态，并控制还原和“转为 Base64”按钮。 */
function setDecodedState(isEdited) {
  elements.decodedState.classList.toggle("is-edited", isEdited);
  elements.decodedStateTitle.textContent = isEdited ? "图片已被修改" : "图片已准备好";
  elements.decodedStateCopy.textContent = isEdited
    ? "可还原原始图片，或转为新的 Base64"
    : "可继续裁剪、压缩或转换格式";
  elements.restoreDecodedButton.disabled = !isEdited;
  elements.convertDecodedButton.classList.toggle("is-hidden", !isEdited);
  if (isEdited) elements.decodedBase64Size.textContent = "待转换";
  else if (decodedOriginalBase64Size) elements.decodedBase64Size.textContent = decodedOriginalBase64Size;
}

/** 从保存的原始解码 Blob 恢复右侧图片及 Base64 大小。 */
async function restoreDecodedImage() {
  if (!decodedOriginalBlob) return;
  elements.restoreDecodedButton.disabled = true;
  try {
    const dataUrl = await readFileAsDataUrl(decodedOriginalBlob);
    const image = await loadImageSource(dataUrl);
    showDecodedResult(decodedOriginalBlob, image, decodedOriginalBase64Size);
    setDecodedState(false);
    showToast("右侧图片已还原");
  } catch (error) {
    showToast(error.message || "图片还原失败");
    elements.restoreDecodedButton.disabled = false;
  }
}

/**
 * 把右侧编辑结果作为新文件送入左侧编码流程。
 * 只有用户主动点击时才同步，避免右侧编辑无意覆盖左侧内容。
 */
async function convertDecodedToBase64() {
  if (!decodedBlob) return;
  const originalLabel = elements.convertDecodedButton.textContent;
  elements.convertDecodedButton.disabled = true;
  elements.convertDecodedButton.textContent = "正在转换…";
  try {
    const fileName = `pic64-edited.${extensionForMime(decodedBlob.type)}`;
    const file = new File([decodedBlob], fileName, { type: decodedBlob.type });
    const succeeded = await handleImageFile(file);
    if (!succeeded) throw new Error("转换 Base64 失败");
    elements.decodedBase64Size.textContent = formatBytes(stringByteSize(elements.base64Output.value));
    elements.decodedStateCopy.textContent = "已同步到左侧并生成新的 Base64，可随时还原";
    elements.encodePreviewPanel.scrollIntoView({ behavior: "smooth", block: "center" });
    showToast("修改后的图片已同步到左侧并生成 Base64");
  } catch (error) {
    showToast(error.message || "转换 Base64 失败");
  } finally {
    elements.convertDecodedButton.textContent = originalLabel;
    elements.convertDecodedButton.disabled = false;
  }
}

/** 校验并解码输入 Base64，建立可还原的右侧原始 Blob 快照。 */
async function decodeBase64() {
  elements.decodeMessage.classList.add("is-hidden");

  try {
    const originalInput = elements.base64Input.value.trim();
    const { bytes, mimeType } = normalizeBase64(originalInput);
    const blob = new Blob([bytes], { type: mimeType });
    const dataUrl = await readFileAsDataUrl(blob);
    const image = await loadImageSource(dataUrl);
    decodedOriginalBlob = blob;
    decodedOriginalBase64Size = formatBytes(stringByteSize(originalInput));
    showDecodedResult(blob, image, decodedOriginalBase64Size);
    setDecodedState(false);
  } catch (error) {
    decodedBlob = null;
    showDecodeError(error.message || "无法还原这段 Base64 内容");
  }
}

/** 清空右侧输入、预览、编辑快照和 Object URL，并将焦点返回输入框。 */
function clearDecode() {
  elements.base64Input.value = "";
  elements.inputSize.textContent = "0 B";
  elements.decodeButton.disabled = true;
  elements.decodeMessage.classList.add("is-hidden");
  elements.decodeResult.classList.add("is-hidden");
  elements.decodePreview.removeAttribute("src");
  decodedBlob = null;
  decodedOriginalBlob = null;
  decodedOriginalBase64Size = "";
  elements.decodedBase64Size.textContent = "—";
  setDecodedState(false);
  if (decodedObjectUrl) {
    URL.revokeObjectURL(decodedObjectUrl);
    decodedObjectUrl = "";
  }
  elements.base64Input.focus();
}

/** 将右侧当前图片载入共享编辑器，但不提前修改左侧编码结果。 */
async function openDecodedInEditor() {
  if (!decodedBlob) return;
  const originalLabel = elements.editDecodedButton.textContent;
  elements.editDecodedButton.disabled = true;
  elements.editDecodedButton.textContent = "正在打开…";

  try {
    const fileName = `pic64-restored.${extensionForMime(decodedBlob.type)}`;
    const file = new File([decodedBlob], fileName, { type: decodedBlob.type });
    const dataUrl = await readFileAsDataUrl(file);
    const image = await loadImageSource(dataUrl);
    initializeEditor(file, image, dataUrl, "decode");
    elements.editStatus.textContent = "编辑将作用于右侧图片，应用后可还原或转为 Base64";
    openEditorModal(elements.editDecodedButton);
    showToast("已在图片编辑器中打开");
  } catch (error) {
    showToast(error.message || "无法在编辑器中打开图片");
  } finally {
    elements.editDecodedButton.textContent = originalLabel;
    elements.editDecodedButton.disabled = false;
  }
}

/**
 * 复制左侧 Base64；优先使用现代 Clipboard API，失败时回退到 execCommand。
 */
async function copyOutput() {
  try {
    await navigator.clipboard.writeText(elements.base64Output.value);
    showToast("Base64 已复制");
  } catch {
    elements.base64Output.select();
    const copied = document.execCommand("copy");
    showToast(copied ? "Base64 已复制" : "复制失败，请手动复制");
  }
}

/* ---------- 本地文件与拖放事件 ---------- */

/* 点击自定义拖放区时代理点击隐藏的原生文件输入框。 */
elements.dropZone.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => handleImageFile(elements.fileInput.files[0]));

/* dragover 必须阻止默认行为，浏览器才允许后续 drop 事件接收文件。 */
["dragenter", "dragover"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("is-dragging");
  });
});

/* 离开或完成拖放时清理高亮状态，避免界面停留在拖入样式。 */
["dragleave", "drop"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("is-dragging");
  });
});

elements.dropZone.addEventListener("drop", (event) => handleImageFile(event.dataTransfer.files[0]));

/* ---------- 线上图片与左侧结果事件 ---------- */

/* URL 输入为空时禁用提交；每次修改同时移除上一条提示。 */
elements.imageUrl.addEventListener("input", () => {
  elements.urlConvertButton.disabled = !elements.imageUrl.value.trim();
  elements.urlMessage.classList.add("is-hidden");
});

/* 使用 form 的 submit 事件同时支持按钮点击和输入框回车。 */
elements.urlConvertForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (elements.imageUrl.value.trim()) convertImageUrl();
});

/* 左侧复制、下载、清空、恢复和打开编辑器。 */
elements.copyButton.addEventListener("click", copyOutput);
elements.saveTextButton.addEventListener("click", () => {
  const blob = new Blob([elements.base64Output.value], { type: "text/plain;charset=utf-8" });
  downloadBlob(blob, `${encodedFileName}-base64.txt`);
});
elements.downloadEditedButton.addEventListener("click", () => {
  if (encodedBlob) downloadBlob(encodedBlob, encodedDownloadName);
});
elements.encodeClearButton.addEventListener("click", clearEncode);
elements.restoreOriginalButton.addEventListener("click", restoreOriginalImage);
elements.openEditorButton.addEventListener("click", () => openEditorModal(elements.openEditorButton));

/* ---------- 编辑弹窗事件 ---------- */

/* 关闭按钮与背景遮罩使用相同的关闭逻辑。 */
elements.closeEditorButton.addEventListener("click", closeEditorModal);
elements.editorBackdrop.addEventListener("click", closeEditorModal);

/* Pointer Events 同时覆盖鼠标、触控笔和触摸屏裁剪操作。 */
elements.cropCanvas.addEventListener("pointerdown", beginCropDrag);
elements.cropCanvas.addEventListener("pointermove", updateCropDrag);
elements.cropCanvas.addEventListener("pointerup", endCropDrag);
elements.cropCanvas.addEventListener("pointercancel", endCropDrag);
elements.cropCanvas.addEventListener("keydown", moveCropWithKeyboard);
elements.cropRatio.addEventListener("change", resetCropSelection);
elements.resetCropButton.addEventListener("click", resetCropSelection);

/* 格式改变时同步质量控件状态，并给出 PNG 无损格式说明。 */
elements.outputFormat.addEventListener("change", () => {
  updateQualityControl();
  elements.editStatus.textContent = elements.outputFormat.value === "image/png"
    ? "PNG 为无损格式，不使用压缩质量参数"
    : "调整压缩质量后应用，数值越低文件通常越小";
});

/* 滑杆旁的 output 实时显示当前百分比。 */
elements.outputQuality.addEventListener("input", () => {
  elements.qualityValue.value = `${elements.outputQuality.value}%`;
});
elements.applyCloseButton.addEventListener("click", applyImageEdits);

/* ---------- Base64 解码与右侧结果事件 ---------- */

/* 实时显示输入体积；有有效内容时才允许执行解码。 */
elements.base64Input.addEventListener("input", () => {
  const value = elements.base64Input.value;
  elements.inputSize.textContent = `${formatBytes(stringByteSize(value))} · ${value.length.toLocaleString()} 字符`;
  elements.decodeButton.disabled = !value.trim();
  elements.decodeMessage.classList.add("is-hidden");
});

/* Ctrl/Cmd + Enter 为长 Base64 输入提供快捷提交方式。 */
elements.base64Input.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && elements.base64Input.value.trim()) {
    event.preventDefault();
    decodeBase64();
  }
});

elements.decodeButton.addEventListener("click", decodeBase64);
elements.decodeClearButton.addEventListener("click", clearDecode);
elements.editDecodedButton.addEventListener("click", openDecodedInEditor);
elements.restoreDecodedButton.addEventListener("click", restoreDecodedImage);
elements.convertDecodedButton.addEventListener("click", convertDecodedToBase64);
elements.downloadImageButton.addEventListener("click", () => {
  if (!decodedBlob) return;
  downloadBlob(decodedBlob, `pic64-restored.${extensionForMime(decodedBlob.type)}`);
});

/* ---------- 全局生命周期事件 ---------- */

/* 捕获弹窗 Escape/Tab 键盘交互。 */
document.addEventListener("keydown", handleEditorKeyboard);

/* 页面卸载前释放仍存活的 Blob URL。 */
window.addEventListener("beforeunload", () => {
  if (decodedObjectUrl) URL.revokeObjectURL(decodedObjectUrl);
});

/* 窗口尺寸变化后按新容器宽度重新绘制裁剪预览。 */
window.addEventListener("resize", renderCropCanvas);
