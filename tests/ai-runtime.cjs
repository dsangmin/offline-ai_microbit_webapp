// Real TensorFlow.js + tmImage integration, using a synthetic constant classifier.
// This checks the inference plumbing, NOT recognition accuracy of a trained model.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const scripts = [
  'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@1.3.1/dist/tf.min.js',
  'https://cdn.jsdelivr.net/npm/@teachablemachine/image@0.8.5/dist/teachablemachine-image.min.js'
];

(async () => {
  // curl uses the environment's trusted CA configuration. We never turn off TLS
  // verification. Route those exact verified bytes into the test browser, whose
  // independent CA store may not include the cloud's HTTPS proxy certificate.
  const libraries = new Map(scripts.map(url => [url, execFileSync('curl', [
    '--fail', '--silent', '--show-error', '--location', '--max-time', '40', url
  ], { maxBuffer: 8 * 1024 * 1024 })]));
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'));
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
      headless: true, args: ['--no-sandbox']
    });
    const context = await browser.newContext();
    await context.route('https://cdn.jsdelivr.net/**', route => {
      const body = libraries.get(route.request().url());
      return body ? route.fulfill({ body, contentType: 'application/javascript' }) : route.abort();
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const builder = await context.newPage();
    await builder.goto(origin);
    for (const url of scripts) await builder.addScriptTag({ url });
    const fixtures = {};
    for (const [name, bias] of [['start', [8, 0, 0]], ['pause', [0, 8, 0]]]) {
      const artifacts = await builder.evaluate(async bias => {
        tf.setBackend('cpu');
        const model = tf.sequential();
        model.add(tf.layers.globalAveragePooling2d({ inputShape: [224, 224, 3] }));
        model.add(tf.layers.dense({ units: 3, activation: 'softmax', kernelInitializer: 'zeros', biasInitializer: 'zeros' }));
        const weights = [tf.zeros([3, 3]), tf.tensor1d(bias)];
        model.setWeights(weights); weights.forEach(weight => weight.dispose());
        let exported;
        await model.save(tf.io.withSaveHandler(async artifact => {
          exported = { topology: artifact.modelTopology, weights: artifact.weightSpecs, bytes: Array.from(new Uint8Array(artifact.weightData)) };
          return { modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: 'JSON' } };
        }));
        model.dispose(); return exported;
      }, bias);
      fixtures[name] = {
        'model.json': JSON.stringify({ modelTopology: artifacts.topology, format: 'layers-model', generatedBy: 'TensorFlow.js 1.3.1 test fixture', weightsManifest: [{ paths: ['weights.bin'], weights: artifacts.weights }] }),
        'metadata.json': JSON.stringify({ tfjsVersion: '1.3.1', tmVersion: '2.4.10', packageVersion: '0.8.5', packageName: '@teachablemachine/image', labels: ['펼친 손', '주먹', '기타·손 없음'], imageSize: 224, grayscale: false }),
        'weights.bin': Buffer.from(artifacts.bytes)
      };
    }
    await builder.close();
    await context.route('https://model-fixture.example/**', route => {
      const [, name, file] = new URL(route.request().url()).pathname.split('/');
      const body = fixtures[name]?.[file];
      return body ? route.fulfill({ body, contentType: file.endsWith('.json') ? 'application/json' : 'application/octet-stream', headers: { 'Access-Control-Allow-Origin': '*' } }) : route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM3sAAAAASUVORK5CYII=', 'base64');
    for (const [name, expected] of [['start', '집중하는 중'], ['pause', '잠시 쉬는 중']]) {
      await page.locator('#model-url').fill('https://model-fixture.example/' + name + '/');
      await page.locator('#load-model').click();
      await page.waitForFunction(() => document.getElementById('model-status').textContent.includes('3개 클래스 연결 완료'));
      await page.locator('#upload-tab').click();
      if (name === 'start') await page.locator('#image-file').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: png });
      await page.waitForFunction(() => !document.getElementById('analyze-button').disabled);
      await page.locator('#analyze-button').click();
      await page.waitForFunction(expected => document.getElementById('timer-status').textContent === expected, expected);
      assert.match(await page.locator('#prediction-result').textContent(), /100%/);
      console.log('PASS real tmImage model load + image inference:', name, '→', expected);
    }
    assert.deepEqual(errors, []);
    console.log('PASS real model replacement / disposal without browser exceptions');
    console.log('Synthetic classifier only; real gesture accuracy and physical micro:bit remain unverified.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
