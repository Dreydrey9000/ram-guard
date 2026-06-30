const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const dir = __dirname;
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  await p.goto('file://' + path.join(dir, 'icon.html'));
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(dir, 'icon-1024.png'), omitBackground: true });
  await b.close();
  console.log('icon rendered');
})();
