const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
let server, browser, origin;
before(async () => {
  server = createServer((req, res) => {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://test').pathname);
    if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403).end(); return; }
    const target = file === root ? path.join(root, 'index.html') : file;
    fs.readFile(target, (error, body) => {
      if (error) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', target.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
      res.end(body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    headless: true, args: ['--no-sandbox']
  });
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function withPage(run, { fake = false, clock = false, viewport = { width: 1440, height: 1100 }, init } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    if (fake) await page.addInitScript(installFakes);
    if (init) await page.addInitScript(init);
    if (clock) {
      const now = new Date('2026-10-16T09:00:00Z');
      await page.clock.install({ time: now });
      await page.clock.pauseAt(now);
    }
    await page.goto(origin);
    await run(page);
    assert.deepEqual(errors, [], 'no uncaught browser exceptions');
  } finally {
    await context.close();
  }
}

// Test doubles expose observable I/O, never fake a real hardware readiness claim.
function installFakes() {
  window.__ai = { labels: ['손 펴기 🖐', '손 쥐기', '배경'], values: [.96, .02, .02], calls: 0, disposed: 0, loads: 0, fail: false, delay: false };
  window.tf = {};
  window.tmImage = {
    async load(modelURL, metadataURL) {
      const config = window.__ai;
      config.loads++;
      config.urls = [modelURL, metadataURL];
      if (config.fail) throw new Error('테스트 모델 연결 실패');
      const labels = [...config.labels];
      return {
        getClassLabels: () => labels,
        model: { dispose: () => { config.disposed++; } },
        dispose: () => { throw new Error('tmImage training-only dispose must not be used'); },
        async predict(element, flipped) {
          config.calls++;
          config.lastInput = [element.tagName, flipped];
          const values = [...config.values];
          if (config.delay) await new Promise(resolve => { config.resolve = resolve; });
          return labels.map((className, i) => ({ className, probability: values[i] }));
        }
      };
    }
  };
  window.__usb = { lines: [], opens: [], closed: 0, failWrite: false, cancel: false };
  const serial = new EventTarget();
  const port = new EventTarget();
  port.open = async options => {
    window.__usb.opens.push(options);
    port.writable = new WritableStream({
      write(data) {
        if (window.__usb.failWrite) throw new Error('disconnected');
        window.__usb.lines.push(new TextDecoder().decode(data));
      }
    });
  };
  port.close = async () => { window.__usb.closed++; };
  serial.requestPort = async () => {
    if (window.__usb.cancel) throw new DOMException('cancelled', 'NotFoundError');
    return port;
  };
  window.__usb.disconnect = () => {
    const event = new Event('disconnect');
    Object.defineProperty(event, 'port', { value: port });
    serial.dispatchEvent(event);
  };
  Object.defineProperty(navigator, 'serial', { value: serial, configurable: true });
  window.__media = { requests: 0, stopped: 0, fail: false };
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
    window.__media.requests++;
    if (window.__media.fail) throw new DOMException('denied', 'NotAllowedError');
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#729269'; ctx.fillRect(0, 0, 320, 240);
    const stream = canvas.captureStream(15);
    const interval = setInterval(() => ctx.fillRect(0, 0, 320, 240), 60);
    for (const track of stream.getTracks()) {
      const stop = track.stop.bind(track);
      track.stop = () => { window.__media.stopped++; clearInterval(interval); stop(); };
    }
    return stream;
  }});
}

