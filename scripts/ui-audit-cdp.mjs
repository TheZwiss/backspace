export async function connect(port = 9223, targetId = null) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(t => t.type === 'page' && (targetId ? t.id === targetId : t.url.startsWith('http://localhost:5175'))) ?? targets.find(t => t.type === 'page' && !targetId);
  if (!target) throw new Error(`No renderer on ${port}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, {once:true}); socket.addEventListener('error', reject, {once:true}); });
  let sequence = 0;
  const pending = new Map();
  const events = [];
  socket.addEventListener('message', ({data}) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      if (request) { clearTimeout(request.timer); pending.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); }
    } else events.push({ ...message, receivedAt: Date.now() });
  });
  const send = (method, params = {}) => new Promise((resolve,reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {pending.delete(id); reject(new Error(`CDP timeout: ${method}`));},30000);
    pending.set(id,{resolve,reject,timer}); socket.send(JSON.stringify({id,method,params}));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await send('Runtime.enable'); await send('Network.enable'); await send('Log.enable');
  return {send,evaluate,events,close:()=>socket.close()};
}

if (process.argv[2] === 'eval') {
  const session = await connect(Number(process.argv[3] ?? 9223));
  try { let input=''; for await(const chunk of process.stdin) input+=chunk; console.log(JSON.stringify(await session.evaluate(input),null,2)); } finally {session.close();}
}
