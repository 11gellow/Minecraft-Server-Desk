import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';

const exec = promisify(execFile);
const appDir = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.resolve(process.env.MC_PANEL_STATE_DIR || path.join(os.homedir(), '.local/state/minecraft-panel'));
const statePath = path.join(stateDir, 'settings.json');
const listenHost = process.env.MC_PANEL_BIND || '127.0.0.1';
const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', listenHost.toLowerCase(),
  ...(process.env.MC_PANEL_ALLOWED_HOSTS || '').toLowerCase().split(',').map(host => host.trim())]);
const socketName = 'mc-panel-' + createHash('sha256').update(stateDir).digest('hex').slice(0, 12);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const tmux = (...args) => exec('tmux', ['-L', socketName, '-f', path.join(appDir, 'tmux.conf'), ...args],
  { maxBuffer: 8 * 1024 * 1024 });
const isArgfile = entry => entry.endsWith('unix_args.txt');
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const ps = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const busy = new Map();
let mutating = false;
let changingPort = false;
let listener;

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
let state;
try {
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  state = { port: 51865, instances: [] };
}

async function save(next) {
  const temporary = path.join(stateDir, randomUUID() + '.tmp');
  try {
    await fs.writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temporary, statePath);
    state = next;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function updateState(change) {
  if (mutating) throw new RequestError('正在保存设置，请重试。', 409);
  mutating = true;
  try {
    return await change();
  } finally {
    mutating = false;
  }
}

function portNumber(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RequestError('端口必须是 1 到 65535 的整数。');
  }
  return port;
}

async function discover(directory, nested = true) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new RequestError('请输入服务器上的绝对路径。');
  }
  try {
    const { stdout } = await exec('python3', [path.join(appDir, 'discover.py'), directory, nested ? 'nested' : 'direct'],
      { timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    let message;
    try { message = JSON.parse(error.stdout || '{}').error; } catch {}
    throw new RequestError(message || '扫描失败，请检查目录与权限或选择更具体的路径。');
  }
}

function instance(id) {
  const found = state.instances.find(item => item.id === id);
  if (!found) throw new RequestError('实例不存在。', 404);
  return found;
}

const sessionName = item => 'instance-' + item.id;
const target = item => '=' + sessionName(item);
const paneTarget = item => sessionName(item) + ':0.0';

async function runningPane(item) {
  try {
    const { stdout } = await tmux('list-panes', '-t', target(item), '-F', '#{pane_id} #{pane_dead} #{pane_dead_status}');
    const [pane, dead, exit] = stdout.trim().split(' ');
    return { pane, active: dead === '0', exit: exit === '' || exit === undefined ? null : Number(exit) };
  } catch (error) {
    if (/no server running|failed to connect|can't find session|no such file/i.test(error.stderr || '')) return null;
    throw error;
  }
}

async function gameStatus(item) {
  const pane = await runningPane(item);
  const status = busy.get(item.id) || (pane?.active ? 'running' : pane?.exit ? 'failed' : 'stopped');
  return { ...item, status, exit: pane?.exit ?? null };
}

async function sendGameCommand(item, command) {
  const pane = await runningPane(item);
  if (!pane?.active) throw new RequestError('此实例当前未运行。', 409);
  await tmux('send-keys', '-t', pane.pane, '-l', '--', command, ';', 'send-keys', '-t', pane.pane, 'Enter');
}

async function stopGame(item) {
  if (!(await runningPane(item))?.active) return;
  await sendGameCommand(item, 'stop');
  const until = Date.now() + 90000;
  do {
    await delay(500);
    if (!(await runningPane(item))?.active) return;
  } while (Date.now() < until);
  throw new RequestError('已发送 stop，但游戏进程尚未退出。请检查实例控制台。', 409);
}

function assertPortAvailable(port, host) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen({ port, host: host || '::', exclusive: true }, () => probe.close(resolve));
  });
}

