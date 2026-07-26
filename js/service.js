/* Python 搜索服务生命周期：健康检查 + 自动拉起（detached，插件关闭不随之退出） */
const Service = (() => {
  const fs = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');

  let starting = false;

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

  function spawnService(projectRoot) {
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

    const child = spawn(pythonExe(projectRoot), ['text_search.py'], {
      cwd: projectRoot,
      detached: true,
      windowsHide: true,
      stdio,
      env,
    });
    child.unref();
    if (fd !== null) fs.closeSync(fd); // 子进程持有自己的句柄副本
  }

  /**
   * 确保服务可用。onStatus(state, message) 回调 UI：
   * state: 'online' | 'starting' | 'offline'
   */
  async function ensure(onStatus) {
    if (await Api.health()) {
      onStatus('online', '搜索服务已连接');
      return true;
    }
    if (starting) return false;

    const projectRoot = Config.get().projectRoot;
    const err = validateProject(projectRoot);
    if (err) {
      onStatus('offline', err);
      return false;
    }

    starting = true;
    onStatus('starting', '正在启动搜索服务（首次需加载模型，约 10~30 秒）…');
    try {
      spawnService(projectRoot);
    } catch (e) {
      starting = false;
      onStatus('offline', `启动服务失败：${e.message}`);
      return false;
    }

    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      if (await Api.health()) {
        starting = false;
        onStatus('online', '搜索服务已连接');
        return true;
      }
    }
    starting = false;
    onStatus('offline', '服务启动超时（120 秒），请检查项目路径与端口设置');
    return false;
  }

  return { ensure, logPath };
})();
