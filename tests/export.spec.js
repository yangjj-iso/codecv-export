const { test, expect } = require('@playwright/test');
const path = require('node:path');

const scriptPath = path.join(__dirname, '..', 'codecv-export.user.js');
const button = '#codecv-local-print-button';
const frameSelector = '#codecv-local-print-frame';
const fixture = `<!doctype html><html lang="zh-CN"><head>
  <title>测试简历</title>
  <style>
    :root { --resume-color: rgb(12, 34, 56); }
    .editor[data-theme="paper"] .preview-cv .resume-title { color: var(--resume-color); }
    .preview-cv { transform: scale(.8); height: 100px; overflow: hidden; }
    .re-render { width: 794px; padding: 24px; }
  </style>
  </head><body><main class="editor" data-theme="paper">
  <aside>不应导出的编辑器</aside><section class="preview-cv">
  <div class="re-render"><h1 class="resume-title">张三的简历</h1>
  <div class="WaterMark">测试水印</div><canvas width="8" height="8"></canvas>
  <p contenteditable="true" onclick="window.unwanted = true">项目经历</p>
  <a href="javascript:alert(1)">链接</a></div></section></main></body></html>`;

async function setup(page, html = fixture, pathname = '/cv/test') {
  await page.route('https://www.codecvcv.com/**', (route) => {
    if (new URL(route.request().url()).pathname === pathname) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    }
    return route.abort();
  });
  await page.goto(`https://www.codecvcv.com${pathname}`);
  await page.evaluate(() => {
    window.printCalls = 0;
    window.alertMessages = [];
    window.alert = (message) => window.alertMessages.push(message);
    new MutationObserver(() => {
      const frame = document.getElementById('codecv-local-print-frame');
      if (!frame || frame.dataset.testHook) return;
      frame.dataset.testHook = 'ready';
      frame.contentWindow.print = () => {
        window.printCalls += 1;
        if (window.finishImmediately) frame.contentWindow.dispatchEvent(new Event('afterprint'));
      };
      frame.contentWindow.focus = () => {};
    }).observe(document.body, { childList: true });
  });
  await page.addScriptTag({ path: scriptPath });
}

test('保留样式上下文和 canvas，清理副本且不修改原始预览', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const context = document.querySelector('canvas').getContext('2d');
    context.fillStyle = 'rgb(255, 0, 0)';
    context.fillRect(0, 0, 8, 8);
  });
  const original = await page.locator('.preview-cv').innerHTML();
  await page.locator(button).click();
  await expect.poll(() => page.evaluate(() => window.printCalls)).toBe(1);
  const printed = page.frameLocator(frameSelector);
  await expect(printed.locator('.resume-title')).toHaveCSS('color', 'rgb(12, 34, 56)');
  await expect(printed.locator('.preview-cv')).toHaveCSS('transform', 'none');
  await expect(printed.locator('.WaterMark, aside, [onclick], [contenteditable], a[href]')).toHaveCount(0);
  expect(await printed.locator('canvas').evaluate((canvas) => [...canvas.getContext('2d').getImageData(0, 0, 1, 1).data])).toEqual([255, 0, 0, 255]);
  expect(await page.locator('.preview-cv').innerHTML()).toBe(original);
  expect(await printed.locator('html').getAttribute('lang')).toBe('zh-CN');
  await page.evaluate(() => document.querySelector('#codecv-local-print-frame').contentWindow.dispatchEvent(new Event('afterprint')));
  await expect(page.locator(frameSelector)).toHaveCount(0);
  await expect(page.locator(button)).toBeEnabled();
});

test('忽略隐藏的旧预览，使用可见预览', async ({ page }) => {
  await setup(page, fixture.replace('<main', '<div hidden class="re-render">旧简历</div><main'));
  await page.locator(button).click();
  await expect.poll(() => page.evaluate(() => window.printCalls)).toBe(1);
  await expect(page.frameLocator(frameSelector).locator('.re-render')).toContainText('张三的简历');
});

test('没有预览时给出提示，不创建打印页', async ({ page }) => {
  await setup(page, '<!doctype html><body><p>加载中</p></body>');
  await page.locator(button).click();
  expect(await page.evaluate(() => window.alertMessages[0])).toContain('没有找到简历预览');
  await expect(page.locator(frameSelector)).toHaveCount(0);
  await expect(page.locator(button)).toBeEnabled();
});