async function startGame(item) {
  const pane = await runningPane(item);
  if (pane?.active) return;
  const [profile] = await discover(item.dir, false);
  const candidate = profile.candidates.find(candidate => candidate.entry === item.entry);
  if (!candidate) throw new RequestError('找不到已保存的启动入口：' + item.entry + '。请重新扫描并选择。', 409);
  if (candidate.missing.length) throw new RequestError('缺少启动所需文件：' + candidate.missing.join('、'), 409);
  const java = item.java === 'java' ? 'java' : path.resolve(item.dir, item.java);
  try {
    await exec(java, ['-version'], { cwd: item.dir, timeout: 8000 });
  } catch {
    throw new RequestError('无法运行配置的 Java：' + item.java, 409);
  }
  if (item.prestart) {
    try { await fs.access(path.resolve(item.dir, item.prestart)); }
    catch { throw new RequestError('找不到前置脚本：' + item.prestart, 409); }
  }
  if (!profile.eula) throw new RequestError('请先阅读 Minecraft EULA，并在实例目录的 eula.txt 中明确确认后再启动。', 409);
  const port = portNumber(profile.port);
  try { await assertPortAvailable(port, profile.address); }
  catch (error) {
    throw new RequestError('无法绑定 Minecraft 游戏端口 ' + port + '（' + error.code + '）。', 409);
  }
  const args = [java];
  if (isArgfile(item.entry)) {
    const jvm = path.join(item.dir, 'user_jvm_args.txt');
    if (await fs.stat(jvm).then(file => file.isFile(), () => false)) args.push('@user_jvm_args.txt');
    args.push('@' + item.entry);
  } else {
    args.push('-jar', './' + item.entry);
  }
  args.push('nogui');

  if (pane) await tmux('kill-session', '-t', target(item));
  const game = 'exec ' + args.map(shellQuote).join(' ');
  const launch = item.prestart ? 'bash ' + shellQuote(path.resolve(item.dir, item.prestart)) + ' && ' + game : game;
  await tmux('new-session', '-d', '-s', sessionName(item), '-c', item.dir, 'bash', '-c', launch);
}

async function gameAction(item, action) {
  if (busy.size || mutating) throw new RequestError('已有实例正在执行启停操作，请稍后重试。', 409);
  busy.set(item.id, action === 'start' ? 'starting' : action === 'stop' ? 'stopping' : 'restarting');
  try {
    if (action !== 'start') await stopGame(item);
    if (action !== 'stop') await startGame(item);
  } finally {
    busy.delete(item.id);
  }
  return await gameStatus(item);
}

async function browse(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new RequestError('请输入绝对路径。');
  try {
    const dir = await fs.realpath(directory);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return { dir, parent: path.dirname(dir), directories: entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .filter(entry => !entry.name.startsWith('.')).map(entry => ({ name: entry.name, dir: path.join(dir, entry.name) }))
      .sort((left, right) => left.name.localeCompare(right.name)) };
  } catch {
    throw new RequestError('无法浏览该目录，请检查路径或权限。');
  }
}

async function readBody(req) {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) throw new RequestError('请求过大。', 413);
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid');
    return body;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError('请求内容格式错误。');
  }
}