async function duration(page, seconds) {
  await page.locator('#minutes').fill(String(Math.floor(seconds / 60)));
  await page.locator('#seconds').fill(String(seconds % 60));
  await page.locator('#apply-time').click();
}
async function loadModel(page) {
  await page.locator('#model-url').fill('https://models.example.test/gesture/');
  await page.locator('#load-model').click();
  await page.waitForFunction(() => document.getElementById('model-status').textContent.includes('개 클래스 연결 완료'));
  await page.locator('#start-class').selectOption('손 펴기 🖐');
  await page.locator('#pause-class').selectOption('손 쥐기');
  if (await page.locator('#notice').isVisible()) await page.locator('#dismiss-notice').click();
}
async function connect(page) {
  await page.locator('#serial-button').click();
  await page.waitForFunction(() => document.getElementById('serial-status').textContent.includes('연결됨'));
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM3sAAAAASUVORK5CYII=', 'base64');
async function upload(page) {
  await page.locator('#upload-tab').click();
  await page.locator('#image-file').setInputFiles({ name: 'hand.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => !document.getElementById('analyze-button').disabled);
}
async function flushWrites(page) {
  await page.evaluate(async () => { await state.writeQueue; });
}

test('manual countdown pauses, resumes, completes once and persists records safely', async () => {
  await withPage(async page => {
    await duration(page, 5);
    await page.locator('#task-name').fill('<img src=x onerror=alert(1)>');
    await page.locator('#timer-button').click();
    assert.equal(await page.locator('#minutes').isDisabled(), true);
    await page.clock.runFor(1000);
    assert.equal(await page.locator('#time-display').textContent(), '00:04');
    await page.locator('#timer-button').click();
    await page.clock.fastForward(10000);
    assert.equal(await page.locator('#time-display').textContent(), '00:04');
    await page.locator('#timer-button').click();
    await page.clock.runFor(4000);
    assert.equal(await page.locator('#timer-status').textContent(), '완료했어요!');
    assert.equal(await page.locator('#records li').count(), 1);
    assert.equal(await page.locator('#records img').count(), 0);
    assert.match(await page.locator('#records').textContent(), /<img src=x/);
    await page.clock.fastForward(10000);
    assert.equal(await page.locator('#records li').count(), 1);
    await page.locator('#reset-button').click();
    assert.equal(await page.locator('#time-display').textContent(), '00:05');
    await page.reload();
    assert.equal(await page.locator('#time-display').textContent(), '00:05');
    assert.equal(await page.locator('#timer-status').textContent(), '준비 완료');
    assert.equal(await page.locator('#today-count').textContent(), '1');
  }, { clock: true });
});

test('zero duration is rejected and changing duration resets paused state', async () => {
  await withPage(async page => {
    await duration(page, 0);
    assert.match(await page.locator('#notice').textContent(), /1초부터/);
    assert.equal(await page.locator('#time-display').textContent(), '05:00');
    await page.locator('#timer-button').click();
    await page.clock.runFor(2000);
    await page.locator('#timer-button').click();
    await page.locator('[data-minutes="3"]').click();
    assert.equal(await page.locator('#time-display').textContent(), '03:00');
    assert.equal(await page.locator('#timer-status').textContent(), '준비 완료');
  }, { clock: true });
});

test('demo is explicitly simulated, usable without AI, and does not invent confidence scores', async () => {
  await withPage(async page => {
    await page.locator('#demo-button').click();
    await page.locator('#demo-start').click();
    assert.equal(await page.locator('#timer-status').textContent(), '집중하는 중');
    assert.match(await page.locator('#prediction-result').textContent(), /체험/);
    assert.match(await page.locator('#preview-tag').textContent(), /실제 AI 인식 아님/);
    assert.deepEqual(await page.locator('.confidence').allTextContents(), ['—', '—', '—']);
    await page.locator('#demo-pause').click();
    assert.equal(await page.locator('#timer-status').textContent(), '잠시 쉬는 중');
    await page.locator('#demo-none').click();
    assert.equal(await page.locator('#timer-status').textContent(), '잠시 쉬는 중');
    await page.locator('#demo-button').click();
    assert.match(await page.locator('#ai-status').textContent(), /모델 연결 대기/);
  });
});

test('uploaded image requires a click, confidence gates actions, Unicode class is sent unchanged', async () => {
  await withPage(async page => {
    await loadModel(page); await connect(page); await upload(page);
    assert.equal(await page.evaluate(() => __ai.calls), 0);
    assert.deepEqual(await page.evaluate(() => __ai.urls), ['https://models.example.test/gesture/model.json', 'https://models.example.test/gesture/metadata.json']);
    await page.evaluate(() => { __ai.values = [.7, .2, .1]; });
    await page.locator('#analyze-button').click();
    await page.waitForFunction(() => document.getElementById('prediction-result').textContent.includes('기준 미달'));
    await flushWrites(page);
    assert.deepEqual(await page.evaluate(() => __usb.lines), ['@timer:ready\n']);
    assert.equal(await page.locator('#timer-status').textContent(), '준비 완료');
    await page.evaluate(() => { __ai.values = [.96, .02, .02]; });
    await page.locator('#analyze-button').click();
    await page.waitForFunction(() => document.getElementById('timer-status').textContent === '집중하는 중');
    await flushWrites(page);
    assert.deepEqual(await page.evaluate(() => __usb.lines), ['@timer:ready\n', '손 펴기 🖐\n', '@timer:running\n']);
    assert.deepEqual(await page.evaluate(() => __ai.lastInput), ['IMG', false]);
    assert.equal(await page.evaluate(() => __ai.calls), 2);
    await page.locator('#manual-buttons button').nth(1).click();
    await flushWrites(page);
    assert.equal(await page.evaluate(() => __usb.lines.at(-1)), '손 쥐기\n');
    assert.equal(await page.locator('#timer-status').textContent(), '집중하는 중', 'USB manual test must not manipulate web timer');
  }, { fake: true });
});

test('camera stabilizes classifications, suppresses repeated commands and releases on mode switch', async () => {
  await withPage(async page => {
    await loadModel(page); await connect(page);
    await page.locator('#camera-button').click();
    await page.waitForFunction(() => document.getElementById('preview-tag').textContent.includes('LIVE'));
    assert.equal(await page.locator('#timer-status').textContent(), '준비 완료', 'must wait for stable classification');
    await page.waitForFunction(() => document.getElementById('timer-status').textContent === '집중하는 중');
    const calls = await page.evaluate(() => __ai.calls);
    await page.waitForFunction(previous => __ai.calls >= previous + 12, calls);
    await flushWrites(page);
    assert.equal(await page.evaluate(() => __usb.lines.filter(line => line === '손 펴기 🖐\n').length), 1);
    await page.evaluate(() => { __ai.values = [.02, .96, .02]; });
    await page.waitForFunction(() => document.getElementById('timer-status').textContent === '잠시 쉬는 중');
    await page.locator('#upload-tab').click();
    assert.equal(await page.evaluate(() => __media.stopped), 1);
    assert.equal(await page.evaluate(() => document.getElementById('camera-video').srcObject), null);
    assert.equal(await page.locator('#camera-video').isVisible(), false);
  }, { fake: true });
});

test('camera permission denial is recoverable through image upload', async () => {
  await withPage(async page => {
    await loadModel(page);
    await page.evaluate(() => { __media.fail = true; });
    await page.locator('#camera-button').click();
    await page.waitForFunction(() => document.getElementById('notice').textContent.includes('권한이 거부'));
    assert.equal(await page.locator('#camera-button').isDisabled(), false);
    await upload(page);
    await page.locator('#analyze-button').click();
    await page.waitForFunction(() => document.getElementById('timer-status').textContent === '집중하는 중');
  }, { fake: true });
});

test('failed replacement retains previous model; successful replacement disposes underlying model', async () => {
  await withPage(async page => {
    await loadModel(page);
    await page.evaluate(() => { __ai.fail = true; });
    await page.locator('#load-model').click();
    await page.waitForFunction(() => document.getElementById('ai-status').textContent.includes('이전 모델 유지'));
    assert.equal(await page.locator('#camera-button').isDisabled(), false);
    assert.equal(await page.evaluate(() => __ai.disposed), 0);
    await page.evaluate(() => { __ai.fail = false; });
    await loadModel(page);
    assert.equal(await page.evaluate(() => __ai.disposed), 1);
    await page.locator('#pause-class').selectOption('손 펴기 🖐');
    assert.equal(await page.locator('#pause-class').inputValue(), '');
    assert.match(await page.locator('#notice').textContent(), /서로 다른 클래스/);
  }, { fake: true });
});

test('in-flight image result is discarded after model replacement and disposal waits for it', async () => {
  await withPage(async page => {
    await loadModel(page); await upload(page);
    await page.evaluate(() => { __ai.delay = true; });
    await page.locator('#analyze-button').click();
    await page.waitForFunction(() => typeof __ai.resolve === 'function');
    await loadModel(page);
    assert.equal(await page.evaluate(() => __ai.disposed), 0, 'do not dispose a model with pending prediction');
    await page.evaluate(() => { __ai.resolve(); });
    await page.waitForFunction(() => __ai.disposed === 1);
    assert.equal(await page.locator('#timer-status').textContent(), '준비 완료', 'stale prediction must not start timer');
  }, { fake: true });
});

test('invalid and corrupt uploads cannot execute an action', async () => {
  await withPage(async page => {
    await loadModel(page); await page.locator('#upload-tab').click();
    await page.locator('#image-file').setInputFiles({ name: 'fake.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
    assert.match(await page.locator('#notice').textContent(), /JPG, PNG 또는 WEBP/);
    assert.equal(await page.locator('#analyze-button').isDisabled(), true);
    await page.locator('#image-file').setInputFiles({ name: 'corrupt.png', mimeType: 'image/png', buffer: Buffer.from('not a real PNG') });
    await page.waitForFunction(() => document.getElementById('prediction-result').textContent.includes('읽기 실패'));
    assert.equal(await page.locator('#analyze-button').isDisabled(), true);
    assert.equal(await page.evaluate(() => __ai.calls), 0);
  }, { fake: true });
});

test('USB writes are queued, disconnect and write errors leave timer functional', async () => {
  await withPage(async page => {
    await connect(page);
    assert.deepEqual(await page.evaluate(() => __usb.opens), [{ baudRate: 115200 }]);
    await page.locator('#timer-button').click(); await flushWrites(page);
    assert.deepEqual(await page.evaluate(() => __usb.lines), ['@timer:ready\n', '@timer:running\n']);
    await page.evaluate(() => __usb.disconnect());
    await page.waitForFunction(() => document.getElementById('serial-status').textContent.includes('미연결'));
    assert.equal(await page.locator('#timer-status').textContent(), '집중하는 중');
    await connect(page);
    await page.evaluate(() => { __usb.failWrite = true; });
    await page.locator('#timer-button').click();
    await page.waitForFunction(() => document.getElementById('notice').textContent.includes('USB 전송에 실패'));
    assert.equal(await page.locator('#timer-status').textContent(), '잠시 쉬는 중');
    assert.equal(await page.locator('#manual-buttons button').first().isDisabled(), true);
    await page.locator('#timer-button').click();
    assert.equal(await page.locator('#timer-status').textContent(), '집중하는 중');
  }, { fake: true });
});

test('USB chooser cancellation and unsupported Web Serial are explained', async () => {
  await withPage(async page => {
    await page.evaluate(() => { __usb.cancel = true; });
    await page.locator('#serial-button').click();
    assert.match(await page.locator('#activity').textContent(), /장치 선택 취소/);
    assert.equal(await page.locator('#serial-button').isDisabled(), false);
    await page.evaluate(() => Object.defineProperty(navigator, 'serial', { value: undefined }));
    await page.locator('#serial-button').click();
    assert.match(await page.locator('#notice').textContent(), /Web Serial/);
  }, { fake: true });
});

test('tampered local data is ignored and mobile layout has no horizontal overflow', async () => {
  await withPage(async page => {
    assert.equal(await page.locator('#time-display').textContent(), '05:00');
    assert.equal(await page.locator('#records li').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#footer-guide').click();
    assert.equal(await page.locator('#guide-dialog').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#guide-dialog').isVisible(), false);
    await page.locator('#camera-tab').focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#upload-tab').getAttribute('aria-selected'), 'true');
    await page.screenshot({ path: '/tmp/touchless-mobile.png', fullPage: true });
  }, { viewport: { width: 390, height: 844 }, init: () => {
    localStorage.setItem('touchless-timer:v1', JSON.stringify({ duration: -100, threshold: 99, hold: -5, records: [{name:'broken', at:1e20, duration:1000}] }));
  }});
});

test('MakeCode command handling keeps unknown classes inert and completion blinks', () => {
  let onData, forever, message, baud, led = '', cleared = false;
  const context = {
    serial: { redirectToUSB() {}, setBaudRate(value) { baud = value; }, delimiters: () => '\n', onDataReceived(delimiter, handler) { onData = handler; }, readUntil: () => message },
    BaudRate: { BaudRate115200: 115200 }, Delimiters: { NewLine: '\n' }, IconNames: { SmallDiamond: 'ready', Yes: 'finished' },
    basic: { showLeds(value) { led = value; }, showIcon(icon) { led = icon; }, clearScreen() { cleared = true; }, forever(handler) { forever = handler; }, pause() {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'microbit-makecode.js'), 'utf8'), context);
  assert.equal(baud, 115200); assert.equal(led, 'ready');
  message = '펼친 손'; onData(); const running = led; assert.match(running, /# # #/);
  message = '주먹'; onData(); assert.notEqual(led, running); const paused = led;
  message = '기타·손 없음'; onData(); assert.equal(led, paused);
  message = '@timer:finished'; onData(); assert.equal(led, 'finished');
  forever(); assert.equal(cleared, true);
  forever(); assert.equal(led, 'finished');
  message = '@timer:ready'; onData(); assert.equal(led, 'ready');
});
