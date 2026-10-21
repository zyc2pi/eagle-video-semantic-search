/* Python 搜索服务生命周期：健康检查 + 自动拉起（detached，插件关闭不随之退出） */
const Service = (() => {
  const fs = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');

  let pending = null;
  const subscribers = new Set();
  function notify(state, message) {
    for (const listener of subscribers) { try { listener(state, message); } catch { /* UI 不影响生命周期 */ } }
  }

  function pythonExe(projectRoot) {
    return path.join(projectRoot, 'python', 'python.exe');
  }

  function validateProject(projectRoot) {
    if (!fs.existsSync(path.join(projectRoot, 'text_search.py'))) {
      return `项目路径无效：找不到 text_search.py（${projectRoot}）`;
    }
    if (!fs.existsSync(pythonExe(projectRoot))) {
      return `找不到便携 Python：${pythonExe(projectRoot)}`;
    }
    return null;
  }

  const LOG_MAX_BYTES = 10 * 1024 * 1024;

  function logPath() {
    return path.join(Config.pluginPath(), 'service.log');
  }

  function controlHeaders() {
    const cfg = Config.get();
    const port = cfg.port || 5006;
    try {
      const file = path.join(cfg.projectRoot, 'state', `search-control-${port}.json`);
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (record.version !== 1 || record.port !== port || !Number.isSafeInteger(record.pid)
        || typeof record.token !== 'string' || !/^[0-9a-f]{64}$/.test(record.token)) throw new Error();
      return { 'X-Eagle-Control-Token': record.token };
    } catch {
      // Do not echo file contents or secret values into UI/errors/logs.
      throw new Error('搜索服务控制凭据不可用，请确认项目路径并启动配套新版后端');
    }
  }

  function spawnService(projectRoot, onFailure) {
    const env = { ...process.env, PYTHONPATH: projectRoot, PYTHONUTF8: '1' };
    const key = (Config.get().deepseekKey || '').trim();
    if (key) env.DEEPSEEK_API_KEY = key; // AI 查询增强用（config.json 里的 profile 读此变量）

    // 服务输出落到日志文件（超过 10MB 时轮转清空），排障时设置页可直接打开
    let stdio = 'ignore';
    let fd = null;
    try {
      const lp = logPath();
      try {
        if (fs.existsSync(lp) && fs.statSync(lp).size > LOG_MAX_BYTES) fs.unlinkSync(lp);
      } catch { /* 日志被占用时跳过轮转 */ }
      fd = fs.openSync(lp, 'a');
      fs.writeSync(fd, `\n===== ${new Date().toISOString()} 启动服务 =====\n`);
      stdio = ['ignore', fd, fd];
    } catch { /* 日志不可写时退回丢弃输出 */ }

    // 端口跟随设置：text_search.py 已支持 --port（不传则 5006），改端口后自动拉起才能对上健康检查
    let child;
    try { child = spawn(pythonExe(projectRoot), ['text_search.py', '--port', String(Config.get().port || 5006)], {
      cwd: projectRoot,
      detached: true,
      windowsHide: true,
      stdio,
      env,
    }); } finally { if (fd !== null) fs.closeSync(fd); }
    child.once('error', () => onFailure('进程无法启动，请检查便携 Python 与文件权限'));
    child.once('exit', (code) => onFailure(`服务进程已退出（${code ?? '未知'}），请检查服务日志`));
    child.unref();
    return child;
  }

  /**
   * 确保服务可用。onStatus(state, message) 回调 UI：
   * state: 'online' | 'starting' | 'offline'
   */
  function ensure(onStatus = () => {}) {
    subscribers.add(onStatus);
    if (!pending) pending = connect().finally(() => { pending = null; subscribers.clear(); });
    return pending;
  }

  async function connect() {
    if (await Api.health()) {
      notify('online', '搜索服务已连接');
      return true;
    }

    const projectRoot = Config.get().projectRoot;
    const err = validateProject(projectRoot);
    if (err) {
      notify('offline', err);
      return false;
    }

    notify('starting', '正在启动搜索服务（首次需加载模型，约 10~30 秒）…');
    let failure = null;
    let fail;
    const failed = new Promise((resolve) => { fail = (message) => { failure = message; resolve(false); }; });
    try {
      spawnService(projectRoot, fail);
    } catch (e) {
      notify('offline', '启动服务失败，请检查 Python 路径与文件权限');
      return false;
    }

    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      let timer;
      await Promise.race([failed, new Promise((r) => { timer = setTimeout(r, 2000); })]);
      clearTimeout(timer);
      if (failure) { notify('offline', failure); return false; }
      if (await Promise.race([Api.health(), failed])) {
        notify('online', '搜索服务已连接');
        return true;
      }
      if (failure) { notify('offline', failure); return false; }
    }
    notify('offline', '服务启动超时（120 秒），请检查项目路径与端口设置');
    return false;
  }

  return { ensure, logPath, controlHeaders };
})();