function sendJson(res, data, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function isAllowed(req, requireOrigin = false) {
  try {
    const host = new URL('http://' + req.headers.host);
    if (!allowedHosts.has(host.hostname)) return false;
    if (!req.headers.origin) return !requireOrigin;
    const origin = new URL(req.headers.origin);
    return ['http:', 'https:'].includes(origin.protocol)
      && origin.host === new URL(origin.protocol + '//' + req.headers.host).host;
  } catch {
    return false;
  }
}

const assets = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/favicon.svg', ['public/favicon.svg', 'image/svg+xml']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
  ['/vendor/xterm.js', ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8']],
  ['/vendor/xterm.css', ['node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8']],
  ['/vendor/fit.js', ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8']]
]);

async function handle(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  if (!isAllowed(req)) throw new RequestError('访问地址或来源未获允许。', 403);
  if (req.method !== 'GET' && req.headers['x-mc-panel'] !== '1') throw new RequestError('请求来源校验失败。', 403);
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (req.method === 'GET' && assets.has(pathname)) {
    const [file, mime] = assets.get(pathname);
    const content = await fs.readFile(path.join(appDir, file));
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/state') {
    const serverDir = path.join(os.homedir(), 'mc-servers');
    const home = await fs.access(serverDir).then(() => serverDir, () => os.homedir());
    return sendJson(res, { port: state.port, bind: listenHost, home, instances: await Promise.all(state.instances.map(gameStatus)) });
  }
  if (req.method === 'GET' && pathname === '/api/directories') return sendJson(res, await browse(url.searchParams.get('dir')));
  if (req.method === 'POST' && pathname === '/api/discover') {
    const body = await readBody(req);
    return sendJson(res, await discover(body.dir));
  }
  if (req.method === 'POST' && pathname === '/api/instances') {
    const body = await readBody(req);
    return await updateState(async () => {
      const [profile] = await discover(body.dir, false);
      const selected = profile.candidates.find(candidate => candidate.entry === body.entry);
      if (!selected) throw new RequestError('请选择可识别的服务端入口。');
      const original = body.id ? instance(body.id) : null;
      if (original && (busy.has(original.id) || (await runningPane(original))?.active)) {
        throw new RequestError('请先停止实例，再修改启动设置。', 409);
      }
      if (state.instances.some(item => item.id !== original?.id && item.dir === profile.dir)) {
        throw new RequestError('该目录已导入。', 409);
      }
      const item = {
        id: original?.id || randomUUID(), dir: profile.dir,
        name: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : profile.name,
        entry: selected.entry, kind: selected.kind, version: selected.version || '', loaderVersion: selected.loaderVersion || '',
        java: typeof body.java === 'string' && body.java.trim() ? body.java.trim() : profile.java,
        prestart: typeof body.prestart === 'string' ? body.prestart.trim() : ''
      };
      await save({ ...state, instances: original ? state.instances.map(existing => existing.id === item.id ? item : existing) : [...state.instances, item] });
      return sendJson(res, await gameStatus(item));
    });
  }
  if (req.method === 'POST' && pathname === '/api/settings') {
    const body = await readBody(req);
    const port = portNumber(body.port);
    if (port === state.port) return sendJson(res, { port });
    if (changingPort) throw new RequestError('正在修改端口，请稍后重试。', 409);
    changingPort = true;
    try {
      return await updateState(async () => {
        let next;
        try { next = await bind(port); }
        catch (error) { throw new RequestError('面板无法监听端口 ' + port + '（' + error.code + '）。', 409); }
        try { await save({ ...state, port }); }
        catch (error) { next.close(); throw error; }
        const previous = listener;
        listener = next;
        res.once('finish', () => {
          previous.close();
          for (const client of ps.clients) if (client.httpListener === previous) client.close(1012, 'Port changed');
        });
        return sendJson(res, { port });
      });
    } finally { changingPort = false; }
  }
  const route = /^\/api\/instances\/([^/]+)\/(start|stop|restart|console|command)$/.exec(pathname);
  if (route) {
    const item = instance(route[1]);
    const action = route[2];
    if (action === 'console' && req.method === 'GET') {
      const pane = await runningPane(item);
      const output = pane ? (await tmux('capture-pane', '-p', '-J', '-S', '-1500', '-t', paneTarget(item))).stdout : '';
      return sendJson(res, { output, status: await gameStatus(item) });
    }
    if (action === 'command' && req.method === 'POST') {
      const { command } = await readBody(req);
      if (typeof command !== 'string' || !command.trim() || command.length > 2000 || /[\u0000-\u001f\u007f]/.test(command)) {
        throw new RequestError('请输入单行游戏命令。');
      }
      if (busy.has(item.id)) throw new RequestError('实例正在执行启停操作。', 409);
      await sendGameCommand(item, command.trim().replace(/^\//, ''));
      return sendJson(res, { sent: true });
    }
    if (req.method === 'POST' && ['start', 'stop', 'restart'].includes(action)) return sendJson(res, await gameAction(item, action));
  }
  throw new RequestError('找不到该页面或操作。', 404);
}

function bind(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handle(req, res).catch(error => {
        if (!(error instanceof RequestError)) console.error(error);
        if (!res.headersSent) sendJson(res, { error: error instanceof RequestError ? error.message : '面板执行失败，请查看服务日志。' }, error.status || 500);
        else res.end();
      });
    });
    server.on('upgrade', (req, connection, head) => {
      if (req.url !== '/api/terminal' || !isAllowed(req, true) || ps.clients.size >= 4) {
        connection.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      ps.handleUpgrade(req, connection, head, socket => {
        socket.httpListener = server;
        ps.emit('connection', socket);
      });
    });
    server.once('error', reject);
    server.listen(port, listenHost, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

ps.on('connection', socket => {
  const terminal = spawn('python3', [path.join(appDir, 'terminal.py')], { cwd: os.homedir() });
  terminal.on('error', () => socket.close(1011, 'Could not start terminal'));
  terminal.stdin.on('error', () => socket.close());
  terminal.stdout.on('data', data => {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > 1024 * 1024) socket.close(1008, 'Terminal output overloaded');
    else socket.send(data);
  });
  terminal.stderr.on('data', data => console.error(data.toString()));
  terminal.on('exit', () => socket.close());
  socket.on('close', () => terminal.stdin.end());
  socket.on('error', () => terminal.stdin.end());
  socket.on('message', bytes => {
    try {
      const event = JSON.parse(bytes);
      if (event.type === 'input' && typeof event.data === 'string') {
        event.data = Buffer.from(event.data).toString('base64');
      } else if (event.type !== 'resize' || ![event.cols, event.rows].every(value => Number.isInteger(value) && value > 0 && value <= 1000)) {
        return;
      }
      if (!terminal.stdin.destroyed && !terminal.stdin.writableEnded) {
        terminal.stdin.write(JSON.stringify(event) + '\n');
      }
    } catch {}
  });
});

listener = await bind(portNumber(state.port));
console.log('Minecraft 面板已监听 http://' + listenHost + ':' + state.port);
process.on('SIGTERM', () => {
  for (const client of ps.clients) client.terminate();
  listener.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
