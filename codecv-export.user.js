// ==UserScript==
// @name         CodeCV 简历打印为无水印 PDF
// @namespace    local.codecv.print
// @version      1.2.0
// @description  将当前简历预览复制到独立打印页，保存为 PDF。
// @homepageURL  https://github.com/yangjj-iso/codecv-export
// @supportURL   https://github.com/yangjj-iso/codecv-export/issues
// @match        https://www.codecvcv.com/*
// @match        https://codecvcv.com/*
// @grant        none
// @noframes
// @sandbox      DOM
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const BUTTON_ID = 'codecv-local-print-button';
  const FRAME_ID = 'codecv-local-print-frame';
  const RESOURCE_TIMEOUT_MS = 15_000;
  if (window.top !== window.self || document.getElementById(BUTTON_ID)) return;

  let preparing = false;
  let activeFrame = null;

  // 只选取可见预览，避免模板缓存、隐藏预览抢占选择器。
  const findPreview = () => {
    for (const selector of ['.preview-cv .re-render', '.re-render']) {
      const preview = Array.from(document.querySelectorAll(selector)).find((node) => {
        const style = getComputedStyle(node);
        return node.getClientRects().length > 0
          && style.visibility !== 'hidden'
          && style.display !== 'none';
      });
      if (preview) return preview;
    }
    return null;
  };

  // 仅清理副本；不执行预览中的脚本或复制内联事件。
  const sanitize = (root) => {
    root.querySelectorAll('script, iframe, object, embed, base, meta, link').forEach((node) => node.remove());
    for (const node of [root, ...root.querySelectorAll('*')]) {
      const marker = `${node.id} ${node.getAttribute('class') || ''}`;
      if (/watermark/i.test(marker)) {
        node.remove();
        continue;
      }
      for (const attribute of Array.from(node.attributes)) {
        if (/^on/i.test(attribute.name)
          || (/^(?:href|src|xlink:href|action|formaction)$/i.test(attribute.name)
            && /^\s*(?:javascript|vbscript):/i.test(attribute.value))) {
          node.removeAttribute(attribute.name);
        }
      }
      node.removeAttribute('autofocus');
      node.removeAttribute('contenteditable');
    }
  };

  // 所有等待共用同一截止时间，错误或超时都不悄悄打印缺失资源的简历。
  const waitForResources = async (printDoc, stylesheetLoads) => {
    let timer;
    try {
      await Promise.race([
        (async () => {
          await Promise.all(stylesheetLoads);
          // 触发布局，让实际使用的字体进入 FontFaceSet 的加载队列。
          void printDoc.body.offsetHeight;
          await Promise.all([
            printDoc.fonts?.ready || Promise.resolve(),
            ...Array.from(printDoc.images, async (img) => {
              img.loading = 'eager';
              if (!img.complete) {
                await new Promise((resolve, reject) => {
                  img.addEventListener('load', resolve, { once: true });
                  img.addEventListener('error', () => reject(new Error('简历图片加载失败')), { once: true });
                });
              }
              if (!img.naturalWidth) throw new Error('简历图片加载失败');
              if (img.decode) await img.decode();
            }),
          ]);
          if (printDoc.fonts && Array.from(printDoc.fonts).some((font) => font.status === 'error')) {
            throw new Error('简历字体加载失败');
          }
        })(),
        new Promise((_, reject) => {
          timer = window.setTimeout(() => reject(new Error('等待打印资源超时（15 秒）')), RESOURCE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      window.clearTimeout(timer);
    }
  };

  const button = document.createElement('button');
  button.id = BUTTON_ID;
  button.type = 'button';
  button.textContent = '打印简历 PDF';
  button.title = '将当前可见的简历预览打印或保存为 PDF';
  Object.assign(button.style, {
    position: 'fixed',
    right: '16px',
    bottom: '16px',
    zIndex: '2147483647',
    padding: '10px 14px',
    border: '0',
    borderRadius: '8px',
    background: '#24292f',
    color: '#fff',
    cursor: 'pointer',
    boxShadow: '0 2px 10px #0003',
    font: '14px/1.4 sans-serif',
  });

  button.addEventListener('click', async () => {
    if (preparing) return;
    const preview = findPreview();
    if (!preview) {
      window.alert('没有找到简历预览。请先打开 CodeCV 的简历编辑页，并等待预览加载。');
      return;
    }

    preparing = true;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = '准备打印…';
    let frame;
    try {
      // 某些浏览器不发送 afterprint；下一次打印前回收旧页，最多保留一个。
      activeFrame?.remove();
      frame = document.createElement('iframe');
      activeFrame = frame;
      frame.id = FRAME_ID;
      frame.title = 'CodeCV 简历打印页';
      frame.setAttribute('aria-hidden', 'true');
      Object.assign(frame.style, {
        position: 'fixed',
        left: '-10000px',
        top: '0',
        width: '794px',
        height: '1123px',
        border: '0',
        opacity: '0',
        pointerEvents: 'none',
      });
      document.body.appendChild(frame);

      const printDoc = frame.contentDocument;
      if (!printDoc || !frame.contentWindow) throw new Error('无法创建打印页面');
      const base = printDoc.createElement('base');
      base.href = document.baseURI;
      printDoc.head.appendChild(base);
      printDoc.title = document.title || 'CodeCV 简历';
      for (const [source, target] of [[document.documentElement, printDoc.documentElement], [document.body, printDoc.body]]) {
        for (const attribute of Array.from(source.attributes)) {
          if (/^(?:class|style|id|dir|data-.+)$/.test(attribute.name)) {
            target.setAttribute(attribute.name, attribute.value);
          }
        }
      }
      printDoc.documentElement.lang = document.documentElement.lang || 'zh-CN';

      // 保留网站模板的原有样式，但不复制脚本或编辑器界面。
      const stylesheetLoads = [];
      document.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
        const clone = node.cloneNode(true);
        sanitize(clone);
        if (clone.tagName === 'LINK') {
          if (node.disabled) return;
          clone.href = node.href;
          stylesheetLoads.push(new Promise((resolve, reject) => {
            clone.addEventListener('load', resolve, { once: true });
            clone.addEventListener('error', () => reject(new Error('模板样式加载失败')), { once: true });
          }));
        }
        printDoc.head.appendChild(clone);
      });

      const copy = printDoc.importNode(preview, true);
      // cloneNode 不复制 canvas 位图；二维码、图表等需要单独复制。
      const canvases = copy.querySelectorAll('canvas');
      preview.querySelectorAll('canvas').forEach((canvas, index) => {
        if (canvas.width && canvas.height) canvases[index].getContext('2d')?.drawImage(canvas, 0, 0);
      });
      const images = copy.querySelectorAll('img');
      preview.querySelectorAll('img').forEach((img, index) => {
        images[index].loading = 'eager';
        // 固定当前已选中的头像资源，避免打印尺寸触发不同的 srcset。
        if (img.currentSrc) {
          images[index].src = img.currentSrc;
          images[index].removeAttribute('srcset');
          images[index].removeAttribute('sizes');
        }
      });
      copy.querySelectorAll('picture source').forEach((node) => node.remove());
      sanitize(copy);

      // 保留外层选择器、data-* 属性及继承的 CSS 变量，不复制编辑器兄弟节点。
      let content = copy;
      for (let parent = preview.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const wrapper = printDoc.importNode(parent, false);
        sanitize(wrapper);
        wrapper.setAttribute('data-codecv-print-wrapper', '');
        wrapper.appendChild(content);
        content = wrapper;
      }
      printDoc.body.appendChild(content);

      const printStyle = printDoc.createElement('style');
      printStyle.textContent = `
        @page { size: A4 portrait; margin: 0; }
        html, body { margin: 0 !important; padding: 0 !important;
          display: block !important; position: static !important;
          min-width: 0 !important; min-height: 0 !important;
          max-width: none !important; max-height: none !important;
          transform: none !important; zoom: 1 !important;
          width: 210mm !important; height: auto !important;
          overflow: visible !important; background: white !important; }
        [data-codecv-print-wrapper] { display: block !important;
          position: static !important; width: auto !important; height: auto !important;
          min-width: 0 !important; min-height: 0 !important;
          max-width: none !important; max-height: none !important;
          margin: 0 !important; padding: 0 !important;
          transform: none !important; zoom: 1 !important;
          overflow: visible !important; box-shadow: none !important;
          background: transparent !important; }
        .re-render { display: block !important; position: relative !important;
          top: auto !important; left: auto !important;
          width: 210mm !important; max-width: none !important;
          height: auto !important; max-height: none !important;
          box-sizing: border-box !important; overflow: visible !important;
          margin: 0 !important; transform: none !important; zoom: 1 !important;
          box-shadow: none !important; }
        [class*="watermark" i], [id*="watermark" i] { display: none !important; }
        .preview-cv::before, .preview-cv::after { content: none !important; }
        * { -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important; }
      `;
      printDoc.head.appendChild(printStyle);

      await waitForResources(printDoc, stylesheetLoads);

      // 不用固定计时器移除仍在打印的文档，用户可能长时间停留在打印对话框。
      frame.contentWindow.addEventListener('afterprint', () => {
        frame.remove();
        if (activeFrame === frame) activeFrame = null;
      }, { once: true });
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch (error) {
      frame?.remove();
      if (activeFrame === frame) activeFrame = null;
      console.error('[CodeCV print]', error);
      window.alert(`打印失败：${error.message || '未知错误'}。请等待预览完整加载后重试；仍失败可在控制台查看 [CodeCV print] 日志。`);
    } finally {
      preparing = false;
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = '打印简历 PDF';
    }
  });

  let observedBody;
  const syncButton = () => {
    if (!document.body) return;
    if (observedBody !== document.body) {
      bodyObserver.disconnect();
      observedBody = document.body;
      bodyObserver.observe(observedBody, { childList: true });
    }
    if (!button.isConnected) document.body.appendChild(button);
    const hidden = !/^\/cv(?:\/|$)/.test(location.pathname);
    if (button.hidden !== hidden) button.hidden = hidden;
  };
  const bodyObserver = new MutationObserver(syncButton);
  const rootObserver = new MutationObserver(syncButton);
  rootObserver.observe(document.documentElement, { childList: true });
  syncButton();
  document.addEventListener('DOMContentLoaded', syncButton, { once: true });
  window.addEventListener('popstate', syncButton);
  window.addEventListener('hashchange', syncButton);
  // 覆盖无 DOM 更新的 pushState/replaceState，不改写网站的 History API。
  window.setInterval(syncButton, 1_000);
  window.addEventListener('pagehide', () => {
    activeFrame?.remove();
    activeFrame = null;
  });
})();
