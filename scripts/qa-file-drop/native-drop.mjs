import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

const root = process.env.QA_FIXTURE;
const exec = promisify(execFile);
const control = (...args) => exec('xdotool',args);
const origin = 'http://127.0.0.1:5173';
const browsers = [];
const sockets = [];
async function eventually(name, check, timeout = 18_000) {
  const stop = Date.now() + timeout;
  let last;
  while (Date.now() < stop) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await delay(120);
  }
  throw new Error(name, {cause:last});
}
async function api(endpoint, options = {}) {
  const res = await fetch('http://127.0.0.1:3005/api' + endpoint, {
    method: options.method ?? 'GET',
    headers: {...(options.token ? {Authorization: 'Bearer ' + options.token} : {}), ...(options.body ? {'Content-Type':'application/json'} : {})},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(endpoint + ' ' + res.status + ' ' + JSON.stringify(body));
  return body;
}
async function browser(name, username, url) {
  const profile = root + '/' + name;
  await mkdir(profile, {recursive:true});
  const child = spawn(process.env.QA_CHROME, [
    '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--disable-background-networking', '--disable-component-update',
    '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-position=290,25', '--window-size=1180,820', '--ozone-platform=x11',
    'about:blank',
  ], { stdio:'ignore', env:{...process.env,HOME:root+'/home'} });
  browsers.push(child);
  const debug = await eventually('chrome endpoint', async () => {
    const port = (await readFile(profile + '/DevToolsActivePort', 'utf8')).split('\n')[0];
    const tabs = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    return tabs.find(t => t.type === 'page')?.webSocketDebuggerUrl;
  });
  const socket = new WebSocket(debug);
  sockets.push(socket);
  await new Promise((resolve,reject) => {
    socket.addEventListener('open', resolve, {once:true});
    socket.addEventListener('error', reject, {once:true});
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', ({data}) => {
    const reply = JSON.parse(data);
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    clearTimeout(request.timer);
    if (reply.error) request.reject(new Error(JSON.stringify(reply.error)));
    else request.resolve(reply.result);
  });
  const send = (method, params={}) => new Promise((resolve,reject) => {
    const currentId = ++id;
    const timer = setTimeout(() => reject(new Error(method)), 25000);
    pending.set(currentId,{resolve,reject,timer});
    socket.send(JSON.stringify({id:currentId,method,params}));
  });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? expression);
    return res.result.value;
  };
  const point = async (expression, fraction = 0.5) => evaluate(`(() => {
    const el = ${expression}; if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {x:r.x+r.width*${fraction},y:r.y+r.height*${fraction}};
  })()`);
  const click = async (expression, fraction = 0.5) => {
    let xy = await eventually('click ' + expression, () => point(expression,fraction));
    await send('Input.dispatchMouseEvent', {type:'mouseMoved',...xy});
    await delay(380);
    xy = await eventually('final click point ' + expression, () => point(expression,fraction));
    await send('Input.dispatchMouseEvent', {type:'mouseMoved',...xy});
    await send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...xy});
    await send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...xy});
  };
  const key = async (key, code, windowsVirtualKeyCode) => {
    await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode,...(key==='Enter'?{text:'\r',unmodifiedText:'\r'}:{})});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode});
  };
  console.log('navigating', name, url);
  const login = origin+'/login?redirect='+encodeURIComponent(new URL(url).pathname);
  await send('Runtime.evaluate',{expression:'setTimeout(() => location.href = '+JSON.stringify(login)+',0)'});
  await eventually('login inputs', () => evaluate("Boolean(document.querySelector('input[type=password]'))"));
  await evaluate("document.querySelector('input:not([type=password])').focus()");
  await send('Input.insertText',{text:username});
  await evaluate("document.querySelector('input[type=password]').focus()");
  await send('Input.insertText',{text:'isolated-QA-1664'});
  await click("document.querySelector('button[type=submit]')");
  await eventually('login completed', () => evaluate("location.pathname.startsWith('/channels/')"));
  return {send,evaluate,click,key,point};
}

