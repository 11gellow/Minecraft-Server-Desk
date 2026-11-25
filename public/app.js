'use strict';

const el = id => document.getElementById(id);
const statuses = { stopped: '已停止', running: '运行中', failed: '启动失败', starting: '启动中', stopping: '停止中', restarting: '重启中' };
const kinds = { jar: 'Java 服务端', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };
const activeActions = new Map();
let appState = { instances: [] };
let view = '';
let selectedId;
let editingId;
let browseState;
let timer;
let pollBusy;
let previousCards = '';
let ws;
let terminal;
let fit;
let resize;
let options = [];

async function api(url, body) {
  const response = await fetch(url, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MC-Panel': '1' },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败。');
  return result;
}

function notice(message, isError = false) {
  const target = el('notice');
  target.textContent = message;
  target.hidden = false;
  target.classList.toggle('error', isError);
  clearTimeout(timer);
  timer = setTimeout(() => { target.hidden = true; }, isError ? 8000 : 3800);
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function describe(current) {
  return [kinds[current.kind] || current.kind, current.version, current.loaderVersion].filter(Boolean).join(' · ');
}

function currentStatus(item) {
  return activeActions.get(item.id) || item.status;
}

function render() {
  const items = appState.instances;
  if (!items.some(item => item.id === selectedId)) selectedId = items[0]?.id;
  const selected = items.find(item => item.id === selectedId);
  el('instance-count').textContent = items.length ? items.length + ' 个实例' : '还没有服务端，添加一个服务器目录开始。';
  const signature = JSON.stringify([items, selectedId, [...activeActions]]);
  if (signature !== previousCards) {
    previousCards = signature;
    el('instances').replaceChildren(...items.map(item => {
      const status = currentStatus(item);
      const card = node('article', '', 'instance-card' + (item.id === selectedId ? ' selected' : ''));
      const header = node('div', '', 'top');
      const select = node('button', item.name, 'title');
      select.setAttribute('aria-pressed', String(item.id === selectedId));
      select.onclick = () => {
        selectedId = item.id;
        el('console-output').textContent = '';
        render();
        void refreshConsole();
      };
      header.append(select, node('span', statuses[status], 'status ' + status));
      const buttons = node('div', '', 'actions');
      for (const [action, label] of [['start', '启动'], ['stop', '停止'], ['restart', '重启']]) {
        const button = node('button', label, action === 'start' ? 'primary' : '');
        const idle = !['starting', 'stopping', 'restarting'].includes(status) && activeActions.size === 0;
        button.disabled = !idle || (action === 'start' ? status === 'running' : status !== 'running');
        button.onclick = () => void perform(item, action);
        buttons.append(button);
      }
      card.append(header, node('p', describe(item)), buttons);
      return card;
    }));
  }
  el('instance-detail').hidden = !selected;
  if (selected) {
    const status = currentStatus(selected);
    el('detail-name').textContent = selected.name;
    el('detail-path').textContent = selected.dir;
    el('console-status').textContent = statuses[status];
    el('console-status').className = 'status ' + status;
    el('send-command').disabled = status !== 'running';
    el('edit').disabled = !['stopped', 'failed'].includes(status);
  }
  el('bind-address').textContent = appState.bind || '';
  if (document.activeElement !== el('port') && !el('port').dataset.dirty) el('port').value = appState.port || '';
}

async function refresh() {
  appState = await api('/api/state');
  render();
}

async function refreshConsole() {
  const id = selectedId;
  if (view !== 'instances' || !id) return;
  const result = await api('/api/instances/' + id + '/console');
  if (selectedId !== id) return;
  const box = el('console-output');
  const output = result.output.trimEnd();
  if (box.textContent !== output) {
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 35;
    box.textContent = output;
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
}

async function poll() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    await refresh();
    await refreshConsole();
  } catch (error) {
    if (!appState.bind) notice(error.message, true);
  } finally { pollBusy = false; }
}