test('外部样式失败时提示错误并恢复按钮', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/missing.css';
    document.head.appendChild(link);
  });
  await page.locator(button).click();
  await expect.poll(() => page.evaluate(() => window.alertMessages.length)).toBe(1);
  expect(await page.evaluate(() => window.alertMessages[0])).toContain('模板样式加载失败');
  expect(await page.evaluate(() => window.printCalls)).toBe(0);
  await expect(page.locator(button)).toBeEnabled();
  await expect(page.locator(frameSelector)).toHaveCount(0);
});

test('图片失败时不打印，并允许修复后重试', async ({ page }) => {
  await setup(page, fixture.replace('<h1', '<img src="/missing.png"><h1'));
  await page.locator(button).click();
  await expect.poll(() => page.evaluate(() => window.alertMessages.length)).toBe(1);
  expect(await page.evaluate(() => window.alertMessages[0])).toContain('图片加载失败');
  expect(await page.evaluate(() => window.printCalls)).toBe(0);
  await expect(page.locator(frameSelector)).toHaveCount(0);
  await expect(page.locator(button)).toBeEnabled();
  await page.locator('.re-render img').evaluate((img) => img.remove());
  await page.locator(button).click();
  await expect.poll(() => page.evaluate(() => window.printCalls)).toBe(1);
});

test('等待懒加载图片，准备期间阻止重复点击', async ({ page }) => {
  await setup(page);
  let releaseImage;
  const imageReady = new Promise((resolve) => { releaseImage = resolve; });
  await page.route('**/slow.svg', async (route) => {
    await imageReady;
    await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>' });
  });
  await page.locator('.re-render').evaluate((preview) => {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = '/slow.svg';
    preview.appendChild(img);
  });
  await page.locator(button).click();
  await expect(page.locator(button)).toBeDisabled();
  await page.locator(button).dispatchEvent('click');
  expect(await page.evaluate(() => window.printCalls)).toBe(0);
  await expect(page.locator(frameSelector)).toHaveCount(1);
  releaseImage();
  await expect.poll(() => page.evaluate(() => window.printCalls)).toBe(1);
  expect(await page.frameLocator(frameSelector).locator('img').evaluate((img) => img.naturalWidth)).toBe(10);
});

test('资源超时后恢复按钮并移除打印页', async ({ page }) => {
  await setup(page);
  await page.clock.install();
  await page.route('**/hanging.svg', () => {});
  await page.locator('.re-render').evaluate((preview) => {
    const img = document.createElement('img');
    img.src = '/hanging.svg';
    preview.appendChild(img);
  });
  await page.locator(button).click();
  await expect(page.locator(button)).toBeDisabled();
  await page.clock.fastForward(16_000);
  await expect.poll(() => page.evaluate(() => window.alertMessages.length)).toBe(1);
  expect(await page.evaluate(() => window.alertMessages[0])).toContain('超时');
  expect(await page.evaluate(() => window.printCalls)).toBe(0);
  await expect(page.locator(button)).toBeEnabled();
  await expect(page.locator(frameSelector)).toHaveCount(0);
});

test('路由切换和 body 重建后按钮状态正确，重复注入不产生重复按钮', async ({ page }) => {
  await setup(page, fixture, '/');
  await expect(page.locator(button)).toBeHidden();
  await page.evaluate(() => history.pushState({}, '', '/cv/test'));
  await expect(page.locator(button)).toBeVisible();
  await page.addScriptTag({ path: scriptPath });
  await expect(page.locator(button)).toHaveCount(1);
  await page.evaluate(() => document.body.replaceWith(document.createElement('body')));
  await expect(page.locator(button)).toBeVisible();
  await page.locator(button).evaluate((node) => node.remove());
  await expect(page.locator(button)).toBeVisible();
  await page.evaluate(() => history.replaceState({}, '', '/templates'));
  await expect(page.locator(button)).toBeHidden();
});

test('没有 afterprint 时重复打印仍只保留一个 iframe', async ({ page }) => {
  await setup(page);
  await page.locator(button).click();
  await expect.poll(() => page.evaluate(() => window.printCalls)).toBe(1);
  await page.locator(button).click();
  await expect.poll(() => page.evaluate(() => window.printCalls)).toBe(2);
  await expect(page.locator(frameSelector)).toHaveCount(1);
});

test('同步 afterprint 后也可再次打印', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { window.finishImmediately = true; });
  for (let count = 1; count <= 2; count += 1) {
    await page.locator(button).click();
    await expect.poll(() => page.evaluate(() => window.printCalls)).toBe(count);
    await expect(page.locator(frameSelector)).toHaveCount(0);
    await expect(page.locator(button)).toBeEnabled();
  }
});