async function watchDrag(page) {
  await page.evaluate(`void (() => {
    window.qaDrags = [];
    for (const type of ['dragenter','dragover','dragleave','drop','dragend']) {
      window.addEventListener(type, event => {
        const row = {
          type,
          trusted: event.isTrusted,
          types: [...(event.dataTransfer?.types ?? [])],
          fileNames: [...(event.dataTransfer?.files ?? [])].map(file => file.name),
          target: event.target?.tagName,
        };
        setTimeout(() => window.qaDrags.push({...row, prevented: event.defaultPrevented}),0);
      },true);
    }
  })()`);
}

async function appCoordinates(page, point) {
  const offset = await page.evaluate('({x:screenX,y:screenY+outerHeight-innerHeight})');
  return {x:Math.round(offset.x+point.x), y:Math.round(offset.y+point.y)};
}

async function pointer(point) {
  await control('mousemove','--sync',String(point.x),String(point.y));
}

const visible = page => page.evaluate("Boolean(document.querySelector('[data-testid=chat-drop-overlay]'))");
const dragLog = page => page.evaluate('window.qaDrags');

try {
  const alpha = await api('/auth/register',{method:'POST',body:{username:'ownerfixture',displayName:'Owner fixture',password:'isolated-QA-1664'}});
  const beta = await api('/auth/register',{method:'POST',body:{username:'readerfixture',displayName:'Reader fixture',password:'isolated-QA-1664'}});
  const space = await api('/spaces',{method:'POST',token:alpha.token,body:{name:'Native Drop Review'}});
  const invite = await api('/spaces/'+space.id+'/invite',{method:'POST',token:alpha.token,body:{}});
  await api('/spaces/'+space.id+'/join',{method:'POST',token:beta.token,body:invite});
  const detail = await api('/spaces/'+space.id,{token:alpha.token});
  const everyone = detail.roles.find(role=>role.id===space.id);
  const {pathToFileURL} = await import('node:url');
  const {PermissionBits} = await import(pathToFileURL(process.env.QA_WORKTREE+'/packages/shared/dist/permissions.js'));
  const readOnlyBits = BigInt(everyone.permissions) & ~PermissionBits.SEND_MESSAGES;
  await api('/spaces/'+space.id+'/roles/'+space.id,{method:'PATCH',token:alpha.token,body:{permissions:readOnlyBits.toString()}});
  const channels = await api('/spaces/'+space.id+'/channels',{token:alpha.token});
  const channel = channels.find(item=>item.type==='text');
  const url = origin+'/channels/'+space.id+'/'+channel.id;

  const selection = root+'/selection';
  const names = ['native-cancel.txt','native-history.txt','native-composer.txt'];
  for (const name of names) await writeFile(root+'/'+name,'X11 file drop fixture\n');
  await writeFile(selection,root+'/'+names[0]);
  const gtkLog = await import('node:fs').then(fs=>fs.openSync(root+'/gtk.log','w'));
  const gtk = spawn('/usr/bin/python3',[process.env.QA_SOURCE,selection],{stdio:['ignore',gtkLog,gtkLog]});
  browsers.push(gtk);

  const [gtkWindow] = (await eventually('Gtk source window',async()=>{
    const result=await control('search','--onlyvisible','--name','^Backspace QA native file source$');
    return result.stdout.trim() && result.stdout.trim().split('\n');
  })).map(Number);
  const geometry = (await control('getwindowgeometry','--shell',String(gtkWindow))).stdout;
  const gtkBounds = Object.fromEntries(geometry.trim().split('\n').map(line=>line.split('=')));
  const sourcePoint = {x:Number(gtkBounds.X)+80,y:Number(gtkBounds.Y)+65};
  assert.ok(sourcePoint.x<280,'GTK window overlaps the Chromium target');
  const outside = {x:1520,y:920};

  async function begin(name, target) {
    await writeFile(selection,root+'/'+name);
    await pointer(sourcePoint);
    await control('mousedown','1');
    await pointer({x:sourcePoint.x+35,y:sourcePoint.y+20});
    await delay(120);
    await pointer(target);
  }

  const owner = await browser('owner',alpha.user.username,url);
  await eventually('owner composer',()=>owner.evaluate("Boolean(document.querySelector('textarea'))"));
  const radioSilence = "[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Radio silence')";
  if (await owner.evaluate('Boolean('+radioSilence+')')) {
    await owner.click(radioSilence);
    await eventually('dismissal acknowledgment',()=>owner.evaluate("document.body.innerText.includes('Understood.')"));
    await owner.click("[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Close')");
    await eventually('prompt gone',()=>owner.evaluate("!document.body.innerText.includes('Understood.')"));
  }
  await watchDrag(owner);
  const pill = await owner.point("document.querySelector('textarea')");
  const history = {x:pill.x,y:pill.y-160};
  const historyScreen = await appCoordinates(owner,history);

  await begin(names[0],historyScreen);
  await eventually('real file drag enters history',()=>visible(owner));
  const beforeEscape = (await dragLog(owner)).length;
  await control('key','Escape');
  await control('mouseup','1');
  await delay(300);
  const escapeTrace = (await dragLog(owner)).slice(beforeEscape);
  console.log('Native Escape', JSON.stringify({overlay:await visible(owner),events:escapeTrace}));
  const nativeEscapePassed = !(await visible(owner));
  assert.ok(!escapeTrace.some(event=>event.type==='drop'),'Escape dispatched a drop');
  assert.ok(!await owner.evaluate("document.body.innerText.includes('native-cancel.txt')"),'cancelled file was staged');

  // Reload between independently measured cases. This does not count as passing
  // the Escape assertion above and allows the rest of the evidence to be gathered.
  await owner.send('Page.reload');
  await eventually('owner returned after reload',()=>owner.evaluate("Boolean(document.querySelector('textarea'))"));
  await watchDrag(owner);

  await begin(names[0],historyScreen);
  await eventually('second real file drag enters',()=>visible(owner));
  await pointer(outside);
  await eventually('leaving application removes overlay',async()=>!await visible(owner));
  await control('mouseup','1');
  console.log('Native window leave passed');

  for (const [name, point] of [[names[1],history],[names[2],pill]]) {
    await begin(name, await appCoordinates(owner,point));
    await eventually('overlay before '+name,()=>visible(owner));
    await control('mouseup','1');
    await eventually(name+' staged',()=>owner.evaluate(`document.body.innerText.includes(${JSON.stringify(name)})`));
    assert.equal(await visible(owner),false);
  }
  const drops = (await dragLog(owner)).filter(event=>event.type==='drop');
  assert.deepEqual(drops.map(event=>event.fileNames),[[names[1]],[names[2]]]);
  assert.ok(drops.every(event=>event.trusted && event.prevented));
  const files = await owner.evaluate("import('/src/stores/transferStore.ts').then(m=>[...m.useTransferStore.getState().transfers.values()].map(t=>t.file.name).sort())");
  assert.deepEqual(files, names.slice(1).sort());
  console.log('Native history and composer drops staged once each',JSON.stringify(drops));

  const reader = await browser('reader',beta.user.username,url);
  await eventually('reader view loaded',()=>reader.evaluate("document.body.innerText.includes('Native Drop Review')"));
  assert.equal(await reader.evaluate("Boolean(document.querySelector('textarea'))"),false);
  await watchDrag(reader);
  await begin(names[0],await appCoordinates(reader,history));
  await eventually('read-only receives native Files event',async()=>(await dragLog(reader)).some(event=>event.type==='dragover'&&event.types.includes('Files')));
  assert.equal(await visible(reader),false);
  assert.ok((await dragLog(reader)).filter(event=>event.type==='dragover').every(event=>!event.prevented));
  await control('key','Escape');
  await control('mouseup','1');
  console.log('Native read-only did not claim the drag');
  assert.equal(nativeEscapePassed,true,'Native Escape left the file-drop overlay visible');
} finally {
  await control('mouseup','1').catch(()=>{});
  for (const socket of sockets) socket.close();
  for (const process of browsers) process.kill();
}