async function perform(item, action) {
  activeActions.set(item.id, { start: 'starting', stop: 'stopping', restart: 'restarting' }[action]);
  selectedId = item.id;
  render();
  try {
    const result = await api('/api/instances/' + item.id + '/' + action, {});
    notice('“' + item.name + '”' + (action === 'stop' ? '已停止。' : '的启动操作已提交。'), result.status === 'failed');
  } catch (error) {
    notice(error.message, true);
  } finally {
    activeActions.delete(item.id);
    await poll();
  }
}

el('command-form').onsubmit = async event => {
  event.preventDefault();
  const id = selectedId;
  const input = el('command');
  if (!input.value.trim()) return;
  try {
    await api('/api/instances/' + id + '/command', { command: input.value });
    input.value = '';
    input.focus();
    await refreshConsole();
  } catch (error) { notice(error.message, true); }
};

async function browse(dir) {
  try {
    browseState = await api('/api/directories?dir=' + encodeURIComponent(dir));
    el('current-directory').textContent = browseState.dir;
    el('up-directory').disabled = browseState.parent === browseState.dir;
    el('directories').replaceChildren(...browseState.directories.map(item => {
      const button = node('button', '›  ' + item.name);
      button.onclick = () => void browse(item.dir);
      return button;
    }));
    el('browser').hidden = false;
  } catch (error) {
    el('scan-message').textContent = error.message;
  }
}

function selectedOption() {
  return options[Number(el('entry').value)];
}

function setCandidate() {
  const current = selectedOption();
  if (!current) return;
  const { profile, candidate } = current;
  const editing = appState.instances.find(item => item.id === editingId);
  el('name').value = editing?.name || profile.name;
  el('java').value = editing?.java || profile.java;
  el('prestart').value = editing?.prestart || '';
  const notes = [profile.dir];
  if (candidate.missing.length) notes.push('缺少必要文件：' + candidate.missing.join('、'));
  if (!profile.eula) notes.push('开服前请在实例目录确认 Minecraft EULA。');
  el('entry-note').textContent = notes.join(' · ');
}

async function scan() {
  el('import-form').hidden = true;
  el('scan-message').textContent = '正在扫描目录…';
  el('scan').disabled = true;
  try {
    const profiles = await api('/api/discover', { dir: el('import-path').value.trim() });
    options = profiles.flatMap(profile => profile.candidates.map(candidate => ({ profile, candidate })));
    if (!options.length) {
      el('scan-message').textContent = '未找到可识别的启动入口。请选择含有服务端 JAR 或加载器启动参数的目录。';
      return;
    }
    el('entry').replaceChildren(...options.map(({ profile, candidate }, index) => {
      const option = node('option', profile.name + ' / ' + candidate.entry + ' · ' + describe(candidate));
      option.value = String(index);
      return option;
    }));
    const existing = appState.instances.find(item => item.id === editingId);
    const matching = options.findIndex(({ profile, candidate }) => existing?.dir === profile.dir && existing.entry === candidate.entry);
    if (matching >= 0) el('entry').value = String(matching);
    else if (options.length > 1) {
      const prompt = node('option', '请选择启动入口');
      prompt.value = '';
      prompt.disabled = true;
      el('entry').prepend(prompt);
      el('entry').value = '';
    }
    el('scan-message').textContent = options.length > 1 ? '找到多个启动入口，请确认要用的版本。' : '';
    if (el('entry').value !== '') setCandidate();
    el('import-form').hidden = false;
  } catch (error) {
    el('scan-message').textContent = error.message;
  } finally { el('scan').disabled = false; }
}

function openImport(item) {
  editingId = item?.id;
  options = [];
  el('import-title').textContent = item ? '启动配置' : '添加实例';
  el('import-path').value = item?.dir || '';
  el('import-path').disabled = Boolean(item);
  el('browse').hidden = Boolean(item);
  el('scan-message').textContent = '';
  el('entry-note').textContent = '';
  el('browser').hidden = true;
  el('import-form').hidden = true;
  el('import-dialog').showModal();
  if (item) void scan();
}

