/* Headless Chrome CDP smoke test: boot → Play → intro → start → hold → HUD/render check. */
'use strict';
const { spawn } = require('child_process');

const PORT = 9333, GAME = 'http://localhost:3125/';
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const chrome = spawn('google-chrome', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--enable-unsafe-swiftshader',
    '--remote-debugging-port=' + PORT, '--window-size=1280,800', 'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  try {
    let targets;
    for (let i = 0; i < 30; i++) {
      await sleep(400);
      try { targets = await (await fetch(`http://localhost:${PORT}/json`)).json(); break; } catch (e) {}
    }
    const page = targets.find(t => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);

    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params) => new Promise(res => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    await send('Page.enable');
    await send('Page.navigate', { url: GAME });
    await sleep(3500);

    const errors = [];
    // collect window errors
    await evalJs(`window.__errs=[];window.addEventListener('error',e=>window.__errs.push(String(e.message)));'ok'`);

    console.log('boot flags:', await evalJs(`JSON.stringify({
      three: !!window.THREE, rules: !!window.CBRules, render: window.CBRender.isAvailable(),
      titleVisible: !document.getElementById('screen-title').classList.contains('hidden')
    })`));

    // Play → intro → start
    await evalJs(`document.getElementById('btn-play').click(); 'ok'`);
    await sleep(300);
    console.log('intro open:', await evalJs(`!document.getElementById('overlay-intro').classList.contains('hidden')`));
    await evalJs(`document.getElementById('btn-intro-start').click(); 'ok'`);
    await sleep(2600); // countdown 3×700ms
    console.log('hud visible:', await evalJs(`!document.getElementById('hud').classList.contains('hidden')`));

    // hold for 2.5s via Space, then release
    await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:' ',bubbles:true})); 'ok'`);
    await sleep(2500);
    const mid = await evalJs(`JSON.stringify({
      score: document.getElementById('hud-score').textContent,
      depth: document.getElementById('hud-depth').textContent,
      mult: document.getElementById('hud-mult').textContent,
      hint: document.getElementById('hintbar').textContent
    })`);
    console.log('mid-dive HUD:', mid);
    await evalJs(`document.dispatchEvent(new KeyboardEvent('keyup',{key:' ',code:' ',bubbles:true})); 'ok'`);

    // canvas actually rendering? screenshot the page and check non-bg pixels
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const png = Buffer.from(shot.result.data, 'base64');
    require('fs').writeFileSync('/tmp/cb_play.png', png);
    console.log('gameplay screenshot bytes:', png.length);

    // pause / resume
    await evalJs(`document.getElementById('btn-hud-pause').click(); 'ok'`);
    await sleep(200);
    console.log('paused overlay:', await evalJs(`!document.getElementById('overlay-pause').classList.contains('hidden')`));
    await evalJs(`document.getElementById('btn-resume').click(); 'ok'`);
    await sleep(200);
    console.log('resumed:', await evalJs(`document.getElementById('overlay-pause').classList.contains('hidden')`));

    // finish the level quickly by holding
    await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:' ',bubbles:true})); 'ok'`);
    await sleep(9000);
    await evalJs(`document.dispatchEvent(new KeyboardEvent('keyup',{key:' ',code:' ',bubbles:true})); 'ok'`);
    await sleep(1500);
    console.log('results shown:', await evalJs(`!document.getElementById('overlay-results').classList.contains('hidden')`),
      await evalJs(`document.getElementById('res-headline').textContent`));
    console.log('page errors:', await evalJs(`JSON.stringify(window.__errs)`));
  } finally {
    if (ws) ws.close();
    chrome.kill();
  }
}
main().catch(e => { console.error('SMOKE FAIL:', e); process.exit(1); });