el('add').onclick = () => openImport();
el('edit').onclick = () => openImport(appState.instances.find(item => item.id === selectedId));
el('close-import').onclick = () => el('import-dialog').close();
el('browse').onclick = () => void browse(el('import-path').value.trim() || appState.home);
el('up-directory').onclick = () => void browse(browseState.parent);
el('take-directory').onclick = () => {
  el('import-path').value = browseState.dir;
  el('browser').hidden = true;
  void scan();
};
el('scan').onclick = () => void scan();
el('import-path').oninput = () => { el('import-form').hidden = true; };
el('entry').onchange = setCandidate;
el('import-form').onsubmit = async event => {
  event.preventDefault();
  if (el('entry').value === '') return;
  const { profile, candidate } = selectedOption();
  try {
    const item = await api('/api/instances', { id: editingId, dir: profile.dir, entry: candidate.entry,
      name: el('name').value, java: el('java').value, prestart: el('prestart').value });
    selectedId = item.id;
    el('console-output').textContent = '';
    el('import-dialog').close();
    await poll();
    notice('已保存实例。');
  } catch (error) { el('scan-message').textContent = error.message; }
};

el('port').oninput = () => { el('port').dataset.dirty = 'yes'; };
el('settings-form').onsubmit = async event => {
  event.preventDefault();
  const port = Number(el('port').value);
  try {
    const previous = appState.port;
    const result = await api('/api/settings', { port });
    delete el('port').dataset.dirty;
    if (previous === result.port) return notice('端口设置已保存。');
    const direct = Number(location.port) === Number(previous);
    if (direct) {
      const next = new URL(location.href);
      next.port = String(result.port);
      const link = node('a', '使用新端口打开面板');
      link.href = next.href;
      el('settings-note').replaceChildren(link);
    } else {
      el('settings-note').textContent = '新端口已保存。请更新现有的转发配置，再重新打开面板。';
    }
    notice('面板已切换到端口 ' + result.port + '。');
  } catch (error) { notice(error.message, true); }
};

function connectTerminal() {
  if (ws && ws.readyState < 2) return ws.close();
  if (!terminal) {
    terminal = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000,
      theme: { background: '#0e1511', foreground: '#d6ebde', cursor: '#a7ebbd' } });
    fit = new FitAddon.FitAddon();
    terminal.loadAddon(fit);
    terminal.open(el('terminal'));
    terminal.onData(data => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'input', data })); });
    terminal.onResize(({ cols, rows }) => {
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });
    resize = new ResizeObserver(() => { if (view === 'terminal') fit.fit(); });
    resize.observe(el('terminal'));
  }
  fit.fit();
  terminal.focus();
  const url = new URL('/api/terminal', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  el('terminal-status').textContent = '正在连接…';
  el('connect-terminal').textContent = '断开连接';
  ws.onopen = () => {
    el('terminal-status').textContent = '已连接';
    ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
  };
  ws.onmessage = event => terminal.write(new Uint8Array(event.data));
  ws.onclose = () => {
    el('terminal-status').textContent = '连接已关闭';
    el('connect-terminal').textContent = '连接终端';
  };
  ws.onerror = () => notice('终端连接失败。请确认当前访问方式支持 WebSocket。', true);
}

el('connect-terminal').onclick = connectTerminal;

function navigate() {
  const requested = location.hash.slice(1);
  view = ['instances', 'terminal', 'settings'].includes(requested) ? requested : 'instances';
  for (const name of ['instances', 'terminal', 'settings']) el(name + '-view').hidden = name !== view;
  for (const link of document.querySelectorAll('nav [data-view]')) {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (view === 'terminal') {
    if (!terminal) connectTerminal();
    else if (fit) fit.fit();
  }
  void poll();
}

window.addEventListener('hashchange', navigate);
navigate();
setInterval(poll, 1500);
